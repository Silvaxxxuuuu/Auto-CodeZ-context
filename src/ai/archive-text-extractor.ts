import zlib from 'node:zlib';

type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 2048;

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Arquivo ZIP inválido.');
}

function entries(bytes: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (totalEntries > MAX_ENTRIES) throw new Error('Documento compactado possui entradas demais.');
  const result: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Diretório ZIP inválido.');
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) throw new Error('Caminho ZIP inseguro.');
    result.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function inflateEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error('Parte do documento excede o limite permitido.');
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Entrada ZIP inválida.');
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new Error('Entrada ZIP truncada.');
  const compressed = bytes.subarray(start, end);
  let output: Buffer;
  if (entry.compression === 0) output = Buffer.from(compressed);
  else if (entry.compression === 8) output = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
  else throw new Error('Método de compactação não suportado.');
  if (entry.uncompressedSize && output.length !== entry.uncompressedSize) throw new Error('Tamanho de entrada ZIP inválido.');
  return output;
}

function decodeXml(value: string): string {
  return value
    .replace(/<w:tab\s*\/>|<text:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>|<a:br\s*\/>|<text:line-break\s*\/>/g, '\n')
    .replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<\/row>|<\/c:r>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 16)));
}

function normalize(value: string): string {
  return value.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractOfficeText(bytes: Buffer, extension: string): string {
  const zipEntries = entries(bytes);
  let total = 0;
  const wanted = (name: string): boolean => {
    if (extension === '.docx') return /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(name);
    if (extension === '.pptx') return /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(name);
    if (extension === '.xlsx') return /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/i.test(name);
    if (extension === '.odt' || extension === '.ods' || extension === '.odp') return name === 'content.xml';
    return false;
  };

  const selected = zipEntries.filter((entry) => wanted(entry.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const chunks: string[] = [];
  for (const entry of selected) {
    total += entry.uncompressedSize;
    if (total > MAX_TOTAL_BYTES) throw new Error('Conteúdo extraído do documento excede o limite permitido.');
    const xml = inflateEntry(bytes, entry).toString('utf8');
    const text = normalize(decodeXml(xml));
    if (text) chunks.push(text);
  }
  return normalize(chunks.join('\n\n'));
}
