import type { PermissionDecision } from './permission-runtime';
import { WorkspacePathPolicy } from './workspace-path-policy';

export type CommandSafetyPolicyResult = {
  decision: PermissionDecision;
  reasons: string[];
  matchedPaths: string[];
};

const directMutationPatterns = [
  /(?:^|[;&|])\s*(?:rm|del|erase|move|mv|rename|ren|copy|cp)\b/i,
  /\b(?:set-content|add-content|out-file|remove-item|move-item|rename-item|copy-item|new-item)\b/i,
  /\bsed\b[^;&|]*\s-i(?:\s|$)/i,
  /(^|[^<])>>?/,
];

const rawGitMutationPattern = /\bgit(?:\.exe)?\s+(?:add|commit|checkout|switch|reset|clean|rm|mv|restore|config|update-ref|merge|rebase|cherry-pick|revert|tag)\b/i;
const shellApprovalReason = 'shell sem confinamento completo do sistema operacional';

function stronger(left: PermissionDecision, right: PermissionDecision): PermissionDecision {
  const severity = (value: PermissionDecision): number => value === 'deny' ? 2 : value === 'ask' ? 1 : 0;
  return severity(left) >= severity(right) ? left : right;
}

function candidateTokens(command: string): string[] {
  return command
    .split(/[\s"'`=<>|;&(),]+/)
    .map((token) => token.trim().replace(/^[{}]+|[{}:]+$/g, ''))
    .filter(Boolean);
}

export class CommandSafetyPolicy {
  constructor(private readonly pathPolicy = new WorkspacePathPolicy()) {}

  evaluate(command: string): CommandSafetyPolicyResult {
    const value = command.trim();
    if (!value) return { decision: 'deny', reasons: ['comando vazio'], matchedPaths: [] };

    let decision: PermissionDecision = 'ask';
    const reasons: string[] = [shellApprovalReason];
    const matchedPaths: string[] = [];
    const mutatesDirectly = directMutationPatterns.some((pattern) => pattern.test(value));

    if (rawGitMutationPattern.test(value)) reasons.push('mutação Git direta pelo shell');

    for (const token of candidateTokens(value)) {
      const readEvaluation = this.pathPolicy.evaluate('read_file', [token]);
      if (readEvaluation.classification === 'normal') continue;
      if (!matchedPaths.includes(token)) matchedPaths.push(token);

      const pathDecision: PermissionDecision = mutatesDirectly ? 'deny' : 'ask';
      decision = stronger(decision, pathDecision);
      for (const reason of readEvaluation.reasons) {
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }

    return { decision, reasons, matchedPaths };
  }
}
