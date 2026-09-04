type StreamEvent = { type?: string; text?: string; [key: string]: unknown };

type StreamBridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: StreamBridge }).autoCodez;

export function subscribeBatchedStreamEvents<T extends StreamEvent>(listener: (event: T) => void): () => void {
  if (!bridge?.onStreamEvent) return () => undefined;

  const original = bridge.onStreamEvent.bind(bridge);
  let queuedText = '';
  let queuedEvent: StreamEvent | null = null;
  let timer = 0;
  let disposed = false;

  const flush = (): void => {
    timer = 0;
    if (disposed || !queuedEvent) return;
    const event = queuedEvent;
    const text = queuedText;
    queuedEvent = null;
    queuedText = '';
    listener((text ? { ...event, text } : event) as T);
  };

  const flushNow = (): void => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    flush();
  };

  const unsubscribe = original((event: StreamEvent) => {
    if (event.type === 'delta' && event.text) {
      queuedEvent = queuedEvent || event;
      queuedText += event.text;
      if (!timer) timer = window.setTimeout(flush, 33);
      return;
    }

    flushNow();
    listener(event as T);
  });

  return () => {
    disposed = true;
    flushNow();
    unsubscribe();
  };
}
