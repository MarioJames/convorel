# Contributing

Use Bun and the committed lockfile. Run `bun install --frozen-lockfile` and `bun run check`. Keep browser/provider code, task state and MCP access policy separate. New providers need actual acceptance evidence before they are advertised.

Tests must use disposable profiles and synthetic repositories. Never use a developer's default Chrome profile, credentials, persistent development database or account for automated CI. Real ChatGPT acceptance is explicit and interactive; do not send unattended test messages to a shared account.

Changes to sending, recovery, ownership or file access need behavioral regression coverage. UI fixture tests do not establish compatibility with the live ChatGPT website. Record the tested browser, agent-browser version and limits in `docs/validation.md`.

Retain upstream license notices when adapting code. Do not commit task state, conversation URLs containing private context, API keys, environment files or browser profiles.
