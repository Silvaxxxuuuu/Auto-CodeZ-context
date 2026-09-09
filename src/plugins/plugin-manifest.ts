import { validatePluginContributionPermissions } from './plugin-policy';
import {
  PLUGIN_API_VERSION,
  type PluginContribution,
  type PluginManifest,
  type PluginPermission,
} from './plugin-types';

const CONTRIBUTIONS = new Set<PluginContribution>([
  'left-sidebar',
  'right-sidebar',
  'command',
  'provider',
  'tool',
  'theme',
]);

const PERMISSIONS = new Set<PluginPermission>([
  'workspace:read',
  'workspace:write',
  'terminal:execute',
  'git:read',
  'git:write',
  'network:fetch',
  'secrets:use',
  'ai:provider',
  'ai:tool',
  'ui:contribute',
]);

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Manifesto de plugin inválido.');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Campo '${field}' inválido.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Campo '${field}' inválido.`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, maxLength);
}

function uniqueEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
): T[] {
  if (!Array.isArray(value)) throw new Error(`Campo '${field}' inválido.`);
  const output: T[] = [];
  const seen = new Set<T>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item as T)) {
      throw new Error(`Valor inválido em '${field}'.`);
    }
    const typed = item as T;
    if (!seen.has(typed)) {
      seen.add(typed);
      output.push(typed);
    }
  }
  return output;
}

function validateHomepage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Campo 'homepage' inválido.");
  }
  if (parsed.protocol !== 'https:') throw new Error("Campo 'homepage' deve usar HTTPS.");
  return parsed.toString();
}

function validateMain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Campo 'main' não pode ser absoluto.");
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error("Campo 'main' contém caminho inválido.");
  }
  return normalized;
}

export function validatePluginManifest(input: unknown): PluginManifest {
  const value = requireRecord(input);
  if (value.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Plugin API incompatível. Esperado ${PLUGIN_API_VERSION}.`);
  }

  const id = requireString(value.id, 'id', 128).toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error("Campo 'id' inválido.");

  const version = requireString(value.version, 'version', 64);
  if (!SEMVER_PATTERN.test(version)) throw new Error("Campo 'version' deve usar semver.");

  const manifest: PluginManifest = {
    apiVersion: PLUGIN_API_VERSION,
    id,
    name: requireString(value.name, 'name', 128),
    version,
    contributions: uniqueEnumArray(value.contributions ?? [], 'contributions', CONTRIBUTIONS),
    permissions: uniqueEnumArray(value.permissions ?? [], 'permissions', PERMISSIONS),
  };

  const description = optionalString(value.description, 'description', 2048);
  const publisher = optionalString(value.publisher, 'publisher', 128);
  const homepage = validateHomepage(optionalString(value.homepage, 'homepage', 2048));
  const main = validateMain(optionalString(value.main, 'main', 512));

  if (description) manifest.description = description;
  if (publisher) manifest.publisher = publisher;
  if (homepage) manifest.homepage = homepage;
  if (main) manifest.main = main;

  validatePluginContributionPermissions(manifest);
  return manifest;
}
