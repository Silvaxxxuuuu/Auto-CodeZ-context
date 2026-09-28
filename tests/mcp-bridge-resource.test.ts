import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveMcpBridgeLaunchConfig } from '../src/mcp-gateway/bridge-resource';

test('MCP bridge uses packaged resources without a development app argument', () => {
  const value = resolveMcpBridgeLaunchConfig({
    isPackaged: true,
    resourcesPath: 'C:\\Program Files\\Auto CodeZ\\resources',
    appRoot: 'C:\\Program Files\\Auto CodeZ\\resources\\app.asar',
  });
  assert.equal(value.bridgeScriptPath, path.join('C:\\Program Files\\Auto CodeZ\\resources', 'mcp-bridge.ps1'));
  assert.equal(value.appArgument, undefined);
});

test('MCP bridge uses project resources and app root during Electron Forge development', () => {
  const appRoot = 'C:\\Users\\User\\Desktop\\Auto CodeZ';
  const value = resolveMcpBridgeLaunchConfig({
    isPackaged: false,
    resourcesPath: 'C:\\dev\\electron\\resources',
    appRoot,
  });
  assert.equal(value.bridgeScriptPath, path.join(path.resolve(appRoot), 'resources', 'mcp-bridge.ps1'));
  assert.equal(value.appArgument, path.resolve(appRoot));
});
