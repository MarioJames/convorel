import { State } from "../storage/state.ts";
import type { Config } from "../config/config.ts";
import { preference } from "../config/preferences.ts";
import {
  manageService,
  serviceLogs,
  serviceStatus,
} from "../service/service.ts";
import { opts, type Printer } from "./args.ts";

const serviceCommands = ["start", "stop", "restart", "status", "logs"];

export function isServiceCommand(area: string | undefined) {
  return serviceCommands.includes(area ?? "");
}

export async function runService(area: string, args: string[], print: Printer) {
  const values = args.slice(1);
  const follow = area === "logs" && values.includes("--follow");
  const o = opts(
    follow ? values.filter((value) => value !== "--follow") : values,
  );
  for (const key of Object.keys(o))
    if (key !== "tunnel-id" && !(area === "logs" && key === "lines"))
      throw new Error(`Unknown ${area} option --${key}`);
  const id = o["tunnel-id"] ?? preference("tunnel.id");
  if (!id)
    throw new Error(
      "TUNNEL_ID_MISSING: pass --tunnel-id or configure tunnel.id",
    );
  if (area === "status") print(serviceStatus(id));
  else if (area === "logs") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      return await serviceLogs(
        id,
        Number(o.lines ?? 100),
        follow,
        controller.signal,
      );
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  } else {
    // Stopping remains possible even if the workspace or configuration has gone away.
    const config =
      area === "stop" ? undefined : new State().read<Config>("config");
    print(
      await manageService(
        area as "start" | "stop" | "restart",
        id,
        config?.workspace,
      ),
    );
  }
  return 0;
}
