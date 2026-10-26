import 'server-only';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACCEPTED_MIME, type AcceptedMime } from './constants';

export type SignedUpload = { storagePath: string; signedUrl: string; token: string };

export function createSignedUpload(mime: AcceptedMime): SignedUpload {
  const ext = ACCEPTED_MIME[mime];
  const day = new Date().toISOString().slice(0, 10);
  const storagePath = `${day}/${crypto.randomUUID()}.${ext}`;
  return { storagePath, signedUrl: `/api/uploads/${storagePath}`, token: '' };
}

export function uploadFilePath(storagePath: string): string {
  if (!/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(mp4|mov)$/i.test(storagePath)) {
    throw new Error('invalid storage path');
  }
  const root = resolve(process.env.DATA_DIR || join(process.cwd(), 'data'), 'uploads');
  const file = resolve(root, storagePath);
  if (!file.startsWith(`${root}/`) && !file.startsWith(`${root}\\`)) throw new Error('invalid storage path');
  mkdirSync(join(file, '..'), { recursive: true });
  return file;
}
