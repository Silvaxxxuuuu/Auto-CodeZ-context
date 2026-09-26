import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRequestSources } from '../src/ai/source-collector';
import type { AIMessage } from '../src/ai/types';

test('source collector does not leak sources from earlier user turns', () => {
  const messages: AIMessage[] = [
    { role: 'user', content: 'Qual é a documentação atual do pacote antigo?' },
    {
      role: 'assistant',
      content: 'Resposta anterior.',
      sources: [{ title: 'Docs antigas do turno', url: 'https://old.example/docs', origin: 'autocodez-web' }],
    },
    {
      role: 'tool',
      toolName: 'web_search',
      toolCallId: 'old-web',
      content: JSON.stringify({
        type: 'web_search_results',
        sources: [{ id: 1, title: 'Resultado antigo', url: 'https://old.example/search' }],
      }),
    },
    { role: 'user', content: 'Agora explique closures sem pesquisar.' },
    { role: 'assistant', content: 'Resposta atual intermediária.' },
  ];

  assert.deepEqual(collectRequestSources(messages), []);
});

test('source collector keeps only current-turn tool and assistant sources', () => {
  const messages: AIMessage[] = [
    { role: 'user', content: 'Pergunta anterior.' },
    {
      role: 'assistant',
      content: 'Resposta anterior.',
      sources: [{ title: 'Fonte antiga', url: 'https://old.example/docs', origin: 'autocodez-web' }],
    },
    { role: 'user', content: 'Pesquise a biblioteca atual.' },
    {
      role: 'tool',
      toolName: 'web_search',
      toolCallId: 'new-web',
      content: JSON.stringify({
        type: 'web_search_results',
        searchProvider: 'Fixture',
        retrievedAt: 200,
        sources: [{ id: 1, title: 'Fonte atual', url: 'https://current.example/docs' }],
      }),
    },
    {
      role: 'assistant',
      content: 'Continuando a pesquisa.',
      sources: [{ title: 'Fonte nativa atual', url: 'https://provider.example/current', origin: 'provider-native' }],
    },
  ];

  assert.deepEqual(collectRequestSources(messages).map((source) => source.url), [
    'https://current.example/docs',
    'https://provider.example/current',
  ]);
});

test('current injected grounding remains available even though system messages precede chat history', () => {
  const messages: AIMessage[] = [
    {
      role: 'system',
      content: [
        'Contexto Web atual recuperado pelo Auto CodeZ.',
        'Consulta: versão atual',
        'Recuperado em: 2026-09-09T05:00:00.000Z',
        '',
        '[1] Documentação atual',
        'URL: https://docs.example/current',
      ].join('\n'),
    },
    { role: 'user', content: 'Qual é a versão atual?' },
  ];

  const sources = collectRequestSources(messages);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://docs.example/current');
  assert.equal(sources[0].retrievedAt, Date.parse('2026-09-09T05:00:00.000Z'));
});
