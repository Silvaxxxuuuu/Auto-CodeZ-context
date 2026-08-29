export type ParsedFileChange = {
  path: string;
  content: string;
};

export type ParsedAiResponse = {
  raw: string;
  explanation: string;
  files: ParsedFileChange[];
};

const FILE_HEADER_PATTERN =
  /(?:^|\n)(?:arquivo|file|path)\s*:\s*(.+?)\s*\n/gi;

const FENCED_BLOCK_PATTERN =
  /```([^\n]*)\n([\s\S]*?)```/g;

const PATH_PATTERN =
  /^(?:src[\\/]|app[\\/]|lib[\\/]|components[\\/]|pages[\\/]|public[\\/]|tests?[\\/]|test[\\/]|config[\\/]|scripts[\\/]|tools[\\/]|\.github[\\/]|package\.json$|tsconfig(?:\.[^/\\]+)?\.json$|vite\.[^/\\]+$|webpack\.[^/\\]+$|README(?:\.[^/\\]+)?$|index\.html$|[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$)/i;

function normalizePath(
  value: string,
): string {
  return value
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}

function looksLikePath(
  value: string,
): boolean {
  const normalized =
    normalizePath(value);

  if (
    !normalized ||
    normalized.length > 260
  ) {
    return false;
  }

  if (
    normalized.includes(' ')
  ) {
    return false;
  }

  return PATH_PATTERN.test(
    normalized,
  );
}

function cleanContent(
  content: string,
): string {
  return content
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '');
}

function extractExplanation(
  raw: string,
): string {
  const withoutCode =
    raw.replace(
      FENCED_BLOCK_PATTERN,
      '',
    );

  return withoutCode
    .replace(
      /^\s*(?:arquivo|file|path)\s*:\s*.+$/gim,
      '',
    )
    .trim();
}

function parseExplicitFileBlocks(
  raw: string,
): ParsedFileChange[] {
  const files: ParsedFileChange[] =
    [];

  const matches =
    Array.from(
      raw.matchAll(
        FILE_HEADER_PATTERN,
      ),
    );

  for (
    let index = 0;
    index < matches.length;
    index++
  ) {
    const match =
      matches[index];

    const path =
      normalizePath(
        match[1],
      );

    if (!looksLikePath(path)) {
      continue;
    }

    const contentStart =
      (match.index || 0) +
      match[0].length;

    const nextMatch =
      matches[index + 1];

    const contentEnd =
      nextMatch
        ? nextMatch.index ||
          raw.length
        : raw.length;

    const content =
      raw.substring(
        contentStart,
        contentEnd,
      );

    if (!content.trim()) {
      continue;
    }

    files.push({
      path,
      content:
        cleanContent(content),
    });
  }

  return files;
}

function parseFencedBlocks(
  raw: string,
): ParsedFileChange[] {
  const files: ParsedFileChange[] =
    [];

  const matches =
    Array.from(
      raw.matchAll(
        FENCED_BLOCK_PATTERN,
      ),
    );

  for (
    const match of matches
  ) {
    const start =
      match.index || 0;

    const before =
      raw.substring(
        0,
        start,
      );

    const lines =
      before.split(/\r?\n/);

    const previousLine =
      lines[
        lines.length - 1
      ]?.trim() || '';

    let path = '';

    const headerMatch =
      previousLine.match(
        /^(?:arquivo|file|path)\s*:\s*(.+)$/i,
      );

    if (headerMatch) {
      path =
        normalizePath(
          headerMatch[1],
        );
    } else if (
      looksLikePath(
        previousLine,
      )
    ) {
      path =
        normalizePath(
          previousLine,
        );
    }

    if (!path) {
      continue;
    }

    files.push({
      path,
      content:
        cleanContent(
          match[2],
        ),
    });
  }

  return files;
}

function deduplicateFiles(
  files: ParsedFileChange[],
): ParsedFileChange[] {
  const map =
    new Map<
      string,
      ParsedFileChange
    >();

  for (
    const file of files
  ) {
    map.set(
      normalizePath(
        file.path,
      ),
      {
        path: normalizePath(
          file.path,
        ),
        content:
          file.content,
      },
    );
  }

  return Array.from(
    map.values(),
  );
}

export function parseAiResponse(
  raw: string,
): ParsedAiResponse {
  const normalized =
    raw.replaceAll(
      '\r\n',
      '\n',
    );

  const explicit =
    parseExplicitFileBlocks(
      normalized,
    );

  const fenced =
    parseFencedBlocks(
      normalized,
    );

  const files =
    deduplicateFiles([
      ...explicit,
      ...fenced,
    ]);

  return {
    raw,
    explanation:
      extractExplanation(
        normalized,
      ),
    files,
  };
}