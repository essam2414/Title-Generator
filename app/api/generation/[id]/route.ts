import { NextRequest, NextResponse } from 'next/server';
import { db, json } from '@/lib/db/client';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/passcode';
import { displayTitles } from '@/lib/generation/constants';
import type { GeneratedTitle } from '@/lib/providers/types';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value ?? '');
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 });
  }

  const row = db().prepare(`SELECT g.id,g.generated_titles,g.vision_description,g.cost_usd,g.duration_ms,
    g.completed_at,a.storage_path FROM generations g JOIN generation_attempts a ON a.id=g.id WHERE g.id=?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const storagePath = String(row.storage_path ?? '');
  const signedUrl = storagePath ? `/api/uploads/${storagePath}` : null;

  return NextResponse.json({
    id: row.id,
    titles: displayTitles(json(row.generated_titles, [] as GeneratedTitle[])),
    visionDescription: json(row.vision_description, null),
    storagePath,
    signedUrl,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    createdAt: row.completed_at,
  });
}
