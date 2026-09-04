const style = document.createElement('style');
style.id = 'auto-codez-api-key-manager-ux';
style.textContent = `
  .api-key-flow-status{display:none!important}
  .api-key-manager:has(.api-key-manager-form.open) .api-key-manager-add{display:none!important}
`;
document.head.appendChild(style);

function relabelActiveBadges(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.api-key-active').forEach((badge) => {
    if (badge.textContent?.trim().toLowerCase() === 'ativa') badge.textContent = 'Padrão';
    badge.title = 'Credencial padrão deste provider para novos usos que não escolherem uma chave específica.';
  });
}

function syncManager(): void {
  const backdrop = document.querySelector<HTMLElement>('.api-key-manager-backdrop');
  if (!backdrop) return;
  backdrop.querySelector<HTMLElement>('.api-key-flow-status')?.remove();
  relabelActiveBadges(backdrop);
}

const observer = new MutationObserver(syncManager);
observer.observe(document.body, { childList: true, subtree: true });
syncManager();
