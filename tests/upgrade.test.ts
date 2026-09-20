import { afterEach, expect, test } from "bun:test";
import { releaseManifest, upgrade, versionCheck } from "../src/upgrade.ts";
import pkg from "../package.json";
let server: ReturnType<typeof Bun.serve> | undefined;
const previous = process.env.CONVOREL_RELEASE_BASE_URL;
afterEach(() => {
  server?.stop(true);
  if (previous === undefined) delete process.env.CONVOREL_RELEASE_BASE_URL;
  else process.env.CONVOREL_RELEASE_BASE_URL = previous;
});
function fixture(manifest: string, observe?: (path: string) => void) {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      observe?.(new URL(request.url).pathname);
      return new Response(manifest);
    },
  });
  process.env.CONVOREL_RELEASE_BASE_URL = server.url
    .toString()
    .replace(/\/$/, "");
}
const platform = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const entry = (version: string) =>
  `${"a".repeat(64)}  convorel-${version}-${platform}.tar.gz\n`;
test("manifest resolves latest and normalizes explicit tags", async () => {
  const paths: string[] = [];
  fixture(entry("1.2.3-rc.1"), (path) => paths.push(path));
  expect((await releaseManifest("1.2.3-rc.1")).version).toBe("1.2.3-rc.1");
  expect(paths).toEqual(["/download/v1.2.3-rc.1/sha256sums.txt"]);
});
test("versionCheck reports current release", async () => {
  fixture(entry(pkg.version));
  expect(await versionCheck()).toEqual({ latest: pkg.version, upToDate: true });
});
test("rejects unsafe tags before fetching and mismatched or ambiguous manifests", async () => {
  fixture(entry("1.2.3"));
  await expect(releaseManifest("../../other")).rejects.toThrow(
    "VERSION_INVALID",
  );
  await expect(releaseManifest("1.2.4")).rejects.toThrow("VERSION_MISMATCH");
  server?.stop(true);
  fixture(entry("1.2.3") + entry("1.2.4"));
  await expect(releaseManifest()).rejects.toThrow("MANIFEST_INVALID");
});
test("rejects artifact traversal in checksums", async () => {
  fixture(entry("../../escape"));
  await expect(releaseManifest()).rejects.toThrow("MANIFEST_INVALID");
});
test("source checkout upgrade gives git pull guidance without downloading", async () => {
  await expect(upgrade()).rejects.toThrow("git pull");
});

test("installer keeps prior versions and rolls back failed activation", async () => {
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    rmSync,
    symlinkSync,
  } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "convorel-upgrade-unit-"));
  const prefix = join(root, "custom lib");
  const bin = join(root, 'bin "quoted" \\ path');
  const dist = join(root, "dist");
  mkdirSync(dist);
  async function run(args: string[]) {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { text: out + err, code };
  }
  async function artifact(
    version: string,
    failAfterMove = false,
    unsafe = false,
  ) {
    const name = `convorel-${version}-${platform}`;
    const contents = join(root, name);
    mkdirSync(join(contents, "bin"), { recursive: true });
    writeFileSync(
      join(contents, "bin/convorel"),
      `#!/bin/sh\n${failAfterMove ? 'case "$(readlink -f "$0")" in */versions/*) exit 1;; esac\n' : ""}echo ${version}\n`,
      { mode: 0o755 },
    );
    if (unsafe) symlinkSync("/bin/sh", join(contents, "bin/agent-browser"));
    else
      writeFileSync(
        join(contents, "bin/agent-browser"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
    expect(
      (
        await run([
          "tar",
          "-czf",
          join(dist, name + ".tar.gz"),
          "-C",
          root,
          name,
        ])
      ).code,
    ).toBe(0);
    const hash = createHash("sha256")
      .update(readFileSync(join(dist, name + ".tar.gz")))
      .digest("hex");
    writeFileSync(join(dist, "sha256sums.txt"), `${hash}  ${name}.tar.gz\n`);
  }
  const install = () =>
    run([
      "bash",
      new URL("../install.sh", import.meta.url).pathname,
      "--dist-dir",
      dist,
      "--prefix",
      prefix,
      "--bin-dir",
      bin,
    ]);
  try {
    await artifact("1.2.3-rc.1");
    expect((await install()).code).toBe(0);
    const first = readlinkSync(join(bin, "convorel"));
    expect(
      JSON.parse(readFileSync(join(prefix, "layout.json"), "utf8")),
    ).toEqual({ version: 1, binDir: bin });
    expect((await install()).code).toBe(0);
    const current = readlinkSync(join(bin, "convorel"));
    expect(current).not.toBe(first);
    expect(readFileSync(first, "utf8")).toContain("1.2.3-rc.1");
    await artifact("2.0.0", true);
    const failed = await install();
    expect(failed.code).not.toBe(0);
    expect(failed.text).toContain("UPGRADE_UNVERIFIED");
    expect(readlinkSync(join(bin, "convorel"))).toBe(current);
    expect(readlinkSync(join(bin, "agent-browser"))).toBe(
      current.replace(/convorel$/, "agent-browser"),
    );
    expect(readdirSync(join(prefix, "versions")).length).toBe(2);
    await artifact("3.0.0", false, true);
    expect((await install()).text).toContain("ARTIFACT_INVALID");
    expect(readlinkSync(join(bin, "convorel"))).toBe(current);
    writeFileSync(
      join(dist, "sha256sums.txt"),
      `${"0".repeat(64)}  convorel-3.0.0-${platform}.tar.gz\n`,
    );
    expect((await install()).text).toContain("CHECKSUM_MISMATCH");
    expect(readlinkSync(join(bin, "convorel"))).toBe(current);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
