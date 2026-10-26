import { NextRequest, NextResponse } from 'next/server';
import { db, json } from '@/lib/db/client';
import { uploadFilePath } from '@/lib/storage/upload';
import { readFile } from 'node:fs/promises';
import { SESSION_COOKIE, verifySession, sessionHash } from '@/lib/auth/passcode';
import { runPipeline, PipelineError, type PipelineResult } from '@/lib/generation/orchestrator';
import { displayTitles } from '@/lib/generation/constants';
import { sanitizeAvoidTitles } from '@/lib/feedback/rules';
import type { ProviderId } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RATE_LIMIT_PER_DAY = 20;

type Body = {
  client_request_id?: unknown;
  storage_path?: unknown;
  niche_id?: unknown;
  creator_handle?: unknown;
  vision_provider?: unknown;
  generation_provider?: unknown;
  steering?: unknown;
  avoid_titles?: unknown;
};

export async function POST(req: NextRequest) {
  const sessionToken = req.cookies.get(SESSION_COOKIE)?.value ?? '';
  const session = await verifySession(sessionToken);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sessHash = await sessionHash(sessionToken);

  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.client_request_id !== 'string' ||
    typeof body.storage_path !== 'string' ||
    typeof body.niche_id !== 'string'
  ) {
    return NextResponse.json(
      { error: 'client_request_id, storage_path, niche_id required' },
      { status: 400 },
    );
  }
  const visionProvider: ProviderId = (body.vision_provider as ProviderId) ?? 'anthropic';
  const generationProvider: ProviderId = (body.generation_provider as ProviderId) ?? 'anthropic';
  const creatorHandle = typeof body.creator_handle === 'string' ? body.creator_handle : null;
  const steering = typeof body.steering === 'string' && body.steering.trim().length > 0 ? body.steering : undefined;

  // Idempotency: if a generation already exists for this client_request_id, return it.
  const database = db();
  const existing = database.prepare(`SELECT id,generated_titles,vision_description,cost_usd,duration_ms
    FROM generations WHERE client_request_id=?`).get(body.client_request_id) as Record<string, unknown> | undefined;
  if (existing) {
    return NextResponse.json({
      id: existing.id,
      titles: displayTitles(json(existing.generated_titles, [] as PipelineResult['titles'])),
      visionDescription: json(existing.vision_description, null),
      storagePath: body.storage_path,
      costUsd: existing.cost_usd,
      durationMs: existing.duration_ms,
      idempotent: true,
    });
  }

  // Rate limit on session attempts (success or failure) in last 24h.
  const rate = database.prepare(`SELECT COUNT(*) AS count FROM generation_attempts
    WHERE passcode_session_hash=? AND started_at >= datetime('now','-1 day')`).get(sessHash) as { count: number };
  if (rate.count >= RATE_LIMIT_PER_DAY) {
    return NextResponse.json({ error: 'rate limit: 20 generations per 24h' }, { status: 429 });
  }

  // Look up niche + fingerprint.
  const niche = database.prepare('SELECT id,style_brief FROM niches WHERE id=?').get(body.niche_id) as
    { id: string; style_brief: string } | undefined;
  if (!niche) return NextResponse.json({ error: `unknown niche_id: ${body.niche_id}` }, { status: 400 });

  let styleFingerprint: string[] = [];
  if (creatorHandle) {
    const fp = database.prepare('SELECT best_titles FROM creator_style_fingerprints WHERE creator_handle=?')
      .get(creatorHandle) as { best_titles: string } | undefined;
    if (fp) styleFingerprint = json(fp.best_titles, [] as string[]);
  }

  // Log the attempt BEFORE doing real work. Generations row only on success.
  const attemptId = crypto.randomUUID();
  database.prepare(`INSERT INTO generation_attempts
    (id,client_request_id,storage_path,niche_id,vision_provider,generation_provider,passcode_session_hash,creator_handle)
    VALUES (?,?,?,?,?,?,?,?)`).run(attemptId, body.client_request_id, body.storage_path, body.niche_id,
    visionProvider, generationProvider, sessHash, creatorHandle);
  let videoBytes: Buffer;
  try {
    videoBytes = await readFile(uploadFilePath(body.storage_path));
  } catch {
    await markFailure(attemptId, 'persist', 'uploaded video not found');
    return NextResponse.json({ error: 'Uploaded video not found. Please upload it again.' }, { status: 400 });
  }

  let result: PipelineResult;
  try {
    result = await runPipeline({
      videoBytes,
      nicheId: niche.id,
      styleBrief: niche.style_brief,
      styleFingerprint,
      visionProviderId: visionProvider,
      generationProviderId: generationProvider,
      steering,
      creatorHandle: creatorHandle ?? '',
      avoidTitles: sanitizeAvoidTitles(body.avoid_titles),
    });
  } catch (e) {
    const err = e as PipelineError | Error;
    const stage = err instanceof PipelineError ? err.stage : 'generate';
    await markFailure(attemptId, stage, err.message);
    return NextResponse.json({ error: `${stage}: ${err.message}` }, { status: 500 });
  }

  database.prepare(`INSERT INTO generations
    (id,client_request_id,vision_description,retrieved_corpus_ids,generated_titles,cost_usd,tokens_in,tokens_out,duration_ms)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(attemptId, body.client_request_id, JSON.stringify(result.visionDescription),
    JSON.stringify(result.retrievedCorpusIds), JSON.stringify(result.titles), result.costUsd,
    result.tokensIn, result.tokensOut, result.durationMs);

  return NextResponse.json({
    id: attemptId,
    titles: displayTitles(result.titles),
    visionDescription: result.visionDescription,
    storagePath: body.storage_path,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  });
}

async function markFailure(attemptId: string, stage: string, message: string): Promise<void> {
  db().prepare(`UPDATE generation_attempts SET failed_at=?,failure_stage=?,failure_message=? WHERE id=?`)
    .run(new Date().toISOString(), stage, message.slice(0, 2000), attemptId);
}
