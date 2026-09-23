# Access and trust boundaries

## Browser

Connect only to an explicitly configured loopback CDP endpoint. CDP controls the browser; do not expose its port to the public internet. Use a dedicated persistent Chrome profile, sign in manually, and keep its cookies outside this project. The CLI does not solve login challenges or copy cookies.

The CLI only operates the selected target. Task-owned targets may be closed after completion; existing targets are borrowed. A target URL change, a draft, a newer user message or uncertain generation state prevents cleanup. Native browser interaction by a human is outside the CLI's lock; avoid editing the same tab while a CLI action is running. Owned-page close revalidates identity, current user turn, activity and last-tab protection after action pacing, immediately before dispatch. This reduces the race but does not create a browser transaction.

## Workspace

The MCP process has a fixed allowlist of local roots chosen by its operator through the `mcp.roots` configuration key (a JSON array). Without an explicit allowlist, only the directory saved by init is permitted. Remote tool arguments can select only the guarded operations described by capabilities; they cannot select an arbitrary root, execute arbitrary host commands, modify host source or modify the disclosure policy. By default symlinks, non-regular files, `.git`, dependencies, ignored files and common credential filenames are denied. Git results use the same exclusion rules.

Add workspace-specific exclusions in a root `.convorelignore` using gitignore syntax; nested `.gitignore` files are also applied. These rules may narrow access but cannot re-enable a hard-denied credential path. Unreadable, invalid UTF-8 or binary policy files fail closed. Git object storage is also checked for internal symlinks, hardlinks and special files; metadata scans are bounded at 200,000 entries, depth 8 and two seconds. Oversized loose-object stores are rejected explicitly rather than partly checked.

Filename rules are not a universal secret scanner. A password written into an allowed source file can be returned. Only connect a workspace whose allowed contents may be shared with the account/workspace authorized for the tunnel. Requested file contents leave the machine as MCP responses even though the server has no public listener.

Task IDs and workspace hashes are identities, not credentials. The server does not receive a trustworthy browser conversation binding. Any authorized client of that configured MCP connector can read all its permitted roots. Requests use full paths; path hashes identify observations but are not authorization tokens. Use separate connector/tunnel instances for separate disclosure boundaries.

Local processes with the same OS account can read or change these files already. This is not a sandbox for hostile local software. File checks and bounded descriptor reads protect ordinary path/symlink mistakes; they do not promise isolation from an adversary continuously racing directory renames, mounts or Git metadata. Do not point this server at an untrusted, concurrently manipulated filesystem.

## Tunnel

Use the official OpenAI tunnel-client. Store `tunnel.apiKey` and `tunnel.id` with `convorel config set`; preferences are saved in a private 0600 file, by default `~/.config/convorel/preferences.json`. Convorel reads configuration only from this file, with no environment override. `--tunnel-id` overrides the configured ID for that command. Keep preferences and task state outside every shared MCP root; neither may contain a shared root either. The key is redacted by config output and mapped to the official client’s `CONTROL_PLANE_API_KEY` only in its child environment; it is not written into prompts, task documents or logs. Avoid exposing the key through shell history when configuring it. Stdout of `mcp serve` is exclusively MCP protocol output; diagnostics go to stderr.

Tunnels are private developer connections. Distributing this open-source package does not distribute a shared tunnel, shared login or a public ChatGPT plugin. Each operator configures their own endpoint and ChatGPT app.

## Prompts and replies

Source files, web pages, MCP outputs and reviewer replies are untrusted evidence. They cannot override local instructions, authorize shell commands, widen the shared root or request credentials. Convorel adds generic workspace/tool guidance to each new run, preserving the original task request and rendered text. It does not add a business persona or elevate the message to a system role. The caller owns task-specific evidence requirements and response interpretation. Prompt text is not a security boundary: MCP policy and backend permissions remain authoritative. A model's statement that tests passed is not execution evidence.

Completed turns are additionally archived in `conversations.db` under the private state directory: saved prompt sources, the Markdown copied from each reply, immutable content versions and search indexes. Captured Markdown comes from the page's own copy control, so it is retained model output, not verified fact; archived text is evidence about what was said, never an instruction. The archive lives outside every MCP root and is not readable through the code tools. `conversation export` copies all archived prompts and replies into a directory you choose, which is a disclosure decision: treat the snapshot as sensitive data, and never export inside an allowed root. The archive is not a second credential store and holds no cookies, keys or browser traces.

## Reporting

Do not include credentials, private code, full browser network traces or session cookies in public issues. Report a minimal reproduction using synthetic files. No telemetry is implemented by this package. Browser/ChatGPT/tunnel providers have their own data policies.

Child repository selection inherits ancestor ignore rules and root identity checks. Out-of-scope paths, traversal, symlink roots, and overlapping configured roots are rejected. Private task/tunnel state must remain outside every allowed root. Root changes require restarting the tunnel; capabilities exposes the selected path identity and revision for callers to verify.

Git metadata (gitdir, common-dir and objects) must stay within the same allowlist and cannot use symlink indirection. Git worktrees are supported when those sources are permitted. Object alternates and HTTP alternates are rejected; inherited GIT\_\* location overrides are not passed to Git.

Historical Git tools also apply the current file policy and the ignore files at the relevant commits; deleting a historical ignore file does not make its formerly excluded content readable through that comparison. Revisions are resolved before use and replacement objects are disabled. Commit messages and ordinary permitted source remain shareable text, not secret-scanned content. Image reads use the same bounded descriptor and path policy, return only supported raster formats, and do not open external URLs or execute SVG. Evidence artifacts must be explicitly placed in an already allowed location; private conversation/tunnel state is never exposed as a report store.

Task execution state and prompts live in private `tasks.db` (0600, WAL sidecars 0600, state directory 0700). Prefer stdin over command-line prompt arguments when shell history/process arguments could disclose content. The database is outside shared MCP roots. Legacy task migration retains the original private JSON evidence; database and archive must be backed up through SQLite-aware consistent backups, not raw copies of live files.
