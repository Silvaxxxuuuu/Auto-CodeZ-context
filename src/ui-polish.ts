const STYLE_ID = 'auto-codez-ui-polish';

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .chat-item{position:relative;padding-right:64px!important}
    .chat-settings,.chat-delete{width:26px!important;height:26px!important;position:absolute;top:50%;transform:translateY(-50%);margin:0!important;border:0!important;border-radius:7px!important;background:transparent!important;font-size:0!important;opacity:0!important;transition:opacity .14s,background .14s,color .14s,transform .14s!important}
    .chat-settings{right:34px;color:#aeb7c4!important}
    .chat-delete{right:7px;color:#c76f78!important}
    .chat-item:hover .chat-settings,.chat-item:hover .chat-delete,.chat-settings:focus-visible,.chat-delete:focus-visible{opacity:1!important}
    .chat-settings:hover{background:#202630!important;color:#eef2f7!important;transform:translateY(-50%)!important}
    .chat-delete:hover{background:#382024!important;color:#f08b94!important;transform:translateY(-50%)!important}
    .chat-settings:before,.chat-delete:before{content:"";position:absolute;inset:6px;background:currentColor;mask-position:center;mask-size:contain;mask-repeat:no-repeat}
    .chat-settings:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M4 17.3V20h2.7l9.9-9.9-2.7-2.7L4 17.3Zm14.7-8.6a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.3 1.3 2.7 2.7 1.3-1.3Z'/%3E%3C/svg%3E")}
    .chat-delete:before{mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M6 7h12l-.7 13H6.7L6 7Zm3-3h6l1 2H8l1-2Zm-5 2h16v2H4V6Zm5 4h2v7H9v-7Zm4 0h2v7h-2v-7Z'/%3E%3C/svg%3E")}
    .message.user{display:flex;flex-direction:column;align-items:flex-end}
    .message.user .message-label{align-self:flex-end}
    .message.user .message-content{max-width:min(78%,720px);text-align:left}
    .message.assistant,.message.tool{display:flex;flex-direction:column;align-items:flex-start}
    .message.assistant .message-content,.message.tool .message-content{max-width:78%}
    .message.streaming .message-label{display:flex;align-items:center;gap:7px}
    .message.streaming .message-label:before{content:"";width:7px;height:7px;border-radius:50%;background:#aeb9c8;box-shadow:0 0 0 4px #aeb9c812;animation:ac-pulse 1.2s ease-in-out infinite}
    .ac-thinking{display:inline-flex!important;align-items:center;gap:4px;min-height:28px}
    .ac-thinking-dot{width:4px;height:4px;border-radius:50%;background:#aeb9c8;animation:ac-thinking 1s ease-in-out infinite}
    .ac-thinking-dot:nth-child(2){animation-delay:.14s}.ac-thinking-dot:nth-child(3){animation-delay:.28s}
    @keyframes ac-thinking{0%,60%,100%{opacity:.22;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
    @keyframes ac-pulse{0%,100%{opacity:.45;transform:scale(.9)}50%{opacity:1;transform:scale(1)}}
    .activity-card.ac-hidden-while-thinking{display:none!important}
    .composer-hint{transition:opacity .18s}.composer-hint.ac-busy{opacity:.35}
    .intelligence-brain{filter:saturate(0)!important}
    @media(max-width:700px){.message.user .message-content,.message.assistant .message-content,.message.tool .message-content{max-width:88%}.chat-item{padding-right:60px!important}.chat-settings{right:31px}.chat-delete{right:5px}}
  `;
  document.head.appendChild(style);
}

function installThinkingIndicator(): void {
  const messages = document.querySelector<HTMLElement>('#messages');
  if (!messages) return;

  const observer = new MutationObserver(() => {
    const running = Boolean(document.querySelector('.send-button:disabled'));
    const activity = messages.querySelector<HTMLElement>('.activity-card');
    const live = messages.querySelector<HTMLElement>('.message.streaming');

    if (!running || live) {
      activity?.classList.remove('ac-hidden-while-thinking');
      messages.querySelector('.ac-thinking')?.remove();
      document.querySelector('.composer-hint')?.classList.remove('ac-busy');
      return;
    }

    activity?.classList.add('ac-hidden-while-thinking');
    document.querySelector('.composer-hint')?.classList.add('ac-busy');

    if (!messages.querySelector('.ac-thinking')) {
      const indicator = document.createElement('article');
      indicator.className = 'message assistant ac-thinking';
      indicator.setAttribute('aria-label', 'A IA está respondendo');
      indicator.innerHTML = '<span class="ac-thinking-dot"></span><span class="ac-thinking-dot"></span><span class="ac-thinking-dot"></span>';
      messages.appendChild(indicator);
    }
    messages.scrollTop = messages.scrollHeight;
  });

  observer.observe(messages, { childList: true, subtree: true });
}

installStyle();
installThinkingIndicator();
