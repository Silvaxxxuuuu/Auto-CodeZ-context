// Legacy compatibility module.
// Approval rendering and interaction are owned by renderer.ts and chat-execution-ui.ts.
// This module intentionally installs no observers, timers, DOM mutations, or click handlers.
// Keeping it as a no-op preserves any existing import path without creating a second approval flow.
export {};
