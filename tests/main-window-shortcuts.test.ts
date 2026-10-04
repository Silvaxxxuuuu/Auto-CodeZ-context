import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMainWindowShortcut } from '../src/main-window-shortcuts';

function fixture(initial = false) {
  let fullScreen = initial;
  let writes = 0;
  const window = {
    isDestroyed: () => false,
    isFullScreen: () => fullScreen,
    setFullScreen: (value: boolean) => { fullScreen = value; writes += 1; },
  };
  return { window, fullScreen: () => fullScreen, writes: () => writes };
}

test('F11 alterna tela cheia da janela principal nos dois sentidos', () => {
  const f = fixture(false);
  assert.equal(handleMainWindowShortcut(f.window, { type: 'keyDown', key: 'F11', isAutoRepeat: false }), true);
  assert.equal(f.fullScreen(), true);
  assert.equal(handleMainWindowShortcut(f.window, { type: 'keyDown', key: 'F11', isAutoRepeat: false }), true);
  assert.equal(f.fullScreen(), false);
  assert.equal(f.writes(), 2);
});

test('atalho ignora keyUp, repetição automática e outras teclas', () => {
  const f = fixture();
  assert.equal(handleMainWindowShortcut(f.window, { type: 'keyUp', key: 'F11' }), false);
  assert.equal(handleMainWindowShortcut(f.window, { type: 'keyDown', key: 'F11', isAutoRepeat: true }), false);
  assert.equal(handleMainWindowShortcut(f.window, { type: 'keyDown', key: 'F10' }), false);
  assert.equal(f.writes(), 0);
});

test('atalho não toca em janela já destruída', () => {
  let writes = 0;
  assert.equal(handleMainWindowShortcut({
    isDestroyed: () => true,
    isFullScreen: () => false,
    setFullScreen: () => { writes += 1; },
  }, { type: 'keyDown', key: 'F11' }), false);
  assert.equal(writes, 0);
});
