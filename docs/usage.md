# Usage

The complete command and JSON surface is in [cli.md](cli.md). Commands run as `convorel [--config-dir PATH] [--state-dir PATH] COMMAND`; options selecting directories must precede the command. Use `convorel help` or `convorel COMMAND --help` for JSON help.

## Conversation lifecycle

`ask` atomically prepares and sends a first round. Supply a stable `--id`, the authorized `--workspace`, and exactly one of `--prompt TEXT`, `--prompt-file PATH`, or `--prompt-stdin`. Prompt text is bounded to 100000 bytes. Optional paired `--type`/`--topic` requests background naming. Real reviews default to Pro (effort 5); acceptance uses Instant (`--effort 1`).

```bash
convorel ask --id review-1 --request-id proposal-1 --workspace /absolute/project \
  --type DES --topic 'Persistence' --prompt-stdin <<'PROMPT'
Review this proposal against docs/architecture.md. State blockers, evidence and uncertainty.
PROMPT
convorel wait --id review-1 --run RETURNED_RUN_ID --timeout-seconds 60
```

Keep task ID, run ID, configuration/state paths and returned conversation identity together. Repeating the same task/request/input returns its original run. Reusing a key for different input or another task fails with `REQUEST_CONFLICT`; the default `initial` key is task-scoped. Never switch IDs to work around a lost CLI response.

`wait` subscribes to daemon-owned observation. It returns `reply.markdown` as soon as the exact run completes. If it times out (exit 2), call it again for the same run. Disconnecting or killing the wait process does not cancel observation. `result --id ID --run RUN` rereads a saved reply. `status` reports delivery facts, naming and tab binding. `history` reads saved run records; `list` finds tasks; `search --query TEXT` searches the private content archive. Search/list are paginated; history has an 8 MiB RPC bound and no pagination.

After consuming the preceding completed result, send a full new question with `followup --id ID --request-id UNIQUE_KEY --prompt TEXT`. It prepares and sends in the saved conversation and preserves its task configuration. `finish` safely releases an owned completed tab, preserving history and the remote conversation. It refuses active observation/naming, changed replies, conflicting identity or a new draft. Check `cleanup` and `naming`, then retry cleanup if background naming is still active.

## Delivery and recovery

| Phase | Meaning | Action |
| --- | --- | --- |
| `prepared` | No dispatched POST is recorded | Inspect preflight failure; explicit guarded `retry` can send the frozen prompt |
| `rejected` | Confirmed non-2xx POST rejection | Inspect status code; explicit `retry` is eligible |
| `delivered` | Correlated input-message receipt confirms delivery | Wait for the reply |
| `delivery_unknown` | Send may have reached the service | Observe the same run; never resend |
| `complete` | Reply completed and was saved | Consume reply, check naming/archive notices, finish |
| `failed`, `blocked`, `superseded`, legacy `lost` | Terminal outcome needing inspection | Read status/history; no automatic resend |

HTTP 200 alone does not confirm delivery. Network events and stream completion are correlated with message/conversation IDs; DOM evidence is a guarded fallback. An interrupted send intent is treated conservatively after restart. Retry preserves original input, guidance, marker and prompt hashes. Archive or naming failure never grants permission to send again.

## Daemon and browser

`convorel.service` owns a foreground `convorel daemon`, SQLite writes, Chrome, per-tab CDP sessions and the tunnel child. CLI commands use a private unix socket. Without an installed unit, a missing socket permits development auto-start; an installed unit must be started by systemd. A failed connected RPC is never replayed automatically.

Managed Chrome stops after 10 idle minutes by default (`config set browser.idleStopMinutes N`) and restarts lazily. Activity is reserved through the entire reply wait, including uncertain delivery observation. External Chrome is never stopped by Convorel. Login is interactive; use the dedicated headed profile. Tests use separate disposable headless profiles.

`diagnostics --id ID --run RUN --limit N` reads private diagnostic events. `doctor --local` stays offline and works before setup. A healthy local result is not proof of browser login or remote MCP connectivity. `doctor --ui` requires exactly one existing ChatGPT page and checks composer, send, model menu, effort slider and rename controls without submitting a message.

See [quickstart](quickstart.md) for setup, release installation, upgrade, skill distribution and service removal.
