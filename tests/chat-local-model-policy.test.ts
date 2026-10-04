import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChatLocalModelPolicy } from '../src/chat-local-model-policy';

test('safe installed local model can be saved immediately', () => {
  assert.deepEqual(resolveChatLocalModelPolicy({
    runtimeAvailable: true,
    installSupported: true,
    installed: true,
    compatibility: 'excellent',
    overrideConfirmed: false,
  }), { state: 'ready', canSave: true, canInstall: false });
});

test('safe uninstalled local model requires installation before save', () => {
  assert.deepEqual(resolveChatLocalModelPolicy({
    runtimeAvailable: true,
    installSupported: true,
    installed: false,
    compatibility: 'compatible',
    overrideConfirmed: false,
  }), { state: 'needs-install', canSave: false, canInstall: true });
});

test('limited local model requires explicit override before install or save', () => {
  assert.deepEqual(resolveChatLocalModelPolicy({
    runtimeAvailable: true,
    installSupported: true,
    installed: false,
    compatibility: 'limit',
    overrideConfirmed: false,
  }), { state: 'needs-confirmation', canSave: false, canInstall: false });
  assert.deepEqual(resolveChatLocalModelPolicy({
    runtimeAvailable: true,
    installSupported: true,
    installed: false,
    compatibility: 'limit',
    overrideConfirmed: true,
  }), { state: 'needs-install', canSave: false, canInstall: true });
});

test('blocked local model can never be installed or saved through the chat', () => {
  assert.deepEqual(resolveChatLocalModelPolicy({
    runtimeAvailable: true,
    installSupported: true,
    installed: true,
    compatibility: 'blocked',
    overrideConfirmed: true,
  }), { state: 'blocked', canSave: false, canInstall: false });
});

test('unavailable runtime and external-only installation fail closed', () => {
  assert.equal(resolveChatLocalModelPolicy({ runtimeAvailable: false, installSupported: true, installed: true, compatibility: 'excellent', overrideConfirmed: false }).state, 'runtime-unavailable');
  assert.deepEqual(resolveChatLocalModelPolicy({ runtimeAvailable: true, installSupported: false, installed: false, compatibility: 'excellent', overrideConfirmed: false }), { state: 'external-install', canSave: false, canInstall: false });
});
