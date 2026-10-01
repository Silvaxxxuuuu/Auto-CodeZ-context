# Auto CodeZ ChatGPT and Codex Plugin

This document describes how to package the Auto CodeZ experience after the real MCP connection has been validated.

## Why a plugin

The MCP server provides tools and live execution.

The plugin gives that server a stable product identity and can add reusable skills that teach ChatGPT and Codex how to use Auto CodeZ well.

The plugin should not bypass Auto CodeZ approval, policies or AgentRuntime.

## Current portable format

Use the Agent Plugins portable package format.

Minimum structure:

```
auto-codez/
├── plugin.json
└── skills/
    └── auto-codez-workspace/
        └── SKILL.md
```

Recommended structure after the registered MCP connection exists:

```
auto-codez/
├── plugin.json
├── skills/
│   └── auto-codez-workspace/
│       └── SKILL.md
├── assets/
│   ├── icon.png
│   └── logo.png
└── .app.json
```

## Step 1. Validate the real MCP connection first

Before packaging:

1. start Auto CodeZ MCP Mode;
2. complete the ChatGPT Tunnel connection;
3. confirm tools/list;
4. call a read tool;
5. call a write tool;
6. confirm the write pauses in Auto CodeZ;
7. approve locally;
8. confirm operation_status returns success.

Do not build distribution metadata around an unvalidated transport.

## Step 2. Register the MCP server in ChatGPT

In ChatGPT:

1. open Settings;
2. open Security and login;
3. enable Developer Mode;
4. open Plugins;
5. press +;
6. create the Auto CodeZ MCP connection;
7. choose Tunnel for the private local server;
8. create the connection.

After creation, ChatGPT exposes a technical connection ID in the browser URL. It starts with:

`plugin_asdk_app...`

Copy that identifier.

Never invent it.

## Step 3. Create the plugin package

The root `plugin.json` uses the portable schema:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "auto-codez",
  "version": "0.1.0",
  "description": "Use Auto CodeZ to inspect, edit, run and verify local software projects with controlled approvals.",
  "author": {
    "name": "Auto CodeZ"
  },
  "license": "MIT",
  "keywords": ["coding", "development", "mcp", "workspace", "automation"],
  "extensions": {
    "com.openai": {
      "interface": {
        "displayName": "Auto CodeZ",
        "shortDescription": "Work on local projects through Auto CodeZ.",
        "developerName": "Auto CodeZ",
        "category": "developer-tools",
        "capabilities": ["mcp", "coding", "workspace"]
      }
    }
  }
}
```

The exact OpenAI connection mapping is added only after the real `plugin_asdk_app...` ID exists.

## Step 4. Add a skill

The first skill should teach the model to use the Auto CodeZ execution model rather than issuing broad uncontrolled writes.

Example intent:

- inspect before editing;
- use session summary when continuing existing work;
- keep changes within project scope;
- use write tools only when required;
- wait for local approval when the runtime requests it;
- verify the result with tests or relevant evidence;
- report what changed and what remains.

## Step 5. Test locally

OpenAI currently supports local plugin development through a local marketplace workflow and the plugin creator tooling.

Test:

- direct prompts;
- indirect prompts;
- follow-up work;
- read-only tasks;
- write tasks requiring approval;
- failure paths;
- unsupported requests.

Do not publish until the package works against the real Auto CodeZ MCP connection.

## Official references

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/concepts/skills
- https://developers.openai.com/plugins/deploy/connect-chatgpt
