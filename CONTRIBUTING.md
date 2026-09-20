# Contributing

Use Bun and the committed lockfile. Run `bun install --frozen-lockfile` and `bun run check`. Keep browser/provider code, task state and MCP access policy separate. New providers need actual acceptance evidence before they are advertised.

Tests must use disposable profiles and synthetic repositories. Never use a developer's default Chrome profile, credentials, persistent development database or account for automated CI. Real ChatGPT acceptance is explicit and interactive; do not send unattended test messages to a shared account.

`bun test` pins every `CONVOREL_*` preference to empty through `tests/preload.ts`, because `src/env.ts` otherwise falls back to the installation's own `.env`. Set a preference inside the test that needs one.

Changes to sending, recovery, ownership or file access need behavioral regression coverage. UI fixture tests do not establish compatibility with the live ChatGPT website. Record the tested browser, agent-browser version and limits in `docs/validation.md`.

Retain upstream license notices when adapting code. Do not commit task state, conversation URLs containing private context, API keys, environment files or browser profiles.

## Skill metadata

Follow the same metadata convention as skill-foundry: keep the directory and `SKILL.md` frontmatter `name` as the lowercase, hyphenated installation/invocation identifier (`chatgpt-review`), and use an English title with spaces in `agents/openai.yaml` → `interface.display_name` (`ChatGPT Review`). Write frontmatter `description`, `interface.short_description`, and `interface.default_prompt` in Chinese, preserving technical names, the `$chatgpt-review` reference, and existing invocation policy. Ship `agents/openai.yaml` with the skill so consumers receive its display metadata.
