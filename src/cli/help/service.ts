import { page, type Page } from "./shared.ts";

const service = (
  name: string,
  summary: string,
  extra: [string, string][] = [],
  notes: string[] = [],
): Page =>
  page(
    [name],
    [
      name === "logs"
        ? "logs [--tunnel-id ID] [--lines NUMBER] [--follow]"
        : `${name} [--tunnel-id ID]`,
    ],
    summary,
    [
      [
        "--tunnel-id ID",
        "Tunnel used by this command. Overrides tunnel.id. The command fails when neither is set.",
      ],
      ...extra,
    ],
    notes,
  );

export const servicePages = [
  service(
    "start",
    "Start the tunnel client in the background for one tunnel id. This is not conversation start, which sends a saved run.",
    [],
    [
      "The saved workspace is passed to the service. A second start of the same running client does not create another process.",
    ],
  ),
  service(
    "stop",
    "Stop the background tunnel client for one tunnel id. The conversation and preferences are kept.",
    [],
    [
      "Stop still runs when the saved workspace is no longer available. It stops only the client recorded for this tunnel.",
    ],
  ),
  service(
    "restart",
    "Stop the background tunnel client and start it again for the same tunnel id.",
  ),
  service(
    "status",
    "Show whether the background tunnel client for this tunnel id is running. This is not conversation status.",
  ),
  service("logs", "Show the background tunnel client's output.", [
    ["--lines NUMBER", "How many recent lines to print. Default 100."],
    [
      "--follow",
      "Keep printing new lines. The flag takes no value. SIGINT or SIGTERM stops the follow.",
    ],
  ]),
];
