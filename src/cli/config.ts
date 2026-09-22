import { configCommand } from "./config-command.ts";
import type { Printer } from "./args.ts";

export function runConfig(
  sub: string | undefined,
  rest: string[],
  print: Printer,
) {
  print(configCommand(sub, rest));
  return 0;
}
