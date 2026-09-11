# Auto CodeZ visual CI artifacts

This directory is the deterministic output location used by the Electron visual smoke flow.

GitHub Actions generates the PNG screenshots, `manifest.json`, renderer error logs and fatal diagnostics here during the `Visual Auto CodeZ` workflow. Generated files are intentionally ignored by Git so CI evidence does not create recursive commits or binary churn.

Each workflow run uploads this directory as an artifact named `auto-codez-visual-<run-id>` with a 14-day retention period.

Expected screenshots currently cover Chats, Projects, Plugins, Terminal, API Keys, Profile and every Settings category.
