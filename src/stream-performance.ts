type StreamEvent = { type?: string; text?: string; [key: string]: unknown };

type StreamBridge = {
  onStreamEvent: (listener: (event: StreamEvent) => void) => () => void;
};

const bridge = (window as unknown as { autoCodez?: StreamBridge }).autoCodez;

if (bridge?.onStreamEvent && !(bridge.onStreamEvent as { __autoCodezBatched?: boolean }).__autoCodezBatched) {
  const original = bridge.onStreamEvent.bind(bridge);

  const batched = (listener: (event: StreamEvent) => void): (() => void) => {
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
      listener(text ? { ...event, text } : event);
    };

    const flushNow = (): void => {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      flush();
    };

    const unsubscribe = original((event) => {
      if (event.type === 'delta' && event.text) {
        queuedEvent = queuedEvent || event;
        queuedText += event.text;
        if (!timer) timer = window.setTimeout(flush, 33);
        return;
      }

      flushNow();
      listener(event);
    });

    return () => {
      disposed = true;
      flushNow();
      unsubscribe();
    };
  };

  Object.defineProperty(batched, '__autoCodezBatched', { value: true });
  bridge.onStreamEvent = batched;
}
