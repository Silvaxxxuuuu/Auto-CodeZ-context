import crypto from 'node:crypto';

export type PluginArtifactKind = 'image' | 'text';

export type PluginArtifactSnapshot = {
  id: string;
  pluginId: string;
  kind: PluginArtifactKind;
  mimeType: string;
  bytes: number;
  createdAt: number;
};

type InternalArtifact = PluginArtifactSnapshot & {
  encoding: 'base64' | 'utf8';
  payload: string;
};

const MAX_ARTIFACTS = 256;
const MAX_ARTIFACTS_PER_PLUGIN = 64;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 16 * 1024;

function byteLength(value: string, encoding: BufferEncoding): number {
  return Buffer.byteLength(value, encoding);
}

function cloneSnapshot(artifact: InternalArtifact): PluginArtifactSnapshot {
  const { encoding: _encoding, payload: _payload, ...snapshot } = artifact;
  return { ...snapshot };
}

export class PluginArtifactRuntime {
  private readonly artifacts = new Map<string, InternalArtifact>();

  storeImage(pluginId: string, data: string, mimeType = 'image/png', now = Date.now()): PluginArtifactSnapshot {
    if (typeof data !== 'string' || !data) throw new Error('Imagem do artifact inválida.');
    if (typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]{1,64}$/i.test(mimeType)) throw new Error('MIME type do artifact inválido.');
    let bytes: number;
    try {
      bytes = Buffer.from(data, 'base64').byteLength;
    } catch {
      throw new Error('Imagem do artifact não está em base64 válido.');
    }
    if (bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) throw new Error('Artifact excede o limite de 2 MB.');
    return this.store({
      pluginId,
      kind: 'image',
      mimeType,
      bytes,
      createdAt: now,
      encoding: 'base64',
      payload: data,
    });
  }

  storeText(pluginId: string, text: string, mimeType = 'text/plain', now = Date.now()): PluginArtifactSnapshot {
    if (typeof text !== 'string' || !text) throw new Error('Texto do artifact inválido.');
    const bytes = byteLength(text, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) throw new Error('Artifact excede o limite de 2 MB.');
    return this.store({
      pluginId,
      kind: 'text',
      mimeType,
      bytes,
      createdAt: now,
      encoding: 'utf8',
      payload: text,
    });
  }

  externalizeMcpResult(pluginId: string, result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const value = result as Record<string, unknown>;
    if (!Array.isArray(value.content)) return structuredClone(result);

    const content = value.content.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return structuredClone(item);
      const entry = item as Record<string, unknown>;
      if (entry.type === 'image' && typeof entry.data === 'string') {
        const artifact = this.storeImage(
          pluginId,
          entry.data,
          typeof entry.mimeType === 'string' ? entry.mimeType : 'image/png',
        );
        return { type: 'artifact', artifact };
      }
      if (entry.type === 'text' && typeof entry.text === 'string' && byteLength(entry.text, 'utf8') > MAX_INLINE_TEXT_BYTES) {
        const artifact = this.storeText(pluginId, entry.text);
        return { type: 'artifact', artifact };
      }
      return structuredClone(item);
    });

    return { ...structuredClone(value), content };
  }

  get(pluginId: string, artifactId: string): PluginArtifactSnapshot | undefined {
    const artifact = this.artifacts.get(artifactId);
    return artifact?.pluginId === pluginId ? cloneSnapshot(artifact) : undefined;
  }

  read(pluginId: string, artifactId: string): { snapshot: PluginArtifactSnapshot; encoding: 'base64' | 'utf8'; payload: string } | undefined {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.pluginId !== pluginId) return undefined;
    return {
      snapshot: cloneSnapshot(artifact),
      encoding: artifact.encoding,
      payload: artifact.payload,
    };
  }

  list(pluginId: string): PluginArtifactSnapshot[] {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.pluginId === pluginId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneSnapshot);
  }

  clear(pluginId: string): number {
    let removed = 0;
    for (const [id, artifact] of this.artifacts) {
      if (artifact.pluginId !== pluginId) continue;
      this.artifacts.delete(id);
      removed += 1;
    }
    return removed;
  }

  private store(input: Omit<InternalArtifact, 'id'>): PluginArtifactSnapshot {
    this.prune(input.pluginId);
    const id = crypto.randomUUID();
    const artifact: InternalArtifact = { id, ...input };
    this.artifacts.set(id, artifact);
    return cloneSnapshot(artifact);
  }

  private prune(pluginId: string): void {
    const pluginArtifacts = [...this.artifacts.values()]
      .filter((artifact) => artifact.pluginId === pluginId)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (pluginArtifacts.length >= MAX_ARTIFACTS_PER_PLUGIN) {
      const oldest = pluginArtifacts.shift();
      if (oldest) this.artifacts.delete(oldest.id);
    }

    if (this.artifacts.size < MAX_ARTIFACTS) return;
    const oldest = [...this.artifacts.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) this.artifacts.delete(oldest.id);
  }
}
