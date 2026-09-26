import { normalizeUnicodeText } from './unicode-normalization';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function safeHref(value: string): string | null {
  const href = value.trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  return null;
}

function renderInline(value: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `\u0000INLINE${index}\u0000`;
  };

  let source = value;
  source = source.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, rawHref: string) => {
    const href = safeHref(rawHref);
    if (!href) return `[${label}](${rawHref})`;
    return token(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });

  let html = escapeHtml(source);
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  html = html.replace(/\u0000INLINE(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '');
  return html;
}

function languageClass(value: string): string {
  const language = value.trim().toLowerCase().replace(/[^a-z0-9_+-]/g, '');
  return language ? ` class="language-${escapeHtml(language)}"` : '';
}

export function renderMarkdown(value: string): string {
  const normalized = normalizeUnicodeText(value).replace(/\r\n?/g, '\n');
  const codeBlocks: string[] = [];
  const source = normalized.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, language: string, code: string) => {
    const index = codeBlocks.push(`<pre><code${languageClass(language)}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`) - 1;
    return `\n\u0000BLOCK${index}\u0000\n`;
  });

  const lines = source.split('\n');
  const output: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };

  const flushList = (): void => {
    if (!listType || !listItems.length) return;
    output.push(`<${listType}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${listType}>`);
    listType = null;
    listItems = [];
  };

  for (const line of lines) {
    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) {
      flushParagraph();
      flushList();
      output.push(codeBlocks[Number(block[1])] ?? '');
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      output.push('<hr>');
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(ordered[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return output.join('');
}
