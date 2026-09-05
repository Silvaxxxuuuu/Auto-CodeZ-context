import { renderMarkdown } from './core/markdown';

const messages = document.querySelector<HTMLElement>('#messages');
if (!messages) throw new Error('Área de mensagens indisponível.');

const renderedMarkup = new WeakMap<HTMLElement, string>();
let scheduled = false;

const style = document.createElement('style');
style.id = 'auto-codez-message-formatting';
style.textContent = `
.message.assistant .message-content{font-size:13px;line-height:1.72;color:#e9edf3;word-break:break-word}
.message.assistant .message-content> :first-child{margin-top:0}
.message.assistant .message-content> :last-child{margin-bottom:0}
.message.assistant .message-content p{margin:0 0 10px}
.message.assistant .message-content h1,.message.assistant .message-content h2,.message.assistant .message-content h3,.message.assistant .message-content h4,.message.assistant .message-content h5,.message.assistant .message-content h6{margin:16px 0 8px;color:#f2f5f8;line-height:1.3;font-weight:650;letter-spacing:-.01em}
.message.assistant .message-content h1{font-size:20px}.message.assistant .message-content h2{font-size:18px}.message.assistant .message-content h3{font-size:16px}.message.assistant .message-content h4{font-size:14px}.message.assistant .message-content h5,.message.assistant .message-content h6{font-size:13px}
.message.assistant .message-content strong{font-weight:700;color:#f7f9fb}.message.assistant .message-content em{font-style:italic}.message.assistant .message-content del{opacity:.7}
.message.assistant .message-content ul,.message.assistant .message-content ol{margin:8px 0 12px;padding-left:22px}.message.assistant .message-content li{margin:4px 0;padding-left:2px}
.message.assistant .message-content blockquote{margin:10px 0;padding:7px 12px;border-left:2px solid #475365;color:#aeb7c4;background:#0f141b;border-radius:0 7px 7px 0}
.message.assistant .message-content code{padding:2px 5px;border:1px solid #2b3440;border-radius:5px;background:#111821;color:#d9e2ec;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.message.assistant .message-content pre{margin:11px 0;padding:12px 14px;overflow:auto;border:1px solid #29313d;border-radius:9px;background:#0b1016;max-height:520px}
.message.assistant .message-content pre code{display:block;padding:0;border:0;border-radius:0;background:transparent;color:#d7dee8;font-size:11.5px;line-height:1.6;white-space:pre;word-break:normal}
.message.assistant .message-content a{color:#8db9f3;text-decoration:none}.message.assistant .message-content a:hover{text-decoration:underline}
.message.assistant .message-content hr{height:1px;margin:14px 0;border:0;background:#252d38}
`;
if (!document.getElementById(style.id)) document.head.appendChild(style);

function rawText(element: HTMLElement): string {
  let value = '';
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      value += '\n';
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  for (const child of Array.from(element.childNodes)) visit(child);
  return value;
}

function format(element: HTMLElement): void {
  const previous = renderedMarkup.get(element);
  if (previous !== undefined && previous === element.innerHTML) return;
  const source = rawText(element);
  const html = renderMarkdown(source);
  if (element.innerHTML !== html) element.innerHTML = html;
  renderedMarkup.set(element, html);
}

function flush(): void {
  scheduled = false;
  messages.querySelectorAll<HTMLElement>('.message.assistant .message-content').forEach(format);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

new MutationObserver(schedule).observe(messages, { childList: true, subtree: true, characterData: true });
window.addEventListener('auto-codez-chat-refresh', schedule);
window.addEventListener('focus', schedule);

schedule();
