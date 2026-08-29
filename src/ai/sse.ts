export async function* parseSSE(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('O provider não retornou um stream de dados.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload) as unknown;
        } catch {
          continue;
        }
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
