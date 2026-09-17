# Access and trust boundaries

## Browser

Connect only to an explicitly configured loopback CDP endpoint. CDP controls the browser; do not expose its port to the public internet. Use a dedicated persistent Chrome profile, sign in manually, and keep its cookies outside this project. The CLI does not solve login challenges or copy cookies.

The CLI only operates the selected target. Task-owned targets may be closed after completion; existing targets are borrowed. A target URL change, a draft, a newer user message or uncertain generation state prevents cleanup. Native browser interaction by a human is outside the CLI's lock; avoid editing the same tab while a CLI action is running. The final read immediately before an action reduces this race but does not create a browser transaction.

## Workspace

The MCP process has one local root chosen by its operator. Remote tool arguments cannot select an arbitrary root, execute commands, modify source or modify the disclosure policy. By default symlinks, non-regular files, `.git`, dependencies, ignored files and common credential filenames are denied. Git results use the same exclusion rules.

Add workspace-specific exclusions in a root `.convorelignore` using gitignore syntax; nested `.gitignore` files are also applied. These rules may narrow access but cannot re-enable a hard-denied credential path. Unreadable policy files fail closed.

Filename rules are not a universal secret scanner. A password written into an allowed source file can be returned. Only connect a workspace whose allowed contents may be shared with the account/workspace authorized for the tunnel. Requested file contents leave the machine as MCP responses even though the server has no public listener.

Task IDs and workspace hashes are identities, not credentials. The server does not receive a trustworthy browser conversation binding. Any authorized client of that configured MCP connector can read its permitted root. Use separate connector/tunnel instances for separate disclosure boundaries.

Local processes with the same OS account can read or change these files already. This is not a sandbox for hostile local software. File checks and bounded descriptor reads protect ordinary path/symlink mistakes; they do not promise isolation from an adversary continuously racing directory renames, mounts or Git metadata. Do not point this server at an untrusted, concurrently manipulated filesystem.

## Tunnel

Use the official OpenAI tunnel-client. Keys are passed using its documented environment variables, never stored in this package's JSON configuration, shell command arguments or logs. Stdout of `mcp serve` is exclusively MCP protocol output; diagnostics go to stderr.

Tunnels are private developer connections. Distributing this open-source package does not distribute a shared tunnel, shared login or a public ChatGPT plugin. Each operator configures their own endpoint and ChatGPT app.

## Prompts and replies

Source files, web pages, MCP outputs and reviewer replies are untrusted evidence. They cannot override local instructions, authorize shell commands, widen the shared root or request credentials. Review templates ask for source evidence and uncertainty. A model's statement that tests passed is not execution evidence.

## Reporting

Do not include credentials, private code, full browser network traces or session cookies in public issues. Report a minimal reproduction using synthetic files. No telemetry is implemented by this package. Browser/ChatGPT/tunnel providers have their own data policies.
