import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, MAX_OUT } from "../../src/workspace/workspace.ts";
import { sha } from "../../src/hash.ts";
import { textChunk } from "../../src/workspace/evidence.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "convorel-evidence-"));
  return {
    root,
    ws: new Workspace(root),
    put: (p: string, s: string | Buffer) => writeFileSync(join(root, p), s),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("file discovery and scoped literal search paginate without losing matching lines", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "src"));
    f.put("src/a.ts", "before\nneedle.*\nafter\nneedle.* again\n");
    f.put("src/b.ts", "needle.* last\n");
    f.put("src/ignored.ts", "SECRET_SENTINEL\n");
    f.put("src/.convorelignore", "ignored.ts\n");
    f.put("src/.env", "SECRET_SENTINEL\n");
    f.put("outside.txt", "needle.*\n");
    symlinkSync(join(f.root, "src/a.ts"), join(f.root, "alias.ts"));
    const found = await f.ws.find("*.ts", 12, 0, 1);
    expect(found.entries).toEqual([{ path: "src/a.ts", type: "file" }]);
    expect(found.nextOffset).toBe(1);
    expect(
      (await f.ws.find("src/*.ts", 12, found.nextOffset!, 1)).entries,
    ).toEqual([{ path: "src/b.ts", type: "file" }]);
    const ws = f.ws.subdirectory("src");
    const one = await ws.search("needle.*", {
      pattern: "*.ts",
      limit: 1,
      contextLines: 1,
    });
    expect(one.matches[0]).toMatchObject({
      path: "a.ts",
      line: 2,
      text: "needle.*",
      contextBefore: ["before"],
      contextAfter: ["after"],
    });
    const two = await ws.search("needle.*", {
      pattern: "*.ts",
      offset: one.nextOffset!,
      limit: 1,
    });
    const three = await ws.search("needle.*", {
      pattern: "*.ts",
      offset: two.nextOffset!,
      limit: 1,
    });
    expect(two.matches[0]?.line).toBe(4);
    expect(three.matches[0]?.path).toBe("b.ts");
    expect(three.nextOffset).toBeNull();
    expect(three.scanTruncated).toBe(false);
    expect((await ws.search("SECRET_SENTINEL")).matches).toEqual([]);
  } finally {
    f.close();
  }
});

test("evidence limits disclose clipped snippets, unreadable files and depth, and bound escaped UTF-8", async () => {
  const f = fixture();
  try {
    f.put("long.txt", "x".repeat(8000) + "needle" + "tail".repeat(1000));
    f.put("binary.txt", Buffer.from([0, 1, 2]));
    f.put("invalid.txt", Buffer.from([255, 254]));
    mkdirSync(join(f.root, "nested"));
    f.put("nested/other.txt", "needle");
    const result = await f.ws.search("needle", { depth: 1 });
    expect(result.matches[0]?.text).toContain("needle");
    expect(result.matches[0]?.textTruncated).toBe(true);
    expect(result.skippedFiles).toBe(2);
    expect(result.depthLimited).toBe(true);
    expect(result.truncated).toBe(true);
    f.put("escaped.txt", Array(400).fill('\t"中'.repeat(90)).join("\n"));
    const page = await f.ws.read("escaped.txt");
    expect(page.truncated).toBe(true);
    expect(page.nextStartLine).toBe(page.endLine + 1);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MAX_OUT);
    await expect(f.ws.read("invalid.txt")).rejects.toThrow("INVALID_UTF8");
    const source = '😀\t中"'.repeat(25000);
    let offset = 0,
      reconstructed = "";
    while (true) {
      const chunk = textChunk(source, offset);
      expect(Buffer.byteLength(JSON.stringify(chunk.text))).toBeLessThan(
        MAX_OUT,
      );
      reconstructed += chunk.text;
      if (chunk.nextOffset === null) break;
      expect(chunk.nextOffset).toBeGreaterThan(offset);
      offset = chunk.nextOffset;
    }
    expect(reconstructed).toBe(source);
  } finally {
    f.close();
  }
});

test("an oversized first search result fails instead of returning a non-advancing cursor", async () => {
  const f = fixture();
  try {
    const context = Array(5).fill("\x01".repeat(1000));
    f.put("control.txt", [...context, "needle", ...context].join("\n"));
    await expect(f.ws.search("needle", { contextLines: 5 })).rejects.toThrow(
      "SEARCH_ENTRY_TOO_LARGE",
    );
  } finally {
    f.close();
  }
});

test("image evidence returns exact bytes through the existing file boundary", async () => {
  const f = fixture();
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=",
      "base64",
    );
    f.put("proof.png", png);
    f.put(".env", png);
    f.put("report.svg", "<svg/>");
    symlinkSync(join(f.root, "proof.png"), join(f.root, "alias.png"));
    const result = await f.ws.image("proof.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.sha256).toBe(sha(png));
    expect(Buffer.from(result.imageData, "base64")).toEqual(png);
    for (const path of [".env", "alias.png", "../proof.png"])
      await expect(f.ws.image(path)).rejects.toThrow("ACCESS_DENIED");
    await expect(f.ws.image("report.svg")).rejects.toThrow("UNSUPPORTED_IMAGE");
    f.put("huge.png", Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
    await expect(f.ws.image("huge.png")).rejects.toThrow("FILE_TOO_LARGE");
  } finally {
    f.close();
  }
});

test("live Git file and patch pages can be fully reconstructed with identity checks", async () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", f.root, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (r.exitCode) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    f.put("a.txt", "old\n");
    f.put("b.txt", "old\n");
    git("add", ".");
    git("commit", "-qm", "base");
    f.put("a.txt", '中😀\t"\n'.repeat(12000));
    f.put("b.txt", "new\n");
    const status = await f.ws.status(0, 1);
    expect(status.nextOffset).toBe(1);
    expect((await f.ws.status(status.nextOffset!, 1)).entries[0].path).toBe(
      "b.txt",
    );
    let patchOffset = 0,
      reconstructed = "",
      patchSha = "";
    while (true) {
      const page = await f.ws.diff("unstaged", {
        limit: 1,
        patchFile: "a.txt",
        patchOffset,
      });
      expect(page.nextOffset).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MAX_OUT);
      patchSha ||= page.patchSha256;
      expect(page.patchSha256).toBe(patchSha);
      reconstructed += page.diff;
      if (page.nextPatchOffset === null) break;
      expect(page.nextPatchOffset).toBeGreaterThan(patchOffset);
      patchOffset = page.nextPatchOffset;
    }
    expect(reconstructed).toBe(
      git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--ignore-submodules=all",
        "--find-renames=1%",
        "--",
        "a.txt",
      ),
    );
    const second = await f.ws.diff("unstaged", { offset: 1, limit: 1 });
    expect(second.patchFile).toBe("b.txt");
    expect(second.nextOffset).toBeNull();
    f.put("a.txt", "changed again\n");
    expect((await f.ws.diff()).patchSha256).not.toBe(patchSha);
  } finally {
    f.close();
  }
});

test("live diff does not disclose hidden descendants when a former file becomes a directory", async () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", f.root, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (r.exitCode) throw new Error(r.stderr.toString());
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    f.put("entry", "public\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("rm", "entry");
    mkdirSync(join(f.root, "entry"));
    f.put("entry/private.key", "SECRET_SENTINEL\n");
    git("add", "-f", "entry/private.key");
    const result = await f.ws.diff("staged", { patchFile: "entry" });
    expect(result.diff).toContain("-public");
    expect(result.hidden).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("private.key");
  } finally {
    f.close();
  }
});
