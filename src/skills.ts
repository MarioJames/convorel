import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { assetPath, cliScript, COMPILED } from "./runtime.ts";
import packageInfo from "../package.json";

const name = "chatgpt-review";
const manifestName = ".convorel-skill.json";
type Options = Record<string, string>;
type Bundle = { source: string; version: string };
type File = { bytes: Buffer; mode: number };
type Tree = Map<string, File>;
type Baseline = {
  version: 1;
  skill: string;
  bundleVersion: string;
  files: Record<string, string>;
};
const bundled = (): Bundle => ({
  source: assetPath("skills", name),
  version: packageInfo.version,
});
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hashes = (tree: Tree): Record<string, string> =>
  Object.assign(
    Object.create(null),
    Object.fromEntries(
      [...tree].map(([path, file]) => [path, hash(file.bytes)]),
    ),
  );
function equalHashes(a: Record<string, string>, b: Record<string, string>) {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(
      ([path, digest]) => Object.hasOwn(b, path) && b[path] === digest,
    )
  );
}

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Never follow links in either a bundle or a personal tree. */
function readTree(root: string): Tree {
  if (!stat(root)?.isDirectory())
    throw new Error(`SKILL_UNSAFE_ENTRY: ${root}`);
  const files: Tree = new Map();
  function walk(directory: string, prefix = "") {
    for (const entry of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${entry}` : entry;
      const absolute = join(directory, entry);
      const info = lstatSync(absolute);
      if (info.isDirectory()) walk(absolute, path);
      else if (info.isFile())
        files.set(path, {
          bytes: readFileSync(absolute),
          mode: info.mode & 0o777,
        });
      else throw new Error(`SKILL_UNSAFE_ENTRY: ${absolute}`);
    }
  }
  walk(root);
  return files;
}

function readBundle(bundle: Bundle) {
  const files = readTree(bundle.source);
  if (!files.has("SKILL.md") || files.has(manifestName))
    throw new Error("SKILL_BUNDLE_INCOMPLETE");
  return files;
}

function location(opts: Options, updating = false) {
  for (const key of Object.keys(opts))
    if (
      ![
        "agent",
        "scope",
        "cwd",
        "dir",
        ...(updating ? ["baseline-dir"] : []),
      ].includes(key)
    )
      throw new Error(`Unknown skills option --${key}`);
  if (opts["baseline-dir"] !== undefined && !opts["baseline-dir"])
    throw new Error("--baseline-dir requires a directory path");
  const source = assetPath("skills", name);
  if (opts.dir !== undefined) {
    if (["agent", "scope", "cwd"].some((key) => opts[key] !== undefined))
      throw new Error(
        "--dir cannot be combined with --agent, --scope or --cwd",
      );
    if (!opts.dir) throw new Error("--dir requires a directory path");
    const canonical = join(resolve(opts.dir), name);
    return {
      source,
      canonical,
      targets: [canonical],
      scope: "directory",
      agents: [] as string[],
    };
  }
  const agents = [...new Set((opts.agent || "").split(","))];
  if (
    !agents.length ||
    agents.some((a) => !["codex", "claude-code"].includes(a))
  )
    throw new Error(
      "Choose --agent codex, claude-code, or codex,claude-code; or --dir PATH",
    );
  const scope = opts.scope || "user";
  if (scope !== "user" && scope !== "project")
    throw new Error("Choose --scope user or project");
  const cwd = realpathSync(opts.cwd || process.cwd());
  const root = scope === "user" ? homedir() : cwd;
  const canonical = join(root, ".agents/skills", name);
  const links = agents.flatMap((a) =>
    a === "claude-code"
      ? [join(root, ".claude/skills", name)]
      : scope === "user"
        ? [join(root, ".codex/skills", name)]
        : [],
  );
  return {
    source,
    canonical,
    targets: [...new Set([canonical, ...links])],
    scope,
    agents,
  };
}

function assertAbsent(targets: string[]) {
  for (const target of targets)
    if (stat(target))
      throw new Error(
        `SKILL_ALREADY_EXISTS: ${target}; use skills check/update to inspect the existing skill`,
      );
}

export function skillInstallPlan(opts: Options) {
  const plan = location(opts);
  assertAbsent(plan.targets);
  return plan;
}

function readBaseline(file: File | undefined): Baseline | undefined {
  if (!file) return;
  try {
    const data = JSON.parse(file.bytes.toString("utf8"));
    if (
      data.version !== 1 ||
      data.skill !== name ||
      typeof data.bundleVersion !== "string" ||
      !data.files ||
      typeof data.files !== "object" ||
      Array.isArray(data.files)
    )
      throw new Error();
    for (const [path, digest] of Object.entries(data.files)) {
      if (
        path === manifestName ||
        path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        path.includes("\\") ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        throw new Error();
    }
    if (!Object.hasOwn(data.files, "SKILL.md")) throw new Error();
    return data;
  } catch {
    throw new Error(
      "SKILL_BASELINE_INVALID: preserve the manifest and inspect it before updating",
    );
  }
}

function lockPath(canonical: string) {
  return join(dirname(canonical), `.${name}.convorel-lock`);
}
function assertUnlocked(canonical: string) {
  const lock = lockPath(canonical);
  if (stat(lock))
    throw new Error(
      `SKILL_UPDATE_LOCKED: ${lock}; inspect owner.json and retained staged/previous trees; do not remove a live operation's lock`,
    );
}

function inspect(opts: Options, bundle: Bundle) {
  const plan = location(opts, true);
  const incoming = readBundle(bundle);
  const incomingHashes = hashes(incoming);
  const exists = !!stat(plan.canonical);
  const local = exists ? readTree(plan.canonical) : new Map<string, File>();
  const metadata = local.get(manifestName);
  let baseline = readBaseline(metadata);
  local.delete(manifestName);
  const localHashes = hashes(local);
  const conflicts: string[] = [];
  if (baseline && opts["baseline-dir"])
    throw new Error(
      "SKILL_BASELINE_EXISTS: --baseline-dir is only for legacy installations without a manifest",
    );
  if (!baseline && opts["baseline-dir"]) {
    if (
      exists &&
      realpathSync(opts["baseline-dir"]) === realpathSync(plan.canonical)
    )
      throw new Error(
        "SKILL_BASELINE_UNTRUSTED: the edited installation cannot be its own baseline",
      );
    const old = readBundle({
      source: resolve(opts["baseline-dir"]),
      version: "legacy",
    });
    baseline = {
      version: 1,
      skill: name,
      bundleVersion: "legacy",
      files: hashes(old),
    };
  }
  // An exact legacy copy can be adopted without guessing which edits are personal.
  if (!baseline && exists && equalHashes(localHashes, incomingHashes))
    baseline = {
      version: 1,
      skill: name,
      bundleVersion: bundle.version,
      files: incomingHashes,
    };
  if (exists) {
    for (const target of plan.targets.filter(
      (target) => target !== plan.canonical,
    )) {
      try {
        if (
          !lstatSync(target).isSymbolicLink() ||
          realpathSync(target) !== realpathSync(plan.canonical)
        )
          conflicts.push(target);
      } catch {
        conflicts.push(target);
      }
    }
  }
  const desired = new Map(local);
  const localChanges: string[] = [];
  const changes: string[] = [];
  if (baseline) {
    const paths = [
      ...new Set([
        ...Object.keys(baseline.files),
        ...local.keys(),
        ...incoming.keys(),
      ]),
    ].sort();
    for (const path of paths) {
      const before = Object.hasOwn(baseline.files, path)
          ? baseline.files[path]
          : undefined,
        current = localHashes[path],
        next = incomingHashes[path];
      if (current !== before) localChanges.push(path);
      if (current === before || current === next) {
        if (current !== next) changes.push(path);
        const file = incoming.get(path);
        if (file)
          desired.set(path, {
            bytes: file.bytes,
            mode: local.get(path)?.mode ?? file.mode,
          });
        else desired.delete(path);
      } else if (next !== before) conflicts.push(path);
    }
    // Individually safe paths may still collide after a file/directory transition.
    for (const path of desired.keys()) {
      const parts = path.split("/");
      for (let n = 1; n < parts.length; n++)
        if (desired.has(parts.slice(0, n).join("/"))) conflicts.push(path);
    }
  }
  const needsUpdate =
    !metadata ||
    changes.length > 0 ||
    baseline?.bundleVersion !== bundle.version ||
    !equalHashes(baseline?.files ?? {}, incomingHashes);
  const status = !exists
    ? "missing"
    : conflicts.length
      ? "conflict"
      : !baseline
        ? "unmanaged"
        : needsUpdate
          ? "update-available"
          : "current";
  return {
    plan,
    incoming,
    desired,
    local,
    metadata,
    report: {
      status,
      canUpdate: exists && !!baseline && !conflicts.length,
      paths: plan.targets,
      baselineVersion: baseline?.bundleVersion ?? null,
      bundleVersion: bundle.version,
      changes,
      localChanges,
      conflicts: [...new Set(conflicts)].sort(),
      note:
        status === "unmanaged"
          ? "No installation baseline. Supply --baseline-dir pointing to the trusted previous bundled skill directory; do not use the edited installation as its own baseline."
          : "Local-only edits are preserved. Conflicts require manual reconciliation; no force overwrite is provided.",
    },
  };
}

/** Read-only: does not create configuration, state, locks or installation directories. */
export function checkSkill(opts: Options, bundle: Bundle = bundled()) {
  assertUnlocked(location(opts, true).canonical);
  return inspect(opts, bundle).report;
}

function writeTree(root: string, files: Tree, bundle: Bundle, incoming: Tree) {
  mkdirSync(root, { mode: 0o755 });
  for (const [path, file] of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, file.bytes, { mode: file.mode });
  }
  const baseline: Baseline = {
    version: 1,
    skill: name,
    bundleVersion: bundle.version,
    files: hashes(incoming),
  };
  writeFileSync(
    join(root, manifestName),
    JSON.stringify(baseline, null, 2) + "\n",
    { mode: 0o644 },
  );
}

/** A sibling transaction directory serializes writers and retains crash recovery evidence. */
function transaction<T>(
  canonical: string,
  operation: string,
  action: (lock: string) => T,
): T {
  mkdirSync(dirname(canonical), { recursive: true, mode: 0o755 });
  const lock = lockPath(canonical);
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error: any) {
    if (error.code === "EEXIST") assertUnlocked(canonical);
    throw error;
  }
  try {
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        operation,
        canonical,
        staged: join(lock, "staged"),
        previous: join(lock, "previous"),
        startedAt: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
    return action(lock);
  } finally {
    // A retained previous tree means rollback failed; never destroy the recovery copy.
    if (!stat(join(lock, "previous")))
      rmSync(lock, { recursive: true, force: true });
  }
}

export async function installSkill(opts: Options, bundle: Bundle = bundled()) {
  const { canonical } = skillInstallPlan(opts);
  return transaction(canonical, "install", (lock) => {
    const { targets, scope, agents } = skillInstallPlan(opts);
    const files = readBundle(bundle);
    const staged = join(lock, "staged");
    writeTree(staged, files, bundle, files);
    const created: string[] = [];
    try {
      // Claim the empty destination exclusively before moving staged files into it.
      mkdirSync(canonical, { mode: 0o755 });
      created.push(canonical);
      renameSync(staged, canonical);
      for (const target of targets.filter((path) => path !== canonical)) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        symlinkSync(relative(dirname(target), canonical), target);
        created.push(target);
      }
    } catch (error) {
      for (const target of created.reverse())
        rmSync(target, { recursive: true, force: true });
      throw error;
    }
    return {
      installed: true,
      agents,
      scope,
      files: [...files.keys()],
      paths: targets,
      bundleVersion: bundle.version,
      runtime: COMPILED ? process.execPath : cliScript,
      note: "Use convorel on PATH. Runtime upgrades require an explicit skills check/update for each installation; personal edits are preserved. Skill installation does not configure browser login or code access.",
    };
  });
}

export async function updateSkill(opts: Options, bundle: Bundle = bundled()) {
  const initial = checkSkill(opts, bundle);
  if (!initial.canUpdate || initial.status === "current")
    return { ...initial, updated: false };
  const { canonical } = location(opts, true);
  return transaction(canonical, "update", (lock) => {
    const state = inspect(opts, bundle);
    if (!state.report.canUpdate || state.report.status === "current")
      return { ...state.report, updated: false };
    const staged = join(lock, "staged"),
      previous = join(lock, "previous");
    writeTree(staged, state.desired, bundle, state.incoming);
    // Catch edits made while preparing the new tree, including changes to the baseline.
    const expected = new Map(state.local);
    if (state.metadata) expected.set(manifestName, state.metadata);
    const expectedHashes = hashes(expected);
    if (!equalHashes(hashes(readTree(canonical)), expectedHashes))
      throw new Error(
        "SKILL_CHANGED_DURING_UPDATE: retry skills check after personal edits finish",
      );
    renameSync(canonical, previous);
    try {
      if (!equalHashes(hashes(readTree(previous)), expectedHashes))
        throw new Error(
          "SKILL_CHANGED_DURING_UPDATE: personal edits detected during the directory switch",
        );
      renameSync(staged, canonical);
    } catch (error) {
      try {
        renameSync(previous, canonical);
      } catch (rollback) {
        throw new Error(
          `SKILL_ROLLBACK_FAILED: ${lock}; update error: ${error}; rollback error: ${rollback}`,
        );
      }
      throw error;
    }
    rmSync(previous, { recursive: true });
    return {
      ...state.report,
      status: "current",
      updated: true,
      baselineVersion: bundle.version,
      changes: state.report.changes,
    };
  });
}
