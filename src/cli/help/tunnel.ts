import { page } from "./shared.ts";

const tunnel = [
  page(
    ["tunnel", "instructions"],
    ["tunnel instructions [--tunnel-id ID]"],
    "Print the tunnel-client commands for the configured project and allowed roots. Nothing is connected.",
    [
      [
        "--tunnel-id ID",
        "Overrides tunnel.id for this print. One of the two is required.",
      ],
    ],
  ),
  page(
    ["tunnel", "doctor"],
    ["tunnel doctor [--tunnel-id ID]"],
    "Run the official tunnel client's local doctor check with the saved key and allowed roots.",
    [
      [
        "--tunnel-id ID",
        "Overrides tunnel.id. One of the two is required. A local doctor success does not prove a browser tool call works.",
      ],
    ],
  ),
  page(
    ["tunnel", "run"],
    ["tunnel run [--tunnel-id ID]"],
    "Run the official tunnel client in the foreground for this state directory.",
    [["--tunnel-id ID", "Overrides tunnel.id. One of the two is required."]],
    [
      "Use start, status, logs, and stop to run the same client in the background.",
    ],
  ),
  page(
    ["tunnel", "recover-lock"],
    ["tunnel recover-lock [--tunnel-id ID]"],
    "Recover the tunnel client's own single-instance lock when its recorded process is gone.",
    [
      [
        "--tunnel-id ID",
        "Tunnel whose lock is recovered. Overrides tunnel.id. This is not the top-level recover-lock command.",
      ],
    ],
    ["A live owner is not replaced."],
  ),
];

export const tunnelPage = page(
  ["tunnel"],
  ["tunnel <command>"],
  "Print, check, run, or unlock the official tunnel client. These commands use --tunnel-id or the configured tunnel.id.",
  [],
  [],
  tunnel,
);
