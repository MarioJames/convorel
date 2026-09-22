import { stateDirectory } from "../paths.ts";
import { required } from "../command.ts";
import { jsonPrinter } from "./output.ts";
import { readDiagnostics } from "../storage/diagnostics.ts";
import { opts, rejectUnknown } from "./args.ts";

export function runDiagnostics(args: string[]) {
  const o = opts(args.slice(1));
  rejectUnknown("diagnostics", Object.keys(o), ["task", "run", "fields"]);
  jsonPrinter(o.fields)(
    readDiagnostics(stateDirectory(), required(o, "task"), o.run),
  );
  return 0;
}
