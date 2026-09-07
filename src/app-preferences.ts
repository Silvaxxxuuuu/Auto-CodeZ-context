export type InterfaceDensity = 'comfortable' | 'compact';

export interface AppPreferences {
  general: {
    animations: boolean;
    density: InterfaceDensity;
  };
  profile: {
    id: string;
    displayName: string;
  };
}

export const APP_PREFERENCES_EVENT = 'auto-codez-preferences-changed';
const STORAGE_KEY = 'auto-codez.preferences.v1';

function createLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaults(): AppPreferences {
  return {
    general: {
      animations: true,
      density: 'comfortable',
    },
    profile: {
      id: createLocalId(),
      displayName: 'Usuário local',
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sanitize(value: unknown, fallback = defaults()): AppPreferences {
  const root = objectValue(value);
  const general = objectValue(root.general);
  const profile = objectValue(root.profile);
  const density = general.density === 'compact' || general.density === 'comfortable'
    ? general.density
    : fallback.general.density;
  const displayName = typeof profile.displayName === 'string' && profile.displayName.trim()
    ? profile.displayName.trim().slice(0, 80)
    : fallback.profile.displayName;
  const id = typeof profile.id === 'string' && profile.id.trim()
    ? profile.id.trim().slice(0, 160)
    : fallback.profile.id;
  return {
    general: {
      animations: typeof general.animations === 'boolean' ? general.animations : fallback.general.animations,
      density,
    },
    profile: {
      id,
      displayName,
    },
  };
}

export function getAppPreferences(): AppPreferences {
  const fallback = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback));
      return fallback;
    }
    const value = sanitize(JSON.parse(raw), fallback);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return value;
  } catch {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback)); } catch {}
    return fallback;
  }
}

export function applyAppPreferences(value = getAppPreferences()): AppPreferences {
  const root = document.documentElement;
  root.dataset.acDensity = value.general.density;
  root.classList.toggle('ac-reduced-motion', !value.general.animations);
  return value;
}

export function updateAppPreferences(update: Partial<AppPreferences>): AppPreferences {
  const current = getAppPreferences();
  const next = sanitize({
    ...current,
    ...update,
    general: { ...current.general, ...update.general },
    profile: { ...current.profile, ...update.profile },
  }, current);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  applyAppPreferences(next);
  window.dispatchEvent(new CustomEvent<AppPreferences>(APP_PREFERENCES_EVENT, { detail: next }));
  return next;
}
