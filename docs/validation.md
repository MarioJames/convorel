# Validation

## 2026-09-18 — conversation recovery and result review

The send adapter now locates the unique submit control structurally inside the composer form, without relying on localized button text. Behavioral regressions reproduce and cover the previous rollback from a confirmed submitted message to `prepared`, observation failures before/after submission, bounded observation-only retries and CLI completion exit semantics. A read failure cannot authorize another Send. Local status exposes saved evidence and is not a live-health claim.

The disposable real-browser fixture passed structural submission with a Chinese label, exclusion of the same composer button after switching to a Stop action, overlay obstruction, exact target ownership, composer extraction and cleanup. Its profile/browser/controller were released, and the CDP port was verified unreachable. The fixture uses a synthetic `data:text/html` page, not ChatGPT; it does not prove live-site end-to-end compatibility.

A separate read-only inspection of the signed-in, headed Chrome page at `https://chatgpt.com/` confirmed `id="composer-submit-button"`, `data-testid="send-button"`, `type="submit"` and the surrounding composer form. That new diagnostic tab restored a historical unsent diagnostic draft; it was neither edited nor sent. The page was retained with owner/purpose/release conditions in private evidence rather than discarding the draft. No JavaScript page errors were captured; the request collector had no recorded network requests, so no general network-health claim is made. No dev server, tunnel, database or shared browser process was created or stopped for this inspection.

The bundled skill now has a bounded post-development result-review mode: compare goals and accepted architecture constraints with actual outcomes; inspect implementation only when needed. Canonical skill validation passed. This establishes valid packaging/instructions, not autonomous Agent decision quality.

`bun run check` passed TypeScript and 82 behavior tests, including real SDK stdio validation of all seven MCP output schemas, both workspace-info forms, Git results and tree filtering/depth/pagination/byte and scan limits. `bun run test:package` passed tarball installation, all skill references (including result review), isolated Codex/Claude installation and packaged MCP discovery/reads. `bun run format:check` passed.

The live continuation initially rejected the previous completed turn while its message IDs had rendered before the full reply body. A subsequent read proved the saved reply ID, SHA-256 and branch still matched. The bounded readiness wait on a newly reopened saved conversation now also waits for the saved reply body/hash and final marker; the existing exact-match guard still applies at its deadline. A regression covers IDs appearing first, partial body, delayed final controls and then successful continuation. The same pending follow-up request was then submitted once and its user-message identity confirmed; the failed preflight had not created or sent a new run.

The live result review completed on the exact new run. A separate CLI process retrieved the persisted 4,493-byte reply and its SHA-256 was verified. ChatGPT judged the implementation aligned with the requested scope and found no architecture-level rework blocker; it read the architecture document, result-review reference and MCP entry point, and explicitly relied on the supplied local test summary rather than claiming to run those tests. The approved boundary remains a conversation runtime plus a review skill and read-only code tools.

The currently connected MCP endpoint was independently observed still exposing the previous six-tool/flat-workspace-info interface. This change proves the new seven-tool source and packaged stdio behavior, not deployment of the live connector or disappearance of its cached output-schema warning. No shared tunnel was restarted and no connector permissions were changed. Diagnostic evidence and the review request/result remain in private Convorel state outside the shared roots.

Organization of the assistant-owned review conversation verified its title against the remote creation timestamp and its existing project identity. `finish` closed the exact completed review tab with no organization pending; a readback confirmed its absence. The MCP Agent pane, test processes and disposable data were released. The user's shared Chrome on loopback port 9222 and the separate historical-draft diagnostic page remain; no review watcher remains. APP_URL for the live adapter acceptance was `https://chatgpt.com/`.

## 2026-09-17 — bundled skill and lifecycle baseline

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
