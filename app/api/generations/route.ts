import { NextRequest, NextResponse } from 'next/server';
import { db, json } from '@/lib/db/client';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/passcode';
import { displayTitles } from '@/lib/generation/constants';
import type { GeneratedTitle } from '@/lib/providers/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value ?? '');
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Join generations with their original attempts to get the storage_path.
  // generations.id is intentionally shared with generation_attempts.id.
  const rows = db().prepare(`SELECT g.id,g.completed_at,g.generated_titles,g.vision_description,a.storage_path
    FROM generations g JOIN generation_attempts a ON a.id=g.id ORDER BY g.completed_at DESC LIMIT 12`)
    .all() as Array<Record<string, unknown>>;

  const items = rows.map((row) => {
    const titles = json<GeneratedTitle[]>(row.generated_titles, []);
    const vision = json<{ scene?: string } | null>(row.vision_description, null);
    return {
      id: String(row.id),
      createdAt: String(row.completed_at),
      storagePath: String(row.storage_path ?? ''),
      // Sorted, not raw index 0: rows written before the ranking change are in
      // model-emission order, where titles[0] means "first emitted", not "best".
      topTitle: displayTitles(titles)[0]?.text ?? '',
      sceneSummary: (vision?.scene ?? '').slice(0, 120),
    };
  });

  return NextResponse.json({ items });
}
