import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { extractOfficeText } from '../src/ai/archive-text-extractor';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const raw = Buffer.from(file.content, 'utf8');
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

test('extractOfficeText indexes DOCX document text and paragraph boundaries', () => {
  const bytes = zip([{
    name: 'word/document.xml',
    content: '<w:document><w:body><w:p><w:r><w:t>Auto CodeZ</w:t></w:r></w:p><w:p><w:r><w:t>Erro 429</w:t></w:r></w:p></w:body></w:document>',
  }]);
  assert.match(extractOfficeText(bytes, '.docx'), /Auto CodeZ\nErro 429/);
});

test('extractOfficeText indexes PPTX slides in numeric order', () => {
  const bytes = zip([
    { name: 'ppt/slides/slide2.xml', content: '<p:sld><a:p><a:r><a:t>Segundo slide</a:t></a:r></a:p></p:sld>' },
    { name: 'ppt/slides/slide1.xml', content: '<p:sld><a:p><a:r><a:t>Primeiro slide</a:t></a:r></a:p></p:sld>' },
  ]);
  const text = extractOfficeText(bytes, '.pptx');
  assert.ok(text.indexOf('Primeiro slide') < text.indexOf('Segundo slide'));
});

test('extractOfficeText indexes XLSX shared strings and worksheet cell values', () => {
  const bytes = zip([
    { name: 'xl/sharedStrings.xml', content: '<sst><si><t>Receita</t></si><si><t>R$ 1.250,00</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData><row><c><v>0</v></c><c><v>1</v></c></row></sheetData></worksheet>' },
  ]);
  const text = extractOfficeText(bytes, '.xlsx');
  assert.match(text, /Receita/);
  assert.match(text, /R\$ 1\.250,00/);
});

test('extractOfficeText indexes OpenDocument content.xml', () => {
  const bytes = zip([{
    name: 'content.xml',
    content: '<office:document-content><text:p>Relatório <text:span>local</text:span></text:p><text:p>Status: pronto</text:p></office:document-content>',
  }]);
  assert.match(extractOfficeText(bytes, '.odt'), /Relatório local\nStatus: pronto/);
});
