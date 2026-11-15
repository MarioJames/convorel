# Convorel 1.0

Convorel lets a coding agent hold review conversations with ChatGPT through your logged-in Google Chrome, and share an explicitly allowed workspace through a guarded MCP server. Your agent owns edits, tests, and decisions; ChatGPT provides a second opinion.

The Go executable contains a thin JSON CLI, a resident daemon, direct CDP browser control, and an MCP stdio server. Linux x64 and arm64 releases are static binaries. Chrome and a ChatGPT account with access to your selected model are required for conversations. Workspace Git queries require Git. MCP connectivity additionally requires an OpenAI Secure MCP Tunnel client and a configured ChatGPT developer app.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
convorel setup --workspace /absolute/project
convorel service install
convorel login
```

Sign in yourself in the dedicated Chrome window. Configuration is private; workspace sharing is a separate explicit choice. See [quickstart](docs/quickstart.md) for tunnel configuration and [security](docs/security.md) before granting access.

## Ask and continue

```bash
convorel ask --id design-review --workspace /absolute/project \
  --type DES --topic 'Storage boundaries' --prompt-stdin <<'PROMPT'
Review the storage design against the documented invariants. Identify blocking risks with file references.
PROMPT
convorel wait --id design-review
convorel status --id design-review
convorel followup --id design-review --request-id revision-2 \
  --prompt 'Review the revised implementation and validation evidence.'
convorel wait --id design-review
convorel finish --id design-review
```

Real reviews default to Pro (effort 5). Tests and acceptance use Instant (`--effort 1`). Save the returned `run` and use `--run` when waiting for a specific round. `wait` returns the completed Markdown immediately; background naming is reported separately by `status`. A killed wait process leaves the daemon observing. Uncertain delivery is never automatically resent.

Each command prints one JSON document and uses exit 0 for success, 1 for errors, and 2 for pending or uncertain outcomes. MCP stdio is the protocol-only exception. See [usage](docs/usage.md), the [CLI contract](docs/cli.md), and the bundled [review skill](skills/chatgpt-review/SKILL.md).

## Upgrade and data

```bash
convorel upgrade
convorel skills install --target /absolute/skills/chatgpt-review
```

The installer verifies SHA-256 and retains the active and previous release. Modified or unknown installation files survive cleanup. Skill installation preserves customizations by refusing an unmanaged or modified target. Stop all 0.9 processes before switching: 1.0 reuses `tasks.db`, `conversations.db`, and `diagnostics.db` in place, with no legacy command aliases. Preferences stay in `~/.config/convorel/preferences.json`; operational config and databases stay in `~/.local/share/convorel`.

## Develop

Use Go 1.27.4 with CGO disabled for release builds:

```bash
go build -o /tmp/convorel ./cmd/convorel
go vet ./...
go test ./...
scripts/build.sh /tmp/convorel-release
scripts/test-install.sh /tmp/convorel-release
```

Headless tests use disposable Chrome profiles and local fixtures; they do not contact ChatGPT. Optional workspace sandbox tests require Bun, Bubblewrap, and prlimit because the retained remote executor supports Bun projects. Convorel itself needs no Bun or Node runtime. See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), and [validation](docs/validation.md).

This independent community project is not an official OpenAI product. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [third-party notices](THIRD_PARTY_LICENSES.md).
