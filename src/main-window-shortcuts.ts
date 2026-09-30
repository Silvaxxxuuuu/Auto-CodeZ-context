export type MainWindowShortcutInput = {
  type: string;
  key: string;
  isAutoRepeat?: boolean;
};

export type FullscreenWindow = {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(value: boolean): void;
};

/**
 * Handles only application-owned window shortcuts. Returning true means the
 * caller must prevent Electron's default handling for this key event.
 */
export function handleMainWindowShortcut(window: FullscreenWindow, input: MainWindowShortcutInput): boolean {
  if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return false;
  if (window.isDestroyed()) return false;
  window.setFullScreen(!window.isFullScreen());
  return true;
}
