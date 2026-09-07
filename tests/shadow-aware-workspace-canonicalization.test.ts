import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionShadowWorkspaceRuntime } from '../src/execution-shadow-workspace';
import { ShadowAwareWorkspaceRuntime } from '../src/agent/shadow-aware-workspace-runtime';
import { WorkspaceRuntime } from '../src/agent/workspace-runtime';

class CanonicalWorkspace extends WorkspaceRuntime {
  calls: Array<{ projectId: string; requestedPath: string }> = [];

  constructor() {
    super(async () => []);
  }

  override async canonicalRelativePath(projectId: string, requestedPath: string): Promise<string> {
    this.calls.push({ projectId, requestedPath });
    return `canonical/${requestedPath.replaceAll('\\', '/')}`;
  }
}

test('ShadowAwareWorkspaceRuntime delega canonicalização diretamente ao workspace base', async () => {
  const base = new CanonicalWorkspace();
  const shadows = new ExecutionShadowWorkspaceRuntime(base);
  const workspace = new ShadowAwareWorkspaceRuntime(base, shadows);

  const result = await workspace.canonicalRelativePath('project-a', 'src\\main.ts');

  assert.equal(result, 'canonical/src/main.ts');
  assert.deepEqual(base.calls, [{ projectId: 'project-a', requestedPath: 'src\\main.ts' }]);
});
