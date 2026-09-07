import type { ToolName } from '../ai/types';
import type { PermissionDecision } from './permission-runtime';

export type WorkspacePathClassification = 'normal' | 'sensitive' | 'protected';

export type WorkspacePathPolicyResult = {
  decision: PermissionDecision;
  classification: WorkspacePathClassification;
  paths: string[];
  reasons: string[];
};

const fileMutationTools = new Set<ToolName>([
  'write_file',
  'create_file',
  'replace_range',
  'replace_text',
  'replace_symbol',
  'insert_before',
  'insert_after',
  'delete_file',
  'rename_file',
]);

const sensitiveMutationTools = new Set<ToolName>([...fileMutationTools, 'git_stage']);

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function basename(value: string): string {
  const parts = normalizePath(value).split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

function isExampleEnv(name: string): boolean {
  return /^\.env(?:\.[^.]+)*\.(?:example|sample|template)$/.test(name);
}

function classifyPath(value: string): { classification: WorkspacePathClassification; reason?: string } {
  const normalized = normalizePath(value);
  const name = basename(normalized);
  if (!normalized) return { classification: 'normal' };

  if (normalized === '.git' || normalized.startsWith('.git/')) {
    return { classification: 'protected', reason: 'metadados internos do Git' };
  }

  if ((name === '.env' || name.startsWith('.env.')) && !isExampleEnv(name)) {
    return { classification: 'sensitive', reason: 'arquivo de variáveis de ambiente' };
  }

  if (normalized === '.aws/credentials' || normalized.endsWith('/.aws/credentials')) {
    return { classification: 'sensitive', reason: 'credenciais da AWS' };
  }

  if (normalized === '.config/gcloud/application_default_credentials.json' || normalized.endsWith('/.config/gcloud/application_default_credentials.json')) {
    return { classification: 'sensitive', reason: 'credenciais do Google Cloud' };
  }

  if (normalized === '.ssh' || normalized.startsWith('.ssh/') || normalized.includes('/.ssh/')) {
    return { classification: 'sensitive', reason: 'material SSH' };
  }

  if (['.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc'].includes(name)) {
    return { classification: 'sensitive', reason: 'configuração que pode conter credenciais' };
  }

  if (['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials.json'].includes(name)) {
    return { classification: 'sensitive', reason: 'arquivo de credencial ou chave privada' };
  }

  if (/\.(?:pem|key|p12|pfx)$/i.test(name)) {
    return { classification: 'sensitive', reason: 'material criptográfico' };
  }

  if (/^(?:service[-_.]?account|serviceaccount)(?:[-_.].*)?\.json$/i.test(name)) {
    return { classification: 'sensitive', reason: 'credencial de conta de serviço' };
  }

  return { classification: 'normal' };
}

function severity(decision: PermissionDecision): number {
  if (decision === 'deny') return 2;
  if (decision === 'ask') return 1;
  return 0;
}

function stronger(left: PermissionDecision, right: PermissionDecision): PermissionDecision {
  return severity(left) >= severity(right) ? left : right;
}

export class WorkspacePathPolicy {
  evaluate(tool: ToolName, paths: string[]): WorkspacePathPolicyResult {
    const normalizedPaths = paths.map((item) => item.trim()).filter(Boolean);
    let decision: PermissionDecision = 'allow';
    let classification: WorkspacePathClassification = 'normal';
    const reasons: string[] = [];

    for (const path of normalizedPaths) {
      const result = classifyPath(path);
      if (result.classification === 'normal') continue;

      const pathDecision: PermissionDecision = sensitiveMutationTools.has(tool) ? 'deny' : 'ask';
      decision = stronger(decision, pathDecision);
      if (result.classification === 'protected' || classification === 'normal') classification = result.classification;
      if (result.reason && !reasons.includes(result.reason)) reasons.push(result.reason);
    }

    return { decision, classification, paths: normalizedPaths, reasons };
  }
}
