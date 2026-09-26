import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleVisionWebProvider } from '../src/ai/visual-grounding/providers/google-vision-web';
import type { AIAttachment } from '../src/ai/types';

const attachment: AIAttachment = {
  id: 'a',
  kind: 'image',
  name: 'image.jpg',
  mediaType: 'image/jpeg',
  size: 3,
  storageKey: 'c'.repeat(64),
  sha256: 'c'.repeat(64),
  createdAt: 1,
};

test('Google Vision Web provider parses best guess, entities and matching pages without exposing the API key in output', async () => {
  let requestedUrl = '';
  const store = { async readBytes() { return Buffer.from([1, 2, 3]); } };
  const provider = new GoogleVisionWebProvider(store as never, {
    apiKey: 'private-key',
    now: (() => { let now = 100; return () => now += 10; })(),
    fetch: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify({
        responses: [{
          webDetection: {
            bestGuessLabels: [{ label: 'Miyamoto Musashi Vagabond' }],
            webEntities: [{ description: 'Miyamoto Musashi', score: 0.9 }],
            pagesWithMatchingImages: [{ url: 'https://example.com/page', pageTitle: 'Vagabond' }],
            fullMatchingImages: [{ url: 'https://example.com/full.jpg' }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await provider.search(attachment);
  assert.match(requestedUrl, /vision\.googleapis\.com/);
  assert.match(requestedUrl, /key=private-key/);
  assert.equal(result.bestGuess, 'Miyamoto Musashi Vagabond');
  assert.equal(result.entities[0]?.name, 'Miyamoto Musashi');
  assert.equal(result.pages[0]?.url, 'https://example.com/page');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});
