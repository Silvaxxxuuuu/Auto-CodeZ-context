function routeAiSettingsToApiKeys(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest<HTMLElement>('[data-action="ai-settings"]');
  if (!action) return;

  const apiKeyButton = document.querySelector<HTMLButtonElement>('.api-key-rail-button');
  if (!apiKeyButton) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  apiKeyButton.click();
}

document.addEventListener('click', routeAiSettingsToApiKeys, true);
