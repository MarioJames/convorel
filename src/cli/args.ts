import type { jsonPrinter } from "./output.ts";

export type Printer = ReturnType<typeof jsonPrinter>;

export function opts(args: string[]) {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined)
      throw new Error("Expected --option value");
    o[args[i].slice(2)] = args[i + 1];
  }
  return o;
}

export function rejectUnknown(
  command: string,
  keys: string[],
  allowed: readonly string[],
) {
  for (const key of keys)
    if (!allowed.includes(key))
      throw new Error(
        command === "start"
          ? `Unknown start option --${key}; create the prompt first`
          : `Unknown ${command} option --${key}`,
      );
}
