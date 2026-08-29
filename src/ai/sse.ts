const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`A requisição ao provider excedeu o tempo limite de ${Math.round(timeoutMs / 1000)} segundos.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`O stream do provider ficou sem dados por ${Math.round(timeoutMs / 1000)} segundos.`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function* parseSSE(response: Response, idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('O provider não retornou um stream de dados.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): unknown | undefined => {
    if (!line.startsWith('data:')) return undefined;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return undefined;
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
  };

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed !== undefined) yield parsed;
      }

      if (done) {
        const finalLine = buffer.trim();
        if (finalLine) {
          const parsed = parseLine(finalLine);
          if (parsed !== undefined) yield parsed;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
