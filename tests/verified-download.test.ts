import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadVerifiedFile } from '../src/ai/verified-download';

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-codez-verified-download-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fakeFetch(bytes: Uint8Array): typeof fetch {
  return async () => new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

test('downloadVerifiedFile commits only content matching size and SHA-256', async () => {
  await withTempDir(async (root) => {
    const bytes = new TextEncoder().encode('verified-local-model');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const destination = path.join(root, 'model.gguf');
    const progress: number[] = [];

    const result = await downloadVerifiedFile({
      url: 'https://example.test/model.gguf',
      destination,
      sha256,
      expectedBytes: bytes.byteLength,
      maximumBytes: 1024,
    }, {
      fetcher: fakeFetch(bytes),
      onProgress: (event) => progress.push(event.percent ?? -1),
    });

    assert.equal(result.sha256, sha256);
    assert.equal(result.bytes, bytes.byteLength);
    assert.equal(await fs.readFile(destination, 'utf8'), 'verified-local-model');
    assert.equal(progress.at(-1), 100);
    await assert.rejects(fs.stat(`${destination}.part`));
  });
});

test('downloadVerifiedFile discards a file when the SHA-256 does not match', async () => {
  await withTempDir(async (root) => {
    const bytes = new TextEncoder().encode('tampered');
    const destination = path.join(root, 'model.gguf');
    await assert.rejects(
      downloadVerifiedFile({
        url: 'https://example.test/model.gguf',
        destination,
        sha256: '0'.repeat(64),
        expectedBytes: bytes.byteLength,
        maximumBytes: 1024,
      }, { fetcher: fakeFetch(bytes) }),
      /SHA-256 falhou/,
    );
    await assert.rejects(fs.stat(destination));
    await assert.rejects(fs.stat(`${destination}.part`));
  });
});

test('downloadVerifiedFile rejects an unexpected remote size before writing content', async () => {
  await withTempDir(async (root) => {
    const bytes = new TextEncoder().encode('size-check');
    const destination = path.join(root, 'model.gguf');
    await assert.rejects(
      downloadVerifiedFile({
        url: 'https://example.test/model.gguf',
        destination,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        expectedBytes: bytes.byteLength + 1,
        maximumBytes: 1024,
      }, { fetcher: fakeFetch(bytes) }),
      /Tamanho remoto inesperado/,
    );
    await assert.rejects(fs.stat(destination));
  });
});
