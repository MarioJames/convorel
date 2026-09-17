# Quick start

Runnable v0.1 commands; consult validation.md for the verified environment and remaining limitations.

## Prerequisites

- Linux, Bun >= 1.3, Node >= 24 (agent-browser package requirement), Git, an installed Chrome/Chromium.
- Your own ChatGPT account and a supported model. Default model selection is `6 Pro`; another visible model can be configured for verification without automatic selection.
- For code tools: your own OpenAI tunnel, runtime key and ChatGPT developer app. Browser-only review does not need these.

From the source directory, use the bootstrap command below; it runs `bun install --frozen-lockfile`. There is no published npm package assumed by this documentation. Invoke `bun --no-env-file src/cli.ts --help` or use the package's bin after a local installation.

## Start a browser

Example for Linux; use the actual installed binary:

```bash
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/convorel-chrome" https://chatgpt.com
```

Sign in manually. Keep this profile to preserve login. Chrome 136+ requires a non-default data directory when these remote-debugging switches are used: [Chrome documentation](https://developer.chrome.com/blog/remote-debugging-port).

## Initialize

```bash
bun --no-env-file setup.ts --workspace /absolute/path/to/repo --cdp 9222
```

Configuration and task state live outside the shared repository under the user data directory. `CONVOREL_HOME` selects another private state root; never place it within an MCP-shared workspace. Use a separate state root for another configured workspace.

## Install the Agent skill

`setup` links the bundled skill into `~/.agents/skills/convorel`. It is repeatable and never replaces an unrelated file/link. The package checkout must remain available. The skill invokes its own `scripts/convorel.ts` wrapper, so neither a global npm install nor the current shell directory is required.

```bash
bun --no-env-file src/cli.ts skill install --dir /path/to/agent/skills
bun --no-env-file src/cli.ts skill uninstall --dir /path/to/agent/skills
```

Only this installation's symlink is removed by uninstall; task state, browser profiles and dependencies remain. Use `setup --skill-dir DIR` to select a different directory during bootstrap. Bun, Git and Chrome are user-managed prerequisites; missing CDP yields a nonzero doctor result while preserving the initialized configuration and installed skill.

## Browser review

```bash
bun --no-env-file src/cli.ts review start --id auth-design --prompt-file /path/to/request.md
bun --no-env-file src/cli.ts review wait --id auth-design
bun --no-env-file src/cli.ts review result --id auth-design
bun --no-env-file src/cli.ts review finish --id auth-design --run RUN_ID
```

Replace RUN_ID with the returned currentRun. `--run` pins status, result, wait and finish to that exact round. `resume` reconciles an interrupted submission with its visible request marker; it does not press Send again. `followup` explicitly starts a new round after the prior reply is complete. A repeated `start` on the same task does not send again.

`finish` closes only a verified, completed task-owned tab. Borrowed tabs remain open. It retains conversation links and results so later rounds restore the same conversation.

## Code access through a tunnel

Install the official [tunnel-client](https://github.com/openai/tunnel-client/releases/latest) using your normal tool installation policy. Create your tunnel in [Platform settings](https://platform.openai.com/settings/organization/tunnels), associate the intended ChatGPT workspace, then generate concrete local commands:

```bash
bun --no-env-file src/cli.ts tunnel instructions --tunnel-id YOUR_TUNNEL_ID
```

Create a key at [Runtime API keys](https://platform.openai.com/settings/organization/api-keys) in the organization owning the tunnel. Its identity needs Tunnels Read + Use. This is not an Admin API key. Copy `.env.example` to `.env` in the convorel installation root and set `CONVOREL_TUNNEL_API_KEY` and `CONVOREL_TUNNEL_ID`, or export them in the shell. Tunnel commands accept the ID in this order: `--tunnel-id`, environment, installation `.env`. Once configured, `--tunnel-id` can be omitted for instructions, doctor, run and recover-lock. An explicit environment value takes precedence, including an empty value. Only these two settings are read from that installation’s `.env`, regardless of the caller’s directory or configured code workspace; `.env.local` variants and variable expansion are not supported. Keep `--no-env-file` on Bun commands: convorel performs this targeted loading itself. `.env` is Git-ignored; use `chmod 600 .env`. The wrapper maps the key to the official client’s `CONTROL_PLANE_API_KEY` only in its child environment. The generated `tunnel doctor` and `tunnel run` commands use fixed stdio arguments and a private single-instance registry; no YAML profile is required. Run the client in the foreground. Do not paste the key into a chat or commit it.

In [ChatGPT Plugins](https://chatgpt.com/plugins), create a developer app, choose Connection → Tunnel, select your tunnel, and enable that app for the review conversation. Access/organization permissions are separate from Chrome login.

**Only one active tunnel-client per tunnel ID for stdio.** Stop the old process before replacing it. Separate instances/workspaces need separate tunnel IDs. An initialized client and a healthy local process are not proof that the ChatGPT workspace can call it.

First verify with a synthetic file containing a known marker: ask ChatGPT to call workspace_info and read_file; compare its reported hash/content with the local file. This is distinct from local SDK stdio testing.

See [official setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [stdio deployment limits](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md#stdio-deployment-limits).

## Recovery

`review status` reads persisted state; `review resume` observes the page without resending. A successfully saved final reply is immutable even if a later page observation fails. If a lock remains after a crash, inspect its PID/identity, then use `recover-lock`; a live owner is never displaced. For a tunnel wrapper crash use `tunnel recover-lock --tunnel-id ID`, which also refuses a surviving native child. Do not start the same tunnel outside the wrapper in parallel.

Submission failures before Send preserve the draft. Inspect it before further action. Uncertain submission must be reconciled, never blindly retried. A tab creation whose result was lost similarly needs operator inspection; the CLI will not accumulate replacement blank tabs.
