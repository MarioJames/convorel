# Contributing

Use Go 1.27.4. The module is github.com/MarioJames/convorel and the executable entry point is cmd/convorel. Release targets are Linux amd64 and arm64 with CGO disabled. Direct dependencies are modernc SQLite, the official MCP Go SDK, and coder/websocket; prefer the standard library for everything else.

Keep runtime orchestration in the daemon, browser transport in cdp, page adaptation in chatgpt, run semantics in conversation, policy in workspace, and MCP framing in mcp. Preserve durable task/request identity, frozen prompts and uncertain-send safety. Archive/naming failure must not alter reply completion or grant resend permission. [Architecture](docs/architecture.md) and the [CLI contract](docs/cli.md) describe the invariants.

Before proposing changes:

```bash
gofmt -w cmd internal scripts/*.go
go vet ./...
go test ./...
go build -o /tmp/convorel ./cmd/convorel
scripts/build.sh /tmp/convorel-release
scripts/test-install.sh /tmp/convorel-release
```

`gofmt -l .` must be empty. Use unique disposable paths rather than clobbering existing /tmp artifacts. Remove build outputs after verification. Do not commit generated binaries, profiles, databases, logs or acceptance evidence. Release scripts embed installer/skill assets through a temporary Go build overlay; they do not generate tracked sources.

Tests must use t.TempDir for state, preferences and Chrome profiles and release owned processes in cleanup, including failure paths. Never use real ~/.local/share/convorel, ~/.config/convorel, browser-profiles, ~/.local/bin, or user systemd services during tests. Chrome tests use /usr/bin/google-chrome against local fixtures, skip clearly when absent, and must not contact chatgpt.com. Instant (effort 1) is the acceptance model; real reviews default to Pro. Optional remote Bun executor tests need Bun, Bubblewrap and prlimit; Convorel's source build does not need Bun or Node.

Use existing behavioral tests where they cover a change. Add regression tests for consequential state, identity, policy or output changes. Do not weaken safety checks to make a fixture pass. Full acceptance boundaries and known limits are in [validation](docs/validation.md).

VERSION supplies release versioning; scripts/build.sh produces both tarballs and sha256sums.txt. Verify install/upgrade using temporary prefixes and explicit config/state paths. Release publication uses GitHub Actions after authorized tagging; local development does not require a push or live service changes.
