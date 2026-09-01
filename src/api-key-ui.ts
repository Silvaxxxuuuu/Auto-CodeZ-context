function installApiKeyButton(): void {
  const rail = document.querySelector<HTMLElement>('.rail');
  const terminalButton = document.querySelector<HTMLElement>('.terminal-rail-button');
  if (!rail || !terminalButton || rail.querySelector('.api-key-rail-button')) return;

  const button = document.createElement('button');
  button.className = 'rail-button api-key-rail-button';
  button.type = 'button';
  button.title = 'API Keys';
  button.setAttribute('aria-label', 'API Keys');
  button.innerHTML = '<span aria-hidden="true"></span>';
  rail.insertBefore(button, terminalButton);

  button.addEventListener('click', () => {
    const settingsButton = document.querySelector<HTMLButtonElement>('[data-action="ai-settings"]');
    if (settingsButton) settingsButton.click();
  });
}

const style = document.createElement('style');
style.textContent = `
  .api-key-rail-button:before {
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M14.7 5.3a5 5 0 0 0-6.6 6.6L3 17v4h4l1.6-1.6H11v-2.4h2.4v-2.4h2.3a5 5 0 0 0-1-9.3Zm2.8 4.2a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0Z'/%3E%3C/svg%3E");
  }
`;
document.head.appendChild(style);

installApiKeyButton();
if (!document.querySelector('.api-key-rail-button')) {
  const observer = new MutationObserver(() => {
    installApiKeyButton();
    if (document.querySelector('.api-key-rail-button')) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
