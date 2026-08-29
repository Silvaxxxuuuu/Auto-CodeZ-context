const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

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

export async function* parseSSE(response: Response): AsyncGenerator<unknown> {
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
      const { done, value } = await reader.read();
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
