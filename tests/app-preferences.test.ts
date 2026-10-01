import assert from 'node:assert/strict';
import test from 'node:test';
import { getAppPreferences } from '../src/app-preferences';

const STORAGE_KEY = 'auto-codez.preferences.v1';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

test.beforeEach(() => storage.clear());

test('app preferences default new chats to normal reasoning and safe autonomy', () => {
  const preferences = getAppPreferences();
  assert.deepEqual(preferences.chatDefaults, {
    intelligence: 'normal',
    permissionLevel: 'safe',
  });
});

test('legacy v1 preferences gain chat defaults without losing existing values', () => {
  storage.setItem(STORAGE_KEY, JSON.stringify({
    general: { animations: false, density: 'compact' },
    editor: { fontSize: 15, fontFamily: 'cascadia', wordWrap: true, minimap: true, tabSize: 2 },
    profile: { id: 'legacy-device', displayName: 'Legacy User' },
  }));

  const preferences = getAppPreferences();
  assert.equal(preferences.general.animations, false);
  assert.equal(preferences.general.density, 'compact');
  assert.equal(preferences.profile.id, 'legacy-device');
  assert.equal(preferences.profile.displayName, 'Legacy User');
  assert.equal(preferences.editor.fontSize, 15);
  assert.equal(preferences.chatDefaults.intelligence, 'normal');
  assert.equal(preferences.chatDefaults.permissionLevel, 'safe');
});

test('invalid stored chat defaults are sanitized back to safe values', () => {
  storage.setItem(STORAGE_KEY, JSON.stringify({
    chatDefaults: { intelligence: 'infinite', permissionLevel: 'root' },
  }));

  const preferences = getAppPreferences();
  assert.deepEqual(preferences.chatDefaults, {
    intelligence: 'normal',
    permissionLevel: 'safe',
  });
});
