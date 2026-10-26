import 'server-only';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let cached: DatabaseSync | null = null;

export type CorpusRow = {
  id: string;
  title: string;
  hook_family: string;
  performance_score: number | null;
  view_outlier_score: number | null;
  creator_handle: string | null;
  visual_description: string | null;
  embedding: number[];
  similarity: number;
};

export function db(): DatabaseSync {
  if (cached) return cached;
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(path.join(dataDir, 'app.sqlite'));
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS niches (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, style_brief TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS corpus_titles (
      id TEXT PRIMARY KEY, niche_id TEXT NOT NULL REFERENCES niches(id), title TEXT NOT NULL,
      hook_family TEXT NOT NULL, performance_score REAL, view_outlier_score REAL,
      creator_handle TEXT, visual_description TEXT, title_template TEXT, source_url TEXT,
      source_platform TEXT, embedding TEXT, description_embedding TEXT,
      scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS corpus_niche_idx ON corpus_titles(niche_id);
    CREATE TABLE IF NOT EXISTS creator_style_fingerprints (
      creator_handle TEXT PRIMARY KEY, best_titles TEXT NOT NULL DEFAULT '[]', voice_notes TEXT,
      niche_id TEXT NOT NULL REFERENCES niches(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS generation_attempts (
      id TEXT PRIMARY KEY, client_request_id TEXT NOT NULL, storage_path TEXT NOT NULL,
      niche_id TEXT NOT NULL REFERENCES niches(id), vision_provider TEXT NOT NULL,
      generation_provider TEXT NOT NULL, passcode_session_hash TEXT NOT NULL,
      creator_handle TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')),
      failed_at TEXT, failure_stage TEXT, failure_message TEXT
    );
    CREATE INDEX IF NOT EXISTS attempts_session_idx ON generation_attempts(passcode_session_hash, started_at);
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY REFERENCES generation_attempts(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL UNIQUE, vision_description TEXT NOT NULL,
      retrieved_corpus_ids TEXT NOT NULL, generated_titles TEXT NOT NULL, cost_usd REAL NOT NULL,
      tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS generations_completed_idx ON generations(completed_at DESC);
    CREATE TABLE IF NOT EXISTS title_feedback (
      generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      title_index INTEGER NOT NULL, vote INTEGER NOT NULL CHECK(vote IN (-1, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(generation_id, title_index)
    );
    CREATE TABLE IF NOT EXISTS liked_titles (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      title_index INTEGER NOT NULL, creator_handle TEXT NOT NULL, niche_id TEXT NOT NULL REFERENCES niches(id),
      title TEXT NOT NULL, hook_family TEXT NOT NULL, visual_description TEXT NOT NULL,
      description_embedding TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(generation_id, title_index)
    );
    CREATE INDEX IF NOT EXISTS liked_creator_idx ON liked_titles(creator_handle, created_at DESC);
  `);
  database.prepare(`INSERT OR IGNORE INTO niches(id, display_name, style_brief)
    VALUES (?, ?, ?)`)
    .run('luxury-menswear', 'Luxury Menswear', 'Create short, natural social video titles for luxury menswear. Keep the tone confident, understated, and specific to what is visible.');
  cached = database;
  return database;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function vector(value: unknown): number[] {
  return parseJson<number[]>(value, []);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : -1;
}

export function retrieveCorpus(nicheId: string, query: number[], limit: number): CorpusRow[] {
  const rows = db().prepare(`SELECT id,title,hook_family,performance_score,view_outlier_score,
    creator_handle,visual_description,embedding,description_embedding FROM corpus_titles
    WHERE niche_id=? AND description_embedding IS NOT NULL AND embedding IS NOT NULL`).all(nicheId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...(r as unknown as Omit<CorpusRow, 'embedding' | 'similarity'>),
    embedding: vector(r.embedding),
    similarity: cosineSimilarity(query, vector(r.description_embedding)),
  })).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

export function retrieveLiked(creatorHandle: string, query: number[], limit: number) {
  const rows = db().prepare(`SELECT title,hook_family,visual_description,description_embedding
    FROM liked_titles WHERE creator_handle=?`).all(creatorHandle) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    title: String(r.title), hook_family: String(r.hook_family), visual_description: String(r.visual_description),
    similarity: cosineSimilarity(query, vector(r.description_embedding)),
  })).sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

export function json<T>(value: unknown, fallback: T): T { return parseJson(value, fallback); }
