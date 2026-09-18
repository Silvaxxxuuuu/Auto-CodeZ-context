import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginArtifactRuntime } from '../src/plugins/plugin-artifact-runtime';

test('plugin artifact runtime externalizes MCP images and large text without leaking payloads in snapshots', () => {
  const runtime = new PluginArtifactRuntime();
  const image = Buffer.from('fake-image-bytes').toString('base64');
  const largeText = 'x'.repeat(20 * 1024);

  const result = runtime.externalizeMcpResult('test.plugin', {
    content: [
      { type: 'image', data: image, mimeType: 'image/png' },
      { type: 'text', text: largeText },
      { type: 'text', text: 'small' },
    ],
  }) as { content: Array<Record<string, unknown>> };

  assert.equal(result.content[0].type, 'artifact');
  assert.equal(result.content[1].type, 'artifact');
  assert.deepEqual(result.content[2], { type: 'text', text: 'small' });

  const imageArtifact = result.content[0].artifact as { id: string; kind: string; mimeType: string; bytes: number };
  const textArtifact = result.content[1].artifact as { id: string; kind: string; mimeType: string; bytes: number };

  assert.equal(imageArtifact.kind, 'image');
  assert.equal(imageArtifact.mimeType, 'image/png');
  assert.equal(textArtifact.kind, 'text');
  assert.equal(runtime.list('test.plugin').length, 2);

  const storedImage = runtime.read('test.plugin', imageArtifact.id);
  const storedText = runtime.read('test.plugin', textArtifact.id);
  assert.equal(storedImage?.encoding, 'base64');
  assert.equal(storedImage?.payload, image);
  assert.equal(storedText?.encoding, 'utf8');
  assert.equal(storedText?.payload, largeText);

  const snapshot = runtime.get('test.plugin', imageArtifact.id) as Record<string, unknown>;
  assert.equal('payload' in snapshot, false);
  assert.equal('encoding' in snapshot, false);
});

test('plugin artifact runtime isolates ownership and clears plugin artifacts', () => {
  const runtime = new PluginArtifactRuntime();
  const artifact = runtime.storeText('plugin.a', 'hello');
  assert.ok(runtime.get('plugin.a', artifact.id));
  assert.equal(runtime.get('plugin.b', artifact.id), undefined);
  assert.equal(runtime.read('plugin.b', artifact.id), undefined);
  assert.equal(runtime.clear('plugin.a'), 1);
  assert.equal(runtime.get('plugin.a', artifact.id), undefined);
});

test('plugin artifact runtime enforces per-artifact size bounds', () => {
  const runtime = new PluginArtifactRuntime();
  assert.throws(() => runtime.storeText('test.plugin', 'x'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});


test('plugin artifact runtime rejects malformed base64 and prunes by plugin memory budget', () => {
  const runtime = new PluginArtifactRuntime();
  assert.throws(() => runtime.storeImage('test.plugin', 'not-base64!'), /base64 válido/);

  const payload = Buffer.alloc(1024 * 1024, 1).toString('base64');
  const ids: string[] = [];
  for (let index = 0; index < 17; index += 1) {
    ids.push(runtime.storeImage('test.plugin', payload, 'image/png', index + 1).id);
  }

  assert.equal(runtime.get('test.plugin', ids[0]), undefined);
  assert.ok(runtime.list('test.plugin').length <= 16);
});
