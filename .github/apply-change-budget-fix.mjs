import fs from 'node:fs';

const toolPath = 'src/agent/tool-runtime.ts';
let text = fs.readFileSync(toolPath, 'utf8');

const approvalOld = `      this.assertChangeBudget(chatId, runId, normalizedCall, diffPlan);
      const approval = this.approvals.request({ projectId, chatId, runId, permissionLevel: permission, toolCall: normalizedCall, ...(diffPlan ? { diffPlan } : {}) });
`;
const approvalNew = `      try {
        this.assertChangeBudget(chatId, runId, normalizedCall, diffPlan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.activity.emit({ type: 'action', message: \`Bloqueado pelo Change Budget: \${normalizedCall.name}\`, status: 'failed', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId, error: message, ...(diffPlan ? { diffPlan } : {}) });
        return { toolCallId: normalizedCall.id, ok: false, error: message, ...(diffPlan ? { diffPlan } : {}) };
      }
      const approval = this.approvals.request({ projectId, chatId, runId, permissionLevel: permission, toolCall: normalizedCall, ...(diffPlan ? { diffPlan } : {}) });
`;

const directOld = `    let directDiffPlan: DiffPlan | undefined;
    if (this.hasChangeBudget(chatId, runId) && this.isMutation(normalizedCall.name)) directDiffPlan = await this.preview(projectId, normalizedCall);
    this.assertChangeBudget(chatId, runId, normalizedCall, directDiffPlan);
    return this.executeNow(projectId, normalizedCall, undefined, directDiffPlan, { chatId, runId });
`;
const directNew = `    let directDiffPlan: DiffPlan | undefined;
    try {
      if (this.hasChangeBudget(chatId, runId) && this.isMutation(normalizedCall.name)) directDiffPlan = await this.preview(projectId, normalizedCall);
      this.assertChangeBudget(chatId, runId, normalizedCall, directDiffPlan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activity.emit({ type: 'action', message: \`Bloqueado pelo Change Budget: \${normalizedCall.name}\`, status: 'failed', toolCallId: normalizedCall.id, toolName: normalizedCall.name, chatId, runId, error: message, ...(directDiffPlan ? { diffPlan: directDiffPlan } : {}) });
      return { toolCallId: normalizedCall.id, ok: false, error: message, ...(directDiffPlan ? { diffPlan: directDiffPlan } : {}) };
    }
    return this.executeNow(projectId, normalizedCall, undefined, directDiffPlan, { chatId, runId });
`;

function replaceUnique(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0 || second >= 0) throw new Error(`${label} anchor is not unique.`);
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

text = replaceUnique(text, approvalOld, approvalNew, 'approval');
text = replaceUnique(text, directOld, directNew, 'direct');
fs.writeFileSync(toolPath, text, 'utf8');

const validate = `name: Validate Auto CodeZ

on:
  push:
    branches:
      - main
      - 'feature/**'
      - 'fix/**'
  pull_request:
    branches:
      - main
      - 'feature/**'
      - 'fix/**'

permissions:
  contents: read

jobs:
  validate:
    runs-on: windows-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: TypeScript validation
        run: npm run typecheck

      - name: Core tests
        run: npm test

      - name: ESLint validation
        run: npm run lint

      - name: Electron Forge package build
        run: npm run package

      - name: Electron startup smoke test
        shell: pwsh
        env:
          AUTO_CODEZ_SMOKE: '1'
        run: |
          $stdout = Join-Path $env:RUNNER_TEMP 'auto-codez-smoke.stdout.log'
          $stderr = Join-Path $env:RUNNER_TEMP 'auto-codez-smoke.stderr.log'
          $process = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -PassThru -WorkingDirectory $PWD -RedirectStandardOutput $stdout -RedirectStandardError $stderr
          Start-Sleep -Seconds 10
          if ($process.HasExited) {
            Write-Host '--- Electron smoke stdout ---'
            if (Test-Path $stdout) { Get-Content $stdout }
            Write-Host '--- Electron smoke stderr ---'
            if (Test-Path $stderr) { Get-Content $stderr }
            if ($process.ExitCode -ne 0) {
              throw "Electron smoke test exited with code $($process.ExitCode)."
            }
            throw 'Electron smoke test exited before the startup window could be verified.'
          }
          Stop-Process -Id $process.Id -Force

# Validation intentionally runs the full quality gate in order.
`;
fs.writeFileSync('.github/workflows/validate.yml', validate, 'utf8');
fs.rmSync('.github/apply-change-budget-fix.mjs', { force: true });
