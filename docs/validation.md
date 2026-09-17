# Validation — 2026-09-17

Environment: Linux, Bun 1.4.2, Node 24.21.0, installed Google Chrome and packaged agent-browser 0.34.0. No published npm package or hosted service is assumed.

## Local verification

- `bun run check`: TypeScript and 72 behavior tests passed. Coverage includes environment precedence and empty overrides, new-task snapshots versus existing-task preferences, future Latest Pro versions and slider ranges, model drift before Send, delayed controls, exact-message URL recovery, single-watcher ownership and cancellation, title-only organization, project identity checks before moving, partial organization progress, installation conflict preservation, and the existing MCP/state/workspace boundaries.
- `bun run test:package`: a real tarball was installed into paths containing spaces. The installed CLI ran from another working directory; bundled skill files and all references matched the artifact. The actual Skills CLI installed to Codex and Claude Code under an isolated HOME without prior init. Claude resolved to the canonical skill directory. Reinstallation rejected a personal edit without overwriting it. Packaged agent-browser and SDK stdio reads also passed.
- `bun run test:browser --chrome /usr/bin/google-chrome`: disposable headless Chrome passed target binding, no implicit extra tabs, pinned-target protection, composer extraction and Send-button obstruction checks. Tab count was 1 → 2 → 1; browser/controller and temporary profile were released, and its CDP port was verified unreachable.
- Canonical skill-creator validation, reference resolution, Prettier and `git diff --check` passed. These checks establish skill structure and installation, not autonomous Agent decision quality.

## Live ChatGPT evidence and limits

The boundary review used the user's signed-in account and configured project. The reviewer verified repository identity and read source through read-only MCP, distinguishing the baseline from concurrent edits. Its findings were checked locally: new-task-only preference resolution, optional Herdr hosting, task-level watcher exclusion, pre-send model recheck, pre-move project identity checks, partial organization evidence and nonzero organization failures were implemented. Historical-result API expansion and a new cancellation framework were kept outside this change.

The submitted review exposed a timing failure where a user message appeared before the persisted conversation URL. Recovery followed the original target and exact submitted message without resending. The full reply was persisted and consumed. Organization verified the remote creation timestamp, the built-in Shanghai date/title format and configured project; the completed owned review tab was closed with no pending organization. A reload initially returned metadata before the saved answer finished rendering; bounded readiness checking now preserves the exact answer/branch guard before continuing.

Default model selection was exercised on fresh, task-owned ChatGPT tabs. It verified the actual Latest selection, Power maximum and Pro semantics, then the closed model label. The observed version on this account was `6 Pro`; that version is not a product default. The diagnostic tabs were closed. A delayed model control observed on a fresh page was covered by a bounded readiness wait and a regression test.

A separate live no-project submission remained a draft with no uniquely observed submitted message. It is retained as `delivery_unknown`; it was not resent, overwritten, or treated as successful. The browser reported no JavaScript errors for that target, but this does not prove successful delivery or general network health. The exact task/run/target and diagnostic evidence are retained privately. No-project naming and preservation of an existing project are verified by behavior tests; a complete live no-project send/name/finish cycle is **not** claimed.

## Installation and cleanup

The bundled skill was installed locally for Codex and Claude Code and its complete contents and link target were verified. The previous personal skill was backed up outside all skill-discovery roots. The user-level Convorel executable resolves and runs from an unrelated working directory. The old skill source and install/catalog entries were removed from skill-foundry only after the replacement's installation checks passed. Private conversation history and credentials were preserved.

The coding-agent pane and review watcher lane were released. No app dev server, public tunnel, database, or shared browser process was created or removed. The signed-in shared browser and the single uncertain-delivery diagnostic draft remain for inspection. Private evidence records identify its owner, purpose and release conditions; no background watcher remains for that draft. APP_URL for the third-party adapter checks was `https://chatgpt.com/`; this is a CLI adapter change, not a local frontend release.

## Reproduce local checks

```bash
bun run check
bun run format:check
bun run test:package
bun run test:browser --chrome /path/to/installed/chrome
```
