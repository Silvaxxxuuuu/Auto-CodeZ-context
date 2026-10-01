import path from 'node:path';

export type McpBridgeLaunchConfig = {
  bridgeScriptPath: string;
  appArgument?: string;
};

export function resolveMcpBridgeLaunchConfig(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appRoot: string;
}): McpBridgeLaunchConfig {
  if (input.isPackaged) {
    return {
      bridgeScriptPath: path.join(input.resourcesPath, 'mcp-bridge.ps1'),
    };
  }

  const appRoot = path.resolve(input.appRoot);
  return {
    bridgeScriptPath: path.join(appRoot, 'resources', 'mcp-bridge.ps1'),
    appArgument: appRoot,
  };
}
