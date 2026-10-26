// Deliverable 2 — import the scraped dataset into corpus_titles.
//
// Usage:
//   npm run import:dataset                  # dry run: classify + report, no writes
//   npm run import:dataset -- --apply       # writes
//   npm run import:dataset -- --limit 5     # first N rows, for a cheap smoke test
//
// Must run via the npm script, which carries `--conditions=react-server`:
// lib/providers/openai/embedding.ts is marked `server-only`. Reusing the app's
// own embedding module rather than calling OpenAI directly is deliberate — the
// corpus vectors have to come from the same model, dimensions and code path as
// the query vector the app builds at upload time, or retrieval compares two
// subtly different spaces. That mismatch is the exact bug migration 0003 fixes.
//
// Requires migration 0003 to have been applied.

import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { parseCsv } from './lib/csv';
import { HOOK_FAMILIES, HOOK_TAXONOMY, isHookFamily, type HookFamily } from '../lib/hooks/taxonomy';
import { db } from '../lib/db/client';

const CSV_PATH = path.join(process.cwd(), 'datasets', 'william-wade-titles.csv');
// Keyed by video_url, not video_id: merge-dataset.ts assigns video_id as a
// sequential counter, so it shifts for every row whenever the corpus grows.
const CACHE_PATH = path.join(process.cwd(), 'datasets', 'raw', '_hook-families.json');

const CLASSIFY_MODEL = 'claude-sonnet-4-6';
const CLASSIFY_BATCH = 25;
const EMBED_BATCH = 100;
// 1536 floats serialise to ~30KB of JSON, and each row carries two vectors.
// Keep batches bounded so imports use predictable memory.
const INSERT_BATCH = 100;

type Cached = { hook_family: HookFamily; confidence: string; title: string };
type Row = Record<string, string>;

function parseArgs(argv: string[]) {
  let apply = false;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--limit') limit = parseInt(argv[++i], 10);
  }
  return { apply, limit };
}

// An empty cell means "no reading", never zero. A zero performance_score would
// rank a genuinely unmeasured title at the bottom of the corpus and teach the
// model that its phrasing failed.
function num(s: string | undefined): number | null {
  const t = (s ?? '').trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------- classify

function classifyPrompt(batch: Row[]): string {
  const families = HOOK_FAMILIES.map((id) => {
    const m = HOOK_TAXONOMY[id];
    return `- ${id} (${m.displayName})\n    structure: ${m.template}\n    example:   ${m.example}`;
  }).join('\n');

  const items = batch
    .map(
      (r) =>
        `id: ${r.video_url}\ntitle: ${r.burned_in_title}\ncontext: ${r.visual_description.slice(0, 220)}`,
    )
    .join('\n\n');

  return `Label each short-form video hook title with the ONE hook family that best matches the title's STRUCTURE.

Families:
${families}

Rules:
- Judge the structure of the TITLE, not the subject matter of the video.
- "context" is a description of the video, given only to disambiguate an
  ambiguous title. Never label based on the context alone.
- Every title gets exactly one family. Pick the closest even when the fit is
  imperfect.
- confidence: "high" when the title clearly matches the family's structure,
  "low" when you are forcing a fit.

Return ONLY a JSON array, one object per input, in the same order:
[{"id": "<the id given>", "hook_family": "<one of the ids above>", "confidence": "high|low"}]

Inputs:

${items}`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error(`no JSON array in response: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1));
}

async function classifyBatch(client: Anthropic, batch: Row[]): Promise<Map<string, Cached>> {
  const res = await client.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: classifyPrompt(batch) }],
  });
  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  const parsed = extractJson(text) as Array<{ id?: string; hook_family?: string; confidence?: string }>;

  const out = new Map<string, Cached>();
  for (const item of parsed) {
    if (!item?.id || !item.hook_family) continue;
    // A family the taxonomy does not know is dropped here rather than stored:
    // search.ts filters unknown families out of retrieval silently, so an
    // invented label would quietly shrink every result set instead of failing.
    if (!isHookFamily(item.hook_family)) continue;
    const row = batch.find((r) => r.video_url === item.id);
    if (!row) continue;
    out.set(item.id, {
      hook_family: item.hook_family,
      confidence: item.confidence === 'low' ? 'low' : 'high',
      title: row.burned_in_title,
    });
  }
  return out;
}

async function loadCache(): Promise<Record<string, Cached>> {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH, 'utf8')) as Record<string, Cached>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`could not read ${CACHE_PATH}: ${(e as Error).message}`);
  }
}

async function classifyAll(rows: Row[]): Promise<Record<string, Cached>> {
  const cache = await loadCache();
  // Re-classify when the title behind a URL changed — the cached label
  // describes a line that no longer exists.
  const todo = rows.filter((r) => cache[r.video_url]?.title !== r.burned_in_title);

  if (todo.length === 0) {
    console.log(`hook families: all ${rows.length} cached`);
    return cache;
  }

  console.log(`hook families: ${rows.length - todo.length} cached, classifying ${todo.length}`);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  for (let i = 0; i < todo.length; i += CLASSIFY_BATCH) {
    const batch = todo.slice(i, i + CLASSIFY_BATCH);
    let got = new Map<string, Cached>();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        got = await classifyBatch(client, batch);
        if (got.size === batch.length) break;
        console.log(`  batch ${i / CLASSIFY_BATCH + 1}: got ${got.size}/${batch.length}, retrying`);
      } catch (e) {
        console.log(`  batch ${i / CLASSIFY_BATCH + 1} attempt ${attempt}: ${(e as Error).message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
    for (const [k, v] of got) cache[k] = v;
    console.log(`  ${Math.min(i + CLASSIFY_BATCH, todo.length)}/${todo.length}`);
    // Persist after every batch so an interrupted run never re-pays for work
    // it already did.
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  }
  return cache;
}

// ---------------------------------------------------------------- sqlite

function tallyByNiche(): Record<string, number> {
  const rows = db().prepare('SELECT niche_id,COUNT(*) AS count FROM corpus_titles GROUP BY niche_id')
    .all() as Array<{ niche_id: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.niche_id, row.count]));
}

// ---------------------------------------------------------------- main

async function main() {
  loadEnvLocal();
  requireEnv(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  const { apply, limit } = parseArgs(process.argv.slice(2));

  const all = parseCsv(await fs.readFile(CSV_PATH, 'utf8'));
  const rows = Number.isFinite(limit) ? all.slice(0, limit) : all;
  console.log(`${all.length} rows in CSV${rows.length !== all.length ? `, using ${rows.length}` : ''}\n`);

  // --- validate -----------------------------------------------------------
  const niches = [...new Set(rows.map((r) => r.niche))];
  if (niches.length !== 1) throw new Error(`expected one niche, found: ${niches.join(', ')}`);
  const nicheId = niches[0];

  const bad = rows.filter((r) => !r.burned_in_title.trim() || !r.visual_description.trim());
  if (bad.length > 0) {
    throw new Error(`${bad.length} rows missing a title or visual_description — refusing to import`);
  }

  // --- hook families ------------------------------------------------------
  const cache = await classifyAll(rows);
  const unlabelled = rows.filter((r) => !cache[r.video_url]);
  if (unlabelled.length > 0) {
    // hook_family is NOT NULL with an FK, so these rows cannot be inserted.
    // Failing here beats inserting a default nobody chose.
    throw new Error(
      `${unlabelled.length} rows could not be classified. First: ${unlabelled[0].burned_in_title}`,
    );
  }

  const tally: Record<string, number> = {};
  for (const r of rows) tally[cache[r.video_url].hook_family] = (tally[cache[r.video_url].hook_family] ?? 0) + 1;
  console.log('\nhook families:');
  for (const [f, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(22)}${n}`);
  }
  const lowConf = rows.filter((r) => cache[r.video_url].confidence === 'low');
  console.log(`  (${lowConf.length} forced fits flagged low-confidence)`);

  // --- embed --------------------------------------------------------------
  const embedding = await import('../lib/providers/openai/embedding').catch((e: Error) => {
    throw new Error(
      `Could not load the embedding module: ${e.message}\n` +
        `Run via \`npm run import:dataset\` — it carries --conditions=react-server, ` +
        `which the 'server-only' import requires.`,
    );
  });

  console.log(`\nembedding ${rows.length} titles and ${rows.length} descriptions…`);
  let embedCost = 0;
  const titleVecs: number[][] = [];
  const descVecs: number[][] = [];
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const slice = rows.slice(i, i + EMBED_BATCH);
    const [t, d] = await Promise.all([
      embedding.embedMany(slice.map((r) => r.burned_in_title)),
      embedding.embedMany(slice.map((r) => r.visual_description)),
    ]);
    t.forEach((x) => { titleVecs.push(x.vector); embedCost += x.costUsd; });
    d.forEach((x) => { descVecs.push(x.vector); embedCost += x.costUsd; });
    console.log(`  ${Math.min(i + EMBED_BATCH, rows.length)}/${rows.length}`);
  }
  console.log(`embedding cost: $${embedCost.toFixed(4)}`);

  // --- build payload ------------------------------------------------------
  const payload = rows.map((r, i) => ({
    niche_id: nicheId,
    title: r.burned_in_title,
    hook_family: cache[r.video_url].hook_family,
    performance_score: num(r.performance_score),
    share_rate_estimate: num(r.share_rate),
    view_outlier_score: num(r.view_outlier_score),
    visual_description: r.visual_description,
    title_template: r.title_template.trim() || null,
    creator_handle: r.creator_handle,
    source_url: r.video_url,
    source_platform: r.platform,
    embedding: titleVecs[i],
    description_embedding: descVecs[i],
  }));

  const unscored = payload.filter((p) => p.performance_score === null).length;

  const before = tallyByNiche();
  const existingTotal = Object.values(before).reduce((a, b) => a + b, 0);
  console.log('\ncurrently in the local SQLite database:');
  for (const [n, c] of Object.entries(before).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.padEnd(20)}${c}`);
  }
  console.log(`about to insert ${payload.length} rows (${unscored} with performance_score NULL)`);

  if (!apply) {
    console.log(`\ndry run: nothing written. Re-run with --apply.`);
    console.log(`--apply would DELETE all ${existingTotal} existing rows, then insert ${payload.length}.`);
    return;
  }

  // --- write --------------------------------------------------------------
  // Full replace of corpus_titles, every niche.
  //
  // Two reasons, and both matter:
  //  1. Everything currently in the table is hand-invented seed data with
  //     guessed metrics (seed/corpus.mjs). The generator must only ever see
  //     real scraped titles, so invented rows are deleted rather than left
  //     sitting behind a WHERE clause that today happens to exclude them.
  //  2. performance_score is a percentile, which is corpus-relative. Appending
  //     would mix scores computed over different corpora into one ranking.
  //     Replace-in-full is the only correct update.
  //
  // Recoverable: re-running this script rebuilds the table from the CSV.
  console.log(`\ndeleting all ${existingTotal} existing rows…`);
  const database = db();
  database.prepare('INSERT OR IGNORE INTO niches(id,display_name,style_brief) VALUES(?,?,?)')
    .run(nicheId, nicheId, 'Generate concise short-form video titles for the ' + nicheId + ' niche.');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec('DELETE FROM corpus_titles');
    const insert = database.prepare('INSERT INTO corpus_titles(id,niche_id,title,hook_family,performance_score,share_rate_estimate,view_outlier_score,visual_description,title_template,creator_handle,source_url,source_platform,embedding,description_embedding) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < payload.length; i += INSERT_BATCH) {
      for (const row of payload.slice(i, i + INSERT_BATCH)) {
        insert.run(crypto.randomUUID(), row.niche_id, row.title, row.hook_family, row.performance_score,
          row.share_rate_estimate, row.view_outlier_score, row.visual_description, row.title_template,
          row.creator_handle, row.source_url, row.source_platform, JSON.stringify(row.embedding),
          JSON.stringify(row.description_embedding));
      }
      console.log('  inserted ' + Math.min(i + INSERT_BATCH, payload.length) + '/' + payload.length);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  // --- verify -------------------------------------------------------------
  const final = (database.prepare('SELECT COUNT(*) AS count FROM corpus_titles WHERE niche_id=?').get(nicheId) as { count: number }).count;
  const withDesc = final;

  const after = tallyByNiche();
  const afterTotal = Object.values(after).reduce((a, b) => a + b, 0);

  console.log(`\ndone. ${final} rows in ${nicheId}, ${withDesc} with a description_embedding.`);
  console.log('corpus_titles now holds:');
  for (const [n, c] of Object.entries(after)) console.log(`  ${n.padEnd(20)}${c}`);
  if (afterTotal !== final) {
    console.log(`⚠ ${afterTotal - final} rows outside "${nicheId}" survived the purge — invented seed data may remain.`);
  }
  if (final !== payload.length) {
    console.log(`⚠ expected ${payload.length} rows, found ${final}.`);
  }
  if (withDesc !== final) {
    console.log(`⚠ ${final - withDesc} rows have no description_embedding — they are invisible to retrieval.`);
  }
  if (lowConf.length > 0) {
    console.log(`\n${lowConf.length} titles were forced into a family with low confidence:`);
    lowConf.slice(0, 10).forEach((r) => console.log(`  [${cache[r.video_url].hook_family}] ${r.burned_in_title}`));
    if (lowConf.length > 10) console.log(`  …and ${lowConf.length - 10} more`);
  }
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
