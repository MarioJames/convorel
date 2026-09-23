import { test, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const task =
  process.env.CONVOREL_RUNTIME_TEST_DIR ?? "/tmp/convorel-runtime-tests";
mkdirSync(task, { recursive: true });
async function setup() {
  const root = mkdtempSync(join(task, "install-"));
  const prefix = join(root, "prefix"),
    bin = join(root, "bin"),
    dist = join(root, "dist");
  const name = `convorel-9.9.9-linux-${process.arch}`;
  for (const p of [prefix, bin, dist, join(root, name, "bin")])
    mkdirSync(p, { recursive: true });
  writeFileSync(join(root, name, "bin/convorel"), "#!/bin/sh\necho 9.9.9\n", {
    mode: 0o755,
  });
  async function run(args: string[]) {
    const p = Bun.spawn(args, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: root },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { out, err, code };
  }
  const archive = join(dist, name + ".tar.gz");
  expect((await run(["tar", "-czf", archive, "-C", root, name])).code).toBe(0);
  writeFileSync(
    join(dist, "sha256sums.txt"),
    createHash("sha256").update(readFileSync(archive)).digest("hex") +
      "  " +
      name +
      ".tar.gz\n",
  );
  return {
    root,
    prefix,
    bin,
    run: (args: string[]) =>
      run([
        "bash",
        join(import.meta.dir, "../../install.sh"),
        "--prefix",
        prefix,
        "--bin-dir",
        bin,
        ...args,
      ]),
    dist,
  };
}
test("uninstall preserves unknown files within prefix and managed releases", async () => {
  const f = await setup();
  const keep = join(f.prefix, "important.txt");
  writeFileSync(keep, "user data");
  expect((await f.run(["--dist-dir", f.dist])).code).toBe(0);
  const binary = readlinkSync(join(f.bin, "convorel"));
  const extra = join(binary, "../../extra.txt");
  writeFileSync(extra, "extra data");
  expect((await f.run(["--uninstall"])).code).toBe(0);
  expect(existsSync(keep)).toBe(true);
  expect(existsSync(extra)).toBe(true);
  expect(existsSync(binary)).toBe(false);
  expect(existsSync(join(f.bin, "convorel"))).toBe(false);
});
test("uninstall of an unverified prefix leaves files and handmade links intact", async () => {
  const f = await setup();
  const keep = join(f.prefix, "convorel");
  writeFileSync(keep, "unowned");
  symlinkSync(keep, join(f.bin, "convorel"));
  expect((await f.run(["--uninstall"])).code).toBe(0);
  expect(existsSync(keep)).toBe(true);
  expect(readlinkSync(join(f.bin, "convorel"))).toBe(keep);
});

test("uninstall keeps modified release files and replaced parent symlinks", async () => {
  const f = await setup();
  expect((await f.run(["--dist-dir", f.dist])).code).toBe(0);
  const binary = readlinkSync(join(f.bin, "convorel"));
  writeFileSync(binary, "user replacement");
  expect((await f.run(["--uninstall"])).code).toBe(0);
  expect(readFileSync(binary, "utf8")).toBe("user replacement");
  const g = await setup();
  expect((await g.run(["--dist-dir", g.dist])).code).toBe(0);
  const { renameSync } = await import("node:fs");
  const outside = join(g.root, "outside");
  renameSync(join(g.prefix, "versions"), outside);
  symlinkSync(outside, join(g.prefix, "versions"));
  const linked = readlinkSync(join(g.bin, "convorel"));
  expect((await g.run(["--uninstall"])).code).toBe(0);
  expect(existsSync(linked)).toBe(true);
  expect(readlinkSync(join(g.prefix, "versions"))).toBe(outside);
});

test("uninstall removes a fresh owned prefix across reinstalls", async () => {
  const f = await setup();
  const { rmdirSync } = await import("node:fs");
  rmdirSync(f.prefix);
  expect((await f.run(["--dist-dir", f.dist])).code).toBe(0);
  expect((await f.run(["--dist-dir", f.dist])).code).toBe(0);
  expect((await f.run(["--uninstall"])).code).toBe(0);
  expect(existsSync(f.prefix)).toBe(false);
});

test("installer refuses unknown ownership metadata without replacing it", async () => {
  const f = await setup();
  const file = join(f.prefix, ".convorel-owned");
  writeFileSync(file, "unrelated data");
  const installed = await f.run(["--dist-dir", f.dist]);
  expect(installed.code).toBe(1);
  expect(installed.err).toContain("INSTALL_OWNERSHIP_INVALID");
  expect((await f.run(["--uninstall"])).code).toBe(1);
  expect(readFileSync(file, "utf8")).toBe("unrelated data");
});
