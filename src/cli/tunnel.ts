import {
  recoverTunnelLock,
  runTunnel,
  tunnelInstructions,
} from "../service/tunnel.ts";
import { preference } from "../config/preferences.ts";
import type { Config } from "../config/config.ts";
import { opts, rejectUnknown, type Printer } from "./args.ts";

export async function runTunnelArea(
  sub: string | undefined,
  rest: string[],
  config: Config,
  roots: string[],
  print: Printer,
) {
  const o = opts(rest);
  if (!["instructions", "recover-lock", "run", "doctor"].includes(sub ?? ""))
    throw new Error("UNKNOWN_TUNNEL_COMMAND");
  rejectUnknown("tunnel", Object.keys(o), ["tunnel-id"]);
  const id = o["tunnel-id"] ?? preference("tunnel.id");
  if (!id)
    throw new Error(
      "TUNNEL_ID_MISSING: pass --tunnel-id, or set tunnel.id with convorel config set tunnel.id",
    );
  if (sub === "instructions") {
    print(tunnelInstructions(id, config.workspace, roots));
    return 0;
  }
  if (sub === "recover-lock") {
    print(recoverTunnelLock(id, config.workspace));
    return 0;
  }
  if (sub === "run" || sub === "doctor")
    return runTunnel(sub, id, config.workspace, roots);
  throw new Error("UNKNOWN_TUNNEL_COMMAND");
}
