const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk)-(?:live|test)?[_-]?[a-z0-9_-]{16,}\b/i,
  /\bAIza[0-9A-Za-z_-]{24,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\b/,
];

const LOCAL_PATH_PATTERNS = [
  /\b[A-Za-z]:[\\/](?:Users|Documents|Desktop|Downloads|AppData|Program Files|Windows|src|home)[\\/]/i,
  /(?:^|\s)\/(?:Users|home|private|var\/folders|etc|proc|sys|mnt)\/\S+/i,
  /(?:^|\s)~[\\/]\S+/,
  /\bfile:\/\//i,
];

const RAW_CODE_PATTERNS = [
  /```/,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/,
  /\bclass\s+[A-Za-z_$][\w$]*[^\n{]*\{/,
  /\bimport\s+[^;]+\s+from\s+['"][^'"]+['"]/,
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/,
  /=>\s*[{(]?/,
  /<\/?(?:script|template|style|div|main|body|html)\b/i,
  /[{[]\s*["'][A-Za-z0-9_.-]+["']\s*:/,
];

function containsLikelySecret(value: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S{8,}/i.test(value)) return true;
  if (/\b[A-Fa-f0-9]{64,}\b/.test(value)) return true;
  if (/\b[A-Za-z0-9+/]{80,}={0,2}\b/.test(value)) return true;
  return false;
}

function containsLocalPath(value: string): boolean {
  return LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

function containsRawCode(value: string): boolean {
  return RAW_CODE_PATTERNS.some((pattern) => pattern.test(value)) || /[{;}]{4,}/.test(value);
}

export function normalizeWebSearchQuery(input: string): string {
  const query = input.replace(/\s+/g, ' ').trim();
  if (!query) throw new Error('Consulta web vazia.');
  if (query.length > 500) throw new Error('Consulta web excede o limite de 500 caracteres.');
  if (containsLikelySecret(query)) throw new Error('A consulta web parece conter uma credencial ou segredo e foi bloqueada.');
  if (containsLocalPath(query)) throw new Error('A consulta web parece conter um caminho local e foi bloqueada. Resuma apenas o conceito público que precisa ser pesquisado.');
  if (containsRawCode(query)) throw new Error('A consulta web parece conter código bruto; resuma o objetivo sem enviar conteúdo do projeto.');
  return query;
}

export function assertSafeWebUrlText(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('URL web vazia.');
  if (value.length > 4096) throw new Error('URL web excede o tamanho permitido.');
  if (containsLikelySecret(value)) throw new Error('A URL web parece conter uma credencial ou segredo e foi bloqueada.');
  return value;
}
