#!/usr/bin/env -S bun --no-env-file
import { main } from "./cli/main.ts";
export { main };
if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(JSON.stringify({ error: String(e) }));
    process.exitCode = 1;
  }
}
