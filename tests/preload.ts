import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntimePaths } from "../src/paths.ts";

// Tests get private preferences and state without changing the user's configuration.
const root = mkdtempSync(join(tmpdir(), "convorel-test-settings-"));
const previous = setRuntimePaths({
  configDir: join(root, "config"),
  stateDir: join(root, "state"),
});
afterAll(() => {
  setRuntimePaths(previous);
  rmSync(root, { recursive: true, force: true });
});
