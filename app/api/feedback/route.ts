import { NextRequest, NextResponse } from 'next/server';
import { db, json } from '@/lib/db/client';
import { embed } from '@/lib/providers/openai/embedding';
import { prunableIds, LIKED_CAP_PER_CREATOR } from '@/lib/feedback/rules';
import { displayTitles } from '@/lib/generation/constants';

export const runtime = 'nodejs';

type Body = { generation_id?: unknown; title_index?: unknown; vote?: unknown };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.generation_id !== 'string' ||
    typeof body.title_index !== 'number' ||
    !Number.isInteger(body.title_index) ||
    body.title_index < 0 ||
    body.title_index > 99
  ) {
    return NextResponse.json({ error: 'generation_id (uuid), title_index (int) required' }, { status: 400 });
  }
  if (body.vote !== -1 && body.vote !== 1) {
    return NextResponse.json({ error: 'vote must be -1 or 1' }, { status: 400 });
  }

  const database = db();
  database.prepare(`INSERT INTO title_feedback(generation_id,title_index,vote) VALUES(?,?,?)
    ON CONFLICT(generation_id,title_index) DO UPDATE SET vote=excluded.vote,created_at=datetime('now')`)
    .run(body.generation_id, body.title_index, body.vote);

  if (body.vote === 1) {
    // Best-effort. A like that fails to index is a missed voice signal, not a
    // lost vote: the ledger row above already stands, and a thumbs-up must not
    // If indexing a liked title fails, keep the saved feedback vote and log the issue.
    try {
      const gen = database.prepare(`SELECT g.vision_description,g.generated_titles,a.creator_handle,a.niche_id
        FROM generations g JOIN generation_attempts a ON a.id=g.id WHERE g.id=?`).get(body.generation_id) as
        Record<string, unknown> | undefined;
      if (!gen) throw new Error('generation not found');
      const attempt = { creator_handle: gen.creator_handle as string | null, niche_id: String(gen.niche_id) };
      // The client only ever saw displayTitles(...) — sorted and sliced to 5 —
      // so title_index is an index into THAT list, not the raw 10-wide stored
      // array. Rows written before the ranking change landed are stored in
      // model-emission order, where the two orders diverge.
      const titles = displayTitles(
        json(gen.generated_titles, [] as Array<{
          text: string;
          hookFamily: string;
          templateSimilarityPrior: number;
        }>),
      );
      const picked = titles[body.title_index];
      const vision = json(gen.vision_description, { scene: '', visualHook: '' });
      if (!picked || !attempt?.creator_handle) throw new Error('missing title or creator_handle');

      // MUST match lib/generation/orchestrator.ts byte for byte, or these
      // vectors land in a different space from corpus_titles.description_embedding.
      const text = `${vision.scene} ${vision.visualHook}`.slice(0, 8000);
      const { vector } = await embed(text);

      database.prepare(`INSERT INTO liked_titles(id,generation_id,title_index,creator_handle,niche_id,title,
        hook_family,visual_description,description_embedding) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(generation_id,title_index) DO UPDATE SET creator_handle=excluded.creator_handle,
        niche_id=excluded.niche_id,title=excluded.title,hook_family=excluded.hook_family,
        visual_description=excluded.visual_description,description_embedding=excluded.description_embedding,
        created_at=datetime('now')`).run(crypto.randomUUID(), body.generation_id, body.title_index,
        attempt.creator_handle, attempt.niche_id, picked.text, picked.hookFamily, text, JSON.stringify(vector));

      const existing = database.prepare('SELECT id,created_at FROM liked_titles WHERE creator_handle=? ORDER BY created_at DESC')
        .all(attempt.creator_handle) as Array<{ id: string; created_at: string }>;
      const victims = prunableIds(existing, LIKED_CAP_PER_CREATOR);
      if (victims.length) {
        const del = database.prepare('DELETE FROM liked_titles WHERE id=?');
        for (const id of victims) del.run(id);
      }
    } catch (e) {
      console.warn(`feedback: like not indexed: ${(e as Error).message}`);
    }
  } else {
    // A flip from like to dislike must retract the earlier like, or
    // liked_titles keeps injecting a title into future prompts as
    // creator-approved after the ledger has recorded it as rejected. Same
    // best-effort contract as the like path: this must not error the response.
    try {
      database.prepare('DELETE FROM liked_titles WHERE generation_id=? AND title_index=?')
        .run(body.generation_id, body.title_index);
    } catch (e) {
      console.warn(`feedback: like retraction failed: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ ok: true });
}
