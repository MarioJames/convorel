import { statSync } from "node:fs";
import { stateDirectory } from "../paths.ts";
import { State } from "../storage/state.ts";
import type { Config } from "../config/config.ts";
import { preference } from "../config/preferences.ts";
import { WorkspaceAccess, parseRoots } from "../workspace/access.ts";

/** Lazy private-state assembly so snapshot reads never create or require live state. */
export function createStore() {
  // Reads of an independent snapshot must not create, chmod or require live state.
  const stateRoot = stateDirectory();
  let initializedStore: State | undefined;
  const getStore = () => (initializedStore ??= new State());
  const sharedRoots = (): string[] => {
    const roots = preference("mcp.roots");
    if (roots) return parseRoots(roots);
    try {
      return [getStore().read<Config>("config").workspace];
    } catch {
      return [];
    }
  };
  // Archive writes and exports land in the same private area the code tools must not
  // reach, so the shared-root assertion the browser path performs still applies. Only
  // roots that exist can expose anything, and a read never writes, so `--from` keeps
  // working after the project directory itself is gone.
  const assertOutsideSharedRoots = (path: string) => {
    const existing = sharedRoots().filter((root) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
    if (existing.length) new WorkspaceAccess(existing).assertPrivate(path);
  };
  return { stateRoot, getStore, assertOutsideSharedRoots };
}

export type StoreAccess = ReturnType<typeof createStore>;
