# Contributing

Use Bun and the committed lockfile. Run `bun install --frozen-lockfile` and `bun run check`. Keep browser/provider code, task state and MCP access policy separate. New providers need actual acceptance evidence before they are advertised. The SQLite content archive stays a projection of task state: archive or capture outcomes surface as notices and gaps and must never change delivery, completion or retry authorization.

Tests must use disposable profiles and synthetic repositories. Never use a developer's default Chrome profile, credentials, persistent development database or account for automated CI. Real ChatGPT acceptance is explicit and interactive; do not send unattended test messages to a shared account.

Tests must isolate preferences and persistent state in disposable directories. CLI invocations use `convorel --config-dir PATH --state-dir PATH COMMAND`, with global options before the command; set required preferences with `config set` in that isolated config directory. Keep `--no-env-file` on source CLI invocations (`bun --no-env-file /path/to/convorel/src/cli.ts`) so Bun does not load ambient environment files. Convorel preferences come only from the selected configuration file.

Changes to sending, recovery, ownership or file access need behavioral regression coverage. UI fixture tests do not establish compatibility with the live ChatGPT website. Record the tested browser, agent-browser version and limits in `docs/validation.md`.

Retain upstream license notices when adapting code. Do not commit task state, conversation URLs containing private context, API keys, environment files or browser profiles.

## Releasing

Releases are standalone Linux executables built by `.github/workflows/release.yml`, never a manual upload. `bun run dist` produces `dist/convorel-<version>-linux-{x64,arm64}.tar.gz` plus `sha256sums.txt`; each archive carries `bin/convorel` and license notices. `agent-browser` is detected on `PATH` by `init` and is not part of the archive. `bun run test:install` builds the current platform, runs `install.sh --dist-dir`, and drives the installed executable offline; it rewrites `dist/`, so run it before `bun run dist` when both are needed.

To publish: bump `version` in `package.json` on `main`, commit, then push a tag `v<version>` (a tag containing `-` becomes a prerelease). The workflow refuses a tag that does not match `package.json`, reruns check/format/package/install acceptance, attests provenance for every artifact, and creates the GitHub Release with an install snippet and checksums. `install.sh` resolves `latest` through `sha256sums.txt`, so every release must ship that file. Rerunning the workflow on the same tag replaces the assets.

## Skill metadata

Follow the same metadata convention as skill-foundry: keep the directory and `SKILL.md` frontmatter `name` as the lowercase, hyphenated installation/invocation identifier (`chatgpt-review`), and use an English title with spaces in `agents/openai.yaml` → `interface.display_name` (`ChatGPT Review`). Write frontmatter `description`, `interface.short_description`, and `interface.default_prompt` in Chinese, preserving technical names, the `$chatgpt-review` reference, and existing invocation policy. Ship `agents/openai.yaml` with the skill so consumers receive its display metadata.
