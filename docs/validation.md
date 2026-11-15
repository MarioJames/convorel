# Convorel 1.0 validation

The automated Go suite uses local HTTP fixtures and disposable headless `/usr/bin/google-chrome` profiles. It does not contact chatgpt.com, read real state/config/profile directories, or operate real user services. Tests/acceptance use Instant (effort 1); real reviews default to Pro.

## Reproducible checks

```bash
gofmt -l .
go vet ./...
go test ./... -count=1 -v
go build -o /tmp/convorel ./cmd/convorel
scripts/build.sh /tmp/convorel-release
scripts/test-install.sh /tmp/convorel-release
```

The full Go suite passed at cutover, including local Chrome/CDP/page/conversation tests. The two optional real-database hooks were skipped because no disposable 0.9 database copies were supplied: `TestLegacyArchiveSearchHook` and `TestLegacyDatabaseCopy`. Synthetic legacy-schema, FTS5 and preservation tests ran. A skipped hook is not proof of production-data parity.

Both static Linux x64/arm64 tarballs and sha256sums.txt were built. Offline installation with `install.sh --dist-dir` into temporary prefix/bin paths passed; the installed binary reported version 1.0.0 and ran `doctor --local` before setup. The acceptance script exercised three installations, retention of two versions, bundled skill installation through an isolated daemon, and uninstall. Shell syntax, skill frontmatter validation, formatting and whitespace checks also passed. Build outputs and temporary installation state were removed after verification.

## Acceptance mapping

| Item | Local evidence | Boundary |
| --- | --- | --- |
| A1 | `TestCLICompletedNamingFollowup`, store prompt/request-id tests | Confirms delivery and frozen input via local fixture, not live ChatGPT |
| A2 | Same CLI fixture waits for and returns exact OK Markdown | Local stream completion; no live timing guarantee |
| A3 | Delayed naming/failure fixtures preserve completed wait; authenticated metadata GET, nested sidebar and missing-save-ack regressions verify naming | Remote title UI can change |
| A4 | `TestCLIRejectedRetryFrozenPrompt` injects 403, checks postStatus and one successful frozen-prompt retry | Local fault injection |
| A5 | `TestCLIUnknownRefusesRetry`, network fault tests cut the stream before correlated input | Unknown delivery remains observe-only |
| A6 | `TestKilledWaitAndDaemonRecovery`, socket disconnect/deadline tests | Killed wait subscriber and engine restart; no live service restart |
| A7 | Hidden-form/contenteditable followup tests and two-run history | Local copies of current page shapes |
| A8 | Page self-check tests verify controls and missing Send without dispatch; doctor handler fails nonzero on failed UI report | Real logged-in profile not tested |
| A9 | `TestIdleChromeStopsAndRelaunches` uses a short threshold and a pending reply; login test verifies shared activity reservation | Managed disposable Chrome only |
| A10 | `TestFirstSendRecoveryAfterChromeDeathBeforeInput` kills Chrome before input identity, recovers through a delayed project list despite a stale sidebar, and verifies one user message; other lifecycle tests cover restart/reattachment | Local regressions do not themselves exercise systemd or remote streaming |
| A11 | Store legacy CREATE statements, unknown-field roundtrips, archive FTS5/search tests | Real-data parity requires the optional copy hooks or separate authorized acceptance |
| A12 | Real CLI MCP stdio four-tool discovery, outside-root denial, local doctor tool inventory | Remote tunnel/app connectivity not exercised |
| A13 | Review skill updated and structurally validated | Real Pro review and comparison with live page Copy remain unverified |

Separate authorized machine acceptance on 2026-11-15 passed A1–A13, including real systemd restart both during a reply and before first-send canonical identity was durable. The original 56 task documents were preserved byte-for-byte and the live/backup search count was 23. A8 used an owned, unsent diagnostic draft because the empty composer displayed Voice. A13 used one Pro review. These dated live results supplement the disposable tests; they do not guarantee future remote UI behavior.

Workspace coverage includes credential/private-state denial, traversal, symlink/hardlink/replaced roots, malformed policies, ancestor ignores, bounded tree/search/read, hardened Git/history pagination and sandboxed execution. MCP tests exercise exact tool discovery and protocol framing through the real CLI. Optional sandbox execution checks require installed Bun, Bubblewrap and prlimit; this run had no sandbox-test skips.

## Cutover repairs

Removed the TypeScript implementation/tests and Bun-only build/format tooling. Retained the Bun remote executor as an intentional product capability for shared Bun projects. Updated runtime/skill commands, background naming semantics, daemon ownership and Go build instructions. Removed the unused duplicate daemon idle policy; production uses the Chrome manager's shared policy. Replaced the placeholder unknown-RPC response with UNKNOWN_COMMAND. Wired shared-browser login and doctor handlers, added offline local doctor, and shut down the owned Chrome manager during daemon cleanup. Legacy managed browser bindings without an explicit mode retain managed semantics. Replaced a test's dependency on deleted TypeScript source with its frozen guidance content hash. Release packages now include Go/transitive license texts and THIRD_PARTY_LICENSES.md.

## Remaining risks

Long Pro streams, remote reconnect/continuation behavior and future live model/UI drift still require separate authorized acceptance. The dated systemd/data checks above are machine-specific evidence. This suite cannot establish remote platform behavior. Headless-to-interactive login switching is not implemented; interactive login expects a headed configuration. History has no pagination and oversized results return RESULT_TOO_LARGE. Prepared retries may preserve a conflicting draft and fail closed. A memory backend that daemonizes after a normal exit can leave descendants. Remote build/test execution supports Bun projects only, not Go/npm/cargo.

The dated robustness audit remains a historical record; its old implementation details are not current guarantees.
