import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'node:fs/promises';
import { uploadFilePath } from '@/lib/storage/upload';
import { ACCEPTED_MIME, MAX_BYTES } from '@/lib/storage/constants';

export const runtime = 'nodejs';

async function fileFor(params: Promise<{ path: string[] }>) {
  const { path } = await params;
  return { storagePath: path.join('/'), file: uploadFilePath(path.join('/')) };
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { storagePath, file } = await fileFor(params);
    const mime = req.headers.get('content-type') ?? '';
    const ext = storagePath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    if (!(mime in ACCEPTED_MIME) || mime !== ext) {
      return NextResponse.json({ error: 'Video type does not match upload path' }, { status: 415 });
    }
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      return NextResponse.json({ error: 'Video must be between 1 byte and 50 MB' }, { status: 413 });
    }
    await writeFile(file, bytes, { flag: 'wx' });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message = (error as Error).message;
    return NextResponse.json({ error: message.includes('EEXIST') ? 'Upload already exists' : message }, {
      status: message.includes('invalid storage path') ? 400 : message.includes('EEXIST') ? 409 : 500,
    });
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { storagePath, file } = await fileFor(params);
    const bytes = await readFile(file);
    return new NextResponse(bytes, {
      headers: {
        'content-type': storagePath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=3600',
        'content-disposition': 'inline',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }
}
