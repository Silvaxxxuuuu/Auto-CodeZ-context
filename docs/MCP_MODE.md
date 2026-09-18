# Auto CodeZ MCP Mode

MCP Mode connects external AI clients to the Auto CodeZ execution platform while keeping local approval authoritative.

## Product flow

The normal user flow has four states.

### 1. Disabled

The user sees one action:

**Activate MCP**

Auto CodeZ then:

1. detects the operating system and CPU architecture;
2. checks for a compatible local MCP runtime;
3. downloads the official OpenAI tunnel-client only when needed;
4. validates the official SHA256 checksum before installation;
5. installs the runtime inside the Auto CodeZ user-data directory;
6. starts the localhost MCP Gateway;
7. runs an authenticated preflight;
8. validates the tool catalog.

The user does not need to configure PATH, ports, Bearer tokens, archives or executable locations.

### 2. Ready

The user selects the clients they want to use:

- ChatGPT
- ChatGPT Codex
- Claude
- Claude Code
- Cursor
- Windsurf

Multiple clients can be selected.

### 3. Instructions

Auto CodeZ shows only the steps required for the selected clients.

Technical connection data is hidden under **Advanced configuration**.

### 4. Operational

After onboarding, MCP Mode becomes the live operational surface.

It shows:

- connected sessions;
- tool activity;
- external client identity;
- writes waiting for local approval;
- completed operations;
- errors;
- artifacts;
- source references.

Infrastructure details stay hidden by default.

## Security model

MCP transport is never an authority boundary.

External write operations still flow through:

AI client
→ MCP transport
→ Auto CodeZ Gateway
→ AgentRuntime
→ policy and scope checks
→ local approval when required
→ execution
→ operation_status

PluginToolCatalog remains authoritative for plugin tools.

The Gateway binds to localhost when used locally. Secure MCP Tunnel opens an outbound connection and does not expose the local MCP server directly to the public internet.

Secrets are not written to the operational ledger.

## Managed tunnel runtime

Current validated tunnel-client baseline:

- version: 0.0.14
- MCP protocol baseline: 2026-07-28

Managed runtime location:

`<Auto CodeZ userData>/runtime/mcp/tunnel-client/0.0.14/`

Auto CodeZ prefers a validated managed runtime. A compatible tunnel-client already available on PATH can also be used.

When Auto CodeZ downloads the runtime it:

1. requests the exact release checksum manifest;
2. downloads the platform archive from the official OpenAI GitHub release;
3. validates SHA256;
4. extracts into a temporary directory;
5. validates `tunnel-client --version`;
6. copies the executable into the managed runtime directory;
7. validates the installed executable again;
8. removes temporary files.

Supported initial targets:

- Windows x64
- Windows arm64
- macOS x64
- macOS arm64
- Linux x64
- Linux arm64

## ChatGPT

For a private local Auto CodeZ server, ChatGPT currently uses Secure MCP Tunnel.

The user-facing steps are intentionally short:

1. Enable Developer Mode in ChatGPT.
2. Open Plugins.
3. Press +.
4. Create an Auto CodeZ connection.
5. Choose Tunnel.
6. Select or enter the tunnel associated with the user's workspace.

The Auto CodeZ app handles the local server, runtime, preflight and approval system.

Do not hard-code product-plan assumptions. Detect real capabilities exposed to the user's account and workspace.

Official references:

- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## ChatGPT Codex

Codex supports MCP configuration shared by the ChatGPT desktop app, Codex CLI and IDE extension through the Codex MCP configuration.

Official reference:

- https://developers.openai.com/docs/extend/mcp

Auto CodeZ should prefer a direct local connection for Codex when the stable local transport is available. Do not route local Codex through Secure MCP Tunnel unless there is a concrete reason.

## Plugin packaging

The Auto CodeZ ChatGPT/Codex plugin package should use the portable Agent Plugins format.

A portable plugin includes:

```
auto-codez/
├── plugin.json
├── skills/
│   └── auto-codez-workspace/
│       └── SKILL.md
└── assets/
```

A registered MCP connection can later be mapped through the OpenAI-specific extension metadata.

Do not invent a `plugin_asdk_app...` connection ID. It is created only after the real MCP connection is registered in ChatGPT Developer Mode.

See `docs/CHATGPT_PLUGIN.md` for the packaging workflow.

## UX rules

The primary MCP Mode must never require the user to understand:

- CPU architecture names;
- PATH;
- local ports;
- Bearer tokens;
- tunnel-client executable paths;
- Doctor CLI flags;
- MCP protocol internals.

Those belong in Advanced configuration or diagnostics.

Errors shown in the primary flow must explain what the user needs to do next. Raw spawn or IPC errors belong only in diagnostics.
