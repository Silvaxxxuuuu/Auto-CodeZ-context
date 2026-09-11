import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type VerifiedDownloadProgress = {
  completedBytes: number;
  totalBytes?: number;
  percent?: number;
};

export type VerifiedDownloadRequest = {
  url: string;
  destination: string;
  sha256: string;
  expectedBytes?: number;
  maximumBytes?: number;
};

export type VerifiedDownloadOptions = {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onProgress?: (progress: VerifiedDownloadProgress) => void;
};

function normalizedSha256(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('SHA-256 esperado inválido.');
  return normalized;
}

function abortError(): Error {
  const error = new Error('Download cancelado.');
  error.name = 'AbortError';
  return error;
}

export async function downloadVerifiedFile(
  request: VerifiedDownloadRequest,
  options: VerifiedDownloadOptions = {},
): Promise<{ bytes: number; sha256: string }> {
  const fetcher = options.fetcher ?? fetch;
  const expectedSha = normalizedSha256(request.sha256);
  const maximumBytes = request.maximumBytes ?? Math.max((request.expectedBytes ?? 0) * 1.05, 64 * 1024 ** 2);
  const temporary = `${request.destination}.part`;
  await fs.mkdir(path.dirname(request.destination), { recursive: true });
  await fs.rm(temporary, { force: true });

  if (options.signal?.aborted) throw abortError();
  const response = await fetcher(request.url, { signal: options.signal, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download falhou com HTTP ${response.status}.`);

  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : request.expectedBytes;
  if (request.expectedBytes && totalBytes && totalBytes !== request.expectedBytes) {
    throw new Error(`Tamanho remoto inesperado: ${totalBytes} bytes; esperado ${request.expectedBytes}.`);
  }
  if (totalBytes && totalBytes > maximumBytes) throw new Error('O arquivo remoto excede o limite de tamanho permitido.');

  const handle = await fs.open(temporary, 'wx');
  const hash = crypto.createHash('sha256');
  let completedBytes = 0;
  try {
    const reader = response.body.getReader();
    let finished = false;
    while (!finished) {
      if (options.signal?.aborted) throw abortError();
      const result = await reader.read();
      finished = result.done;
      if (finished || !result.value?.byteLength) continue;
      completedBytes += result.value.byteLength;
      if (completedBytes > maximumBytes) throw new Error('O download excedeu o limite de tamanho permitido.');
      hash.update(result.value);
      await handle.write(result.value);
      options.onProgress?.({
        completedBytes,
        ...(totalBytes ? { totalBytes, percent: Math.min(100, completedBytes / totalBytes * 100) } : {}),
      });
    }
  } catch (error) {
    await handle.close().catch((): undefined => undefined);
    await fs.rm(temporary, { force: true }).catch((): undefined => undefined);
    throw error;
  }
  await handle.close();

  if (request.expectedBytes && completedBytes !== request.expectedBytes) {
    await fs.rm(temporary, { force: true });
    throw new Error(`Download incompleto: ${completedBytes} bytes; esperado ${request.expectedBytes}.`);
  }
  const actualSha = hash.digest('hex');
  if (actualSha !== expectedSha) {
    await fs.rm(temporary, { force: true });
    throw new Error('A verificação SHA-256 falhou. O arquivo baixado foi descartado.');
  }

  await fs.rm(request.destination, { force: true });
  await fs.rename(temporary, request.destination);
  options.onProgress?.({ completedBytes, totalBytes: completedBytes, percent: 100 });
  return { bytes: completedBytes, sha256: actualSha };
}
