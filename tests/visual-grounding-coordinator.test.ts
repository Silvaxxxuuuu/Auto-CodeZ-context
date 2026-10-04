import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIAttachment } from '../src/ai/types';
import { visualAttachmentCues, visualSearchQuery } from '../src/ai/visual-grounding/visual-grounding-query';
import { VisualGroundingCoordinator } from '../src/ai/visual-grounding/visual-grounding-coordinator';
import type { ReverseImageSearchProvider } from '../src/ai/visual-grounding/visual-grounding-types';
import { WebRetrievalRuntime } from '../src/web/web-retrieval-runtime';
import type { WebSearchAdapter } from '../src/web/web-types';

function image(): AIAttachment {
  return {
    id: 'img',
    kind: 'image',
    name: 'miyamto.jpg',
    mediaType: 'image/jpeg',
    size: 10,
    storageKey: 'b'.repeat(64),
    sha256: 'b'.repeat(64),
    createdAt: 1,
    contexts: [
      { kind: 'caption', text: 'black and white ink illustration long-haired swordsman dark headband', createdAt: 1 },
      { kind: 'ocr', text: 'user@example.com C:\\Users\\Gabriel\\Desktop\\token.png', createdAt: 1 },
    ],
  };
}

test('visual query strips private values and never uses the attachment filename', () => {
  const attachment = image();
  const cues = visualAttachmentCues(attachment);
  const query = visualSearchQuery('Quem é esse personagem?', attachment);
  assert.match(cues, /swordsman/);
  assert.doesNotMatch(cues, /example\.com|Users|Gabriel|Desktop|token/i);
  assert.doesNotMatch(query, /miyamto/i);
});

test('visual coordinator classifies identification, guidance and error intents only when an image is attached', () => {
  const coordinator = new VisualGroundingCoordinator({ runtime: new WebRetrievalRuntime({ searchAdapter: { id: 'x', displayName: 'x', async search() { return []; } } }) });
  const attachment = image();
  assert.equal(coordinator.classify([{ role: 'user', content: 'Quem é esse cara?', attachments: [attachment] }]).reason, 'visual-identification');
  assert.equal(coordinator.classify([{ role: 'user', content: 'Onde eu clico nessa tela?', attachments: [attachment] }]).reason, 'visual-guidance');
  assert.equal(coordinator.classify([{ role: 'user', content: 'Deu esse erro, o que faço?', attachments: [attachment] }]).reason, 'visual-error');
  assert.equal(coordinator.classify([{ role: 'user', content: 'Quem é esse cara?' }]).required, false);
});

test('reverse image evidence seeds search and preserves matching pages as cited sources', async () => {
  let query = '';
  const searchAdapter: WebSearchAdapter = {
    id: 'fixture',
    displayName: 'Fixture',
    async search(value) {
      query = value;
      return [{ title: 'Vagabond reference', url: 'https://example.com/vagabond', snippet: 'Miyamoto Musashi artwork.' }];
    },
  };
  const reverse: ReverseImageSearchProvider = {
    id: 'reverse',
    displayName: 'Reverse',
    available: () => true,
    async search() {
      return {
        bestGuess: 'Miyamoto Musashi Vagabond',
        entities: [{ name: 'Miyamoto Musashi', score: 0.92 }],
        pages: [{ title: 'Matching page', url: 'https://example.com/match' }],
        fullMatches: ['https://images.example/full.jpg'],
        partialMatches: [],
        similarImages: [],
        provider: 'reverse',
        durationMs: 20,
      };
    },
  };
  const coordinator = new VisualGroundingCoordinator({
    runtime: new WebRetrievalRuntime({ searchAdapter }),
    reverseProvider: reverse,
    fetchLimit: 0,
  });
  const result = await coordinator.ground([{ role: 'user', content: 'Quem é esse cara?', attachments: [image()] }]);
  assert.match(query, /Miyamoto Musashi Vagabond/i);
  assert.equal(result?.reason, 'visual-identification');
  assert.equal(result?.sources[0]?.url, 'https://example.com/match');
  assert.match(result?.context ?? '', /Melhor hipótese: Miyamoto Musashi Vagabond/);
});
