import { homedir } from "node:os";
import {
  isAbsolute,
  relative,
  resolve,
  dirname,
  basename,
  join,
} from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import { Workspace } from "./workspace.ts";

export function fullPath(path: string) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").includes("..")
  )
    throw new Error("ACCESS_DENIED");
  const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
  if (!isAbsolute(expanded)) throw new Error("ABSOLUTE_PATH_REQUIRED");
  return resolve(expanded);
}
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("../") && !isAbsolute(rel));
};
export function parseRoots(value: string) {
  let roots: unknown;
  try {
    roots = JSON.parse(value);
  } catch {
    throw new Error("INVALID_MCP_ROOTS");
  }
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    roots.length > 16 ||
    roots.some((p) => typeof p !== "string")
  )
    throw new Error("INVALID_MCP_ROOTS");
  return roots as string[];
}
export class WorkspaceAccess {
  readonly roots: Workspace[];
  constructor(roots: string[]) {
    if (!roots.length || roots.length > 16)
      throw new Error("INVALID_MCP_ROOTS");
    this.roots = roots.map((path) => {
      const absolute = fullPath(path);
      if (realpathSync(absolute) !== absolute)
        throw new Error("SYMLINK_ROOT_DENIED");
      return new Workspace(absolute);
    });
    for (let i = 0; i < this.roots.length; i++)
      for (let j = i + 1; j < this.roots.length; j++) {
        if (
          within(this.roots[i].root, this.roots[j].root) ||
          within(this.roots[j].root, this.roots[i].root)
        )
          throw new Error("OVERLAPPING_ROOTS");
      }
    for (const root of this.roots)
      root.gitStorageCheck = (path) => this.storageAllowed(path);
  }
  file(path: string) {
    const absolute = fullPath(path);
    const workspace = this.roots.find((ws) => within(ws.root, absolute));
    if (!workspace) throw new Error("ACCESS_DENIED");
    workspace.checkRoot();
    return { workspace, path: relative(workspace.root, absolute) || "." };
  }
  directory(path: string) {
    const selected = this.file(path);
    return selected.workspace.subdirectory(selected.path);
  }
  identity(path: string) {
    const absolute = fullPath(path);
    const { workspace: root, path: rel } = this.file(absolute);
    // Keep identity discovery inside the same permission boundary as content.
    if (!root.allowed(rel)) throw new Error("ACCESS_DENIED");
    const isDirectory = lstatSync(absolute).isDirectory();
    if (!root.allowed(rel, isDirectory)) throw new Error("ACCESS_DENIED");
    let candidate = isDirectory ? absolute : dirname(absolute);
    let workspacePath = root.root;
    while (true) {
      try {
        // Inspect only the marker, never its contents or a linked Git store.
        // A worktree .git file identifies the checkout, not its common repo.
        lstatSync(join(candidate, ".git"));
        workspacePath = candidate;
        break;
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (candidate === root.root) break;
      candidate = dirname(candidate);
    }
    const project = root.subdirectory(
      relative(root.root, workspacePath) || ".",
    );
    return { rootId: root.id, workspaceId: project.id, workspacePath };
  }
  private storageAllowed(path: string) {
    try {
      const absolute = fullPath(path);
      if (realpathSync(absolute) !== absolute) return false;
      const { workspace, path: rel } = this.file(absolute);
      // Git metadata is never returned directly; validate the owning repository's policy.
      const segments = rel.split("/");
      const git = segments.indexOf(".git");
      return workspace.allowed(
        git < 0 ? rel : segments.slice(0, git).join("/") || ".",
        true,
      );
    } catch {
      return false;
    }
  }
  assertPrivate(path: string) {
    const absolute = fullPath(path);
    let existing = absolute;
    const suffix: string[] = [];
    let canonical: string;
    while (true) {
      try {
        canonical = resolve(realpathSync(existing), ...suffix);
        break;
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        suffix.unshift(basename(existing));
        existing = dirname(existing);
      }
    }
    if (
      this.roots.some(
        (ws) => within(ws.root, absolute) || within(ws.root, canonical),
      )
    )
      throw new Error("STATE_INSIDE_WORKSPACE");
  }
  async info(path?: string) {
    for (const root of this.roots) root.checkRoot();
    const roots = this.roots.map((ws) => ({
      path: ws.root,
      rootId: ws.id,
    }));
    if (!path) return { roots, mode: "live-read-only" };
    this.directory(path); // workspace_info still accepts directories only.
    const identity = this.identity(path);
    return {
      ...(await this.directory(identity.workspacePath).info()),
      ...identity,
      path: fullPath(path),
      roots,
    };
  }
}
