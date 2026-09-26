import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/core/markdown';
import { normalizeUnicodeText } from '../src/core/unicode-normalization';

test('repairs common UTF-8 decoded as latin-1 mojibake without changing normal text', () => {
  assert.equal(normalizeUnicodeText('DecisÃµes EstratÃ©gicas'), 'Decisões Estratégicas');
  assert.equal(normalizeUnicodeText('eficiÃªncia e inteligÃªncia'), 'eficiência e inteligência');
  assert.equal(normalizeUnicodeText('Texto normal com ação e informação.'), 'Texto normal com ação e informação.');
});

test('renders common assistant Markdown locally', () => {
  const html = renderMarkdown('# Título\n\nTexto com **negrito**, *itálico* e `código`.\n\n- Um\n- Dois\n\n```js\nconst valor = 1;\n```');

  assert.match(html, /<h1>Título<\/h1>/);
  assert.match(html, /<strong>negrito<\/strong>/);
  assert.match(html, /<em>itálico<\/em>/);
  assert.match(html, /<code>código<\/code>/);
  assert.match(html, /<ul><li>Um<\/li><li>Dois<\/li><\/ul>/);
  assert.match(html, /<pre><code class="language-js">const valor = 1;<\/code><\/pre>/);
});

test('escapes raw HTML and refuses unsafe Markdown links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[clique](javascript:alert(1))');

  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(html.includes('href="javascript:'), false);
});

test('repairs mojibake before Markdown rendering', () => {
  const html = renderMarkdown('**DecisÃµes EstratÃ©gicas**');
  assert.equal(html, '<p><strong>Decisões Estratégicas</strong></p>');
});
