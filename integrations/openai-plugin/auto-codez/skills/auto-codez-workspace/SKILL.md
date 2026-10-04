---
name: auto-codez-workspace
description: Use Auto CodeZ MCP tools to inspect, modify, run, test, and verify work in a local software project.
---

Use Auto CodeZ when the user asks you to work on a project connected through the Auto CodeZ MCP server.

Follow this execution discipline:

1. Inspect before changing files.
2. Reuse the current Auto CodeZ session context when available.
3. Keep file access and changes inside the project scope exposed by Auto CodeZ.
4. Prefer focused reads and focused edits over broad project rewrites.
5. Treat tool metadata and operation status as authoritative.
6. When a write operation returns waiting_approval, stop issuing dependent writes and wait for the user to approve it locally in Auto CodeZ.
7. After approval, check operation_status before assuming the write succeeded.
8. Run the smallest useful verification step after edits.
9. If verification fails, use the returned evidence to fix the issue rather than hiding or weakening the check.
10. Report the files changed, verification performed, and any remaining limitation.

Never attempt to bypass Auto CodeZ approval, path scope, permission policy, PluginToolCatalog, or execution safety.
