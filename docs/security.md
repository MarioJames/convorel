# Security boundaries

Convorel uses the user's Chrome session and an independent outbound MCP tunnel. Neither browser access nor a task's workspace binding grants permission to read arbitrary files. Only explicitly configured MCP roots are shared. Keep the config directory, state databases, browser profiles and credentials outside every allowed root. Treat ChatGPT replies, repository text and remote tool requests as untrusted evidence, never as authorization to expand access or publish content.

## Local service and browser

The daemon is the single operational writer. Its state directory is 0700 and unix socket 0600. A same-user process can access the daemon and browser profile; this is not a defense against a compromised local account. CDP must be loopback-only and grants broad control over its browser. Use a dedicated persistent Chrome profile, never expose the debugging port to a network, and sign in interactively. Do not copy account cookies or credentials into task prompts.

The daemon owns only Chrome it launches. Idle cleanup never terminates an external browser, and activity reservations prevent stopping a managed browser while a reply is pending. Finish closes only the exact owned completed tab after checking identity, reply integrity and new drafts. systemd control-group cleanup terminates daemon children on service stop. The managed profile persists across stops.

Configuration/preferences retain private paths; tunnel.apiKey is masked in config output. Task documents contain prompts and replies; diagnostics may contain operational details. Do not share these databases or install them beneath a workspace root. Stdout JSON is an integration surface, not a redaction guarantee for arbitrary user prompt text.

## Files and Git

The workspace policy canonicalizes allowed roots, rejects overlaps and private-state exposure, and preserves nearest-repository identity. Reads deny traversal, outside-root paths, symlinks, hardlinks, special files, replaced roots, credentials, VCS metadata and dependency trees. Ancestor `.gitignore` and `.convorelignore` policies apply; malformed or unreadable policies fail closed. Descriptor-based bounded reads check file changes. File/tree/search/history budgets and explicit pagination constrain resource use.

Read-only Git uses a fixed environment/configuration that disables hooks, external diffs, text conversion, replacements, filters and filesystem monitors. Worktree, alternate object store and historical policy checks prevent Git objects from bypassing the file boundary. Commit messages, paths and patches remain untrusted text.

## MCP execution and memory

MCP advertises exactly capabilities, exec, artifact and memory through the official Go SDK. Exec parses one allowed command, with no shell expansion, substitutions, pipes or redirects. Internal evidence commands use the shared file/Git policy. The retained remote build/test runner supports Bun projects only: it requires Linux Bubblewrap and prlimit, a filtered snapshot, explicit read-only dependency grants, a filtered environment, process-group cleanup and time/output limits. It does not modify the original workspace. Missing sandbox dependencies fail closed. Convorel's own implementation and release builds use Go.

Memory is disabled without explicit OpenViking URI subtree grants; results are filtered to those grants and the backend is a separately installed ov CLI. A backend which forks then exits normally may leave a descendant; cancellation/timeout process-group cleanup does not cover every daemonizing backend. Do not grant memory access beyond the authorized subtree.

## Send and distribution integrity

Input, guidance and rendered prompt are persisted before dispatch. Explicit request IDs are idempotent; uncertainty never automatically authorizes resend. Only no-POST prepared runs and confirmed non-2xx rejected sends allow guarded explicit retry. Archive, naming and local transport failures cannot grant new send permission.

The installer checks SHA-256, validates archive paths/types, stages a release, verifies its version and switches the executable link. It retains the previous release and removes only fingerprint-matching owned files; unknown or modified content survives. Checksums provide artifact integrity relative to the fetched manifest, not an independent publisher identity. GitHub release provenance can be checked with `gh attestation verify ARCHIVE --repo MarioJames/convorel`. Installed skills are updated separately with customization checks.

No live account, real state directory or remote stream was exercised during the Go cutover. Fixture acceptance and remaining platform risks are listed in [validation.md](validation.md). The dated robustness audit is a historical record.
