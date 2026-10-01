import crypto from 'node:crypto';
import type { LocalStorage } from '../core/storage';

const REF_PREFIX = 'blob:sha256:';
const FILE_PREFIX = 'agent-core-rollback-';
const FILE_SUFFIX = '.blob';

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseRef(ref: string): string {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) throw new Error('Referência de rollback inválida.');
  const hash = ref.slice(REF_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Hash de rollback inválido.');
  return hash;
}

function fileName(hash: string): string {
  return `${FILE_PREFIX}${hash}${FILE_SUFFIX}`;
}

export class RollbackBlobStore {
  constructor(private readonly storage: LocalStorage) {}

  async putText(content: string): Promise<string> {
    if (typeof content !== 'string') throw new Error('Conteúdo de rollback inválido.');
    const hash = hashText(content);
    const name = fileName(hash);

    const existing = await this.storage.readEncrypted(name);
    if (existing !== null) {
      if (hashText(existing) !== hash) throw new Error('Blob de rollback existente falhou na verificação de integridade.');
      return `${REF_PREFIX}${hash}`;
    }

    await this.storage.writeEncrypted(name, content);
    const persisted = await this.storage.readEncrypted(name);
    if (persisted === null || hashText(persisted) !== hash) {
      throw new Error('Blob de rollback não pôde ser verificado após persistência.');
    }
    return `${REF_PREFIX}${hash}`;
  }

  async getText(ref: string): Promise<string> {
    const hash = parseRef(ref);
    const content = await this.storage.readEncrypted(fileName(hash));
    if (content === null) throw new Error('Blob de rollback não encontrado.');
    if (hashText(content) !== hash) throw new Error('Blob de rollback corrompido ou adulterado.');
    return content;
  }

  async has(ref: string): Promise<boolean> {
    const hash = parseRef(ref);
    const content = await this.storage.readEncrypted(fileName(hash));
    if (content === null) return false;
    if (hashText(content) !== hash) throw new Error('Blob de rollback corrompido ou adulterado.');
    return true;
  }

  async remove(ref: string): Promise<void> {
    const hash = parseRef(ref);
    await this.storage.remove(fileName(hash));
  }

  static refForText(content: string): string {
    if (typeof content !== 'string') throw new Error('Conteúdo de rollback inválido.');
    return `${REF_PREFIX}${hashText(content)}`;
  }
}
