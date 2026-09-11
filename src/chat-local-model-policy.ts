export type ChatLocalCompatibilityLevel = 'excellent' | 'compatible' | 'limit' | 'blocked';

export type ChatLocalModelPolicyInput = {
  runtimeAvailable: boolean;
  installSupported: boolean;
  installed: boolean;
  compatibility: ChatLocalCompatibilityLevel;
  overrideConfirmed: boolean;
};

export type ChatLocalModelPolicyState =
  | 'runtime-unavailable'
  | 'blocked'
  | 'needs-confirmation'
  | 'needs-install'
  | 'external-install'
  | 'ready';

export type ChatLocalModelPolicyDecision = {
  state: ChatLocalModelPolicyState;
  canSave: boolean;
  canInstall: boolean;
};

export function resolveChatLocalModelPolicy(input: ChatLocalModelPolicyInput): ChatLocalModelPolicyDecision {
  if (!input.runtimeAvailable) return { state: 'runtime-unavailable', canSave: false, canInstall: false };
  if (input.compatibility === 'blocked') return { state: 'blocked', canSave: false, canInstall: false };
  if (input.compatibility === 'limit' && !input.overrideConfirmed) return { state: 'needs-confirmation', canSave: false, canInstall: false };
  if (input.installed) return { state: 'ready', canSave: true, canInstall: false };
  if (!input.installSupported) return { state: 'external-install', canSave: false, canInstall: false };
  return { state: 'needs-install', canSave: false, canInstall: true };
}
