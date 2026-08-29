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
