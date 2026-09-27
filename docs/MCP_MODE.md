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

## Universal local connection model

The user-facing model is always **add a tool**. Auto CodeZ chooses the transport and client-specific installation path.

Local clients should prefer the Auto CodeZ packaged stdio bridge when they support command-based MCP servers. The client starts the Auto CodeZ executable with a dedicated bridge argument. The bridge:

1. requires no external Node.js, Python, PATH entry or package manager;
2. reads the active Gateway binding only from Auto CodeZ encrypted local storage;
3. forwards JSON-RPC over localhost with the ephemeral Gateway credential;
4. never writes that credential into Codex, Cursor, Claude Code or another client's config;
5. starts the normal Auto CodeZ application when needed and waits for the protected Gateway to become ready;
6. preserves the external client identity so activity and approvals remain attributable.

The same Gateway, AgentRuntime, policy layer, approval system, plugin tool catalog and operational ledger remain authoritative for every client.

Client adapters stay thin. A client-specific adapter may install a config entry, register an extension, or package a supported desktop extension, but it must not duplicate the MCP execution stack.

ChatGPT remains the remote-client exception and uses Secure MCP Tunnel when the local Auto CodeZ server must be reachable from ChatGPT.

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

The local binding broker uses OS-local IPC only. Unix sockets are restricted to mode 0600. Windows named pipes are opened with `readableAll: false`, `writableAll: false` and `exclusive: true`. Bindings received from the broker are accepted only when they point to `http://loopback:<port>/mcp` with no userinfo, query string or fragment.

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
2. Open Plugins and create an Auto CodeZ connection.
3. Choose Tunnel.
4. Return to the ChatGPT connection page in Auto CodeZ and enter the Tunnel ID shown by the user's account.
5. If no secure credential is already available in the environment, provide it in the primary ChatGPT setup card.
6. Press **Validate and connect**. Auto CodeZ prepares the local Gateway, validates the tunnel runtime and waits for the tunnel health endpoint to become ready.

The user does not need to open **Advanced configuration** to connect ChatGPT. Advanced configuration is diagnostic-only for this flow. The Auto CodeZ app handles the local server, runtime, preflight, local authentication and approval system.

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
