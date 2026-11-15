# Quickstart

Install a Linux x64 or arm64 release:

```bash
curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
convorel version
convorel doctor --local
convorel setup --workspace /absolute/project
convorel service install
convorel login
```

The installer needs no sudo. It links `~/.local/bin/convorel` to a version under `~/.local/lib/convorel`. Add that bin directory to PATH if necessary. `setup` saves a managed Chrome binding with a dedicated persistent profile; it does not install a service. `service install` enables `convorel.service`; `login` opens Chrome so you can sign in. Default review use is headed Google Chrome. An externally managed browser may instead be bound with `setup --workspace PATH --cdp http://127.0.0.1:PORT`; you own its startup and login.

Global options precede the command: `convorel --config-dir PATH --state-dir PATH COMMAND`. Keep these exact directories on every invocation for an existing task. State and config must remain outside shared workspace roots. Do not run the old and new versions against the same state simultaneously. The SQLite databases are reused in place; back up private data before cutover.

## Workspace sharing

A browser conversation alone does not enable code access. Install the OpenAI Secure MCP Tunnel client separately, configure its developer app in ChatGPT, and set authorized values locally:

```bash
convorel config set tunnel.id 'tunnel_YOUR_ID'
convorel config set tunnel.apiKey 'YOUR_KEY'
convorel config set mcp.roots '["/absolute/project"]'
```

Use the actual tunnel ID and key supplied by that service. Never put credentials in prompts or a shared repository. The daemon supervises `tunnel-client`, which launches this executable as `mcp serve`. Configuration is read at daemon startup; restart `convorel.service` after changing tunnel settings. Workspace binding is a routing identity, separate from MCP permission. [Security](security.md) describes the boundary.

Optionally set `project.url` and `project.name` as a pair. New tasks snapshot preferences; later changes do not silently move existing tasks or change their project/model.

## First review

```bash
convorel list
convorel ask --id first-review --workspace /absolute/project \
  --type DES --topic 'Design review' --prompt 'Review the design and cite the relevant files.'
convorel wait --id first-review --timeout-seconds 60
convorel status --id first-review
convorel finish --id first-review
```

Use Instant (`--effort 1`) for acceptance; actual reviews default to Pro. Save the returned run ID. Exit 2 from wait means continue waiting for that same run. It does not authorize another send. `status.naming` can still be pending after a successful reply; retry finish after background naming releases the tab. A naming failure does not invalidate the reply.

## Maintenance

`convorel upgrade` verifies a release before switching the executable. `convorel skills install --target PATH` installs or updates an unmodified managed skill. `service status` reports the daemon unit. `doctor --local` checks local file shapes without a browser or daemon; `doctor` checks browser reachability; `doctor --ui` checks controls on exactly one existing ChatGPT page without sending or creating a conversation.

For an offline release installation use `bash install.sh --dist-dir DIR --prefix /absolute/prefix --bin-dir /absolute/bin`. Both tarballs and `sha256sums.txt` must come from the release build. `bash install.sh --uninstall` removes verified installed files while preserving conversation state, profiles, preferences and installed skills. Stop/uninstall the service separately with `convorel service uninstall` before removing its executable.
