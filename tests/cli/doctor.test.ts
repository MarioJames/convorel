import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertDoctorMcp, runDoctor } from "../../src/cli/doctor.ts";
import { setRuntimePaths } from "../../src/paths.ts";
import { writePreference } from "../../src/config/preferences.ts";
import { resetAgentBrowserInvocation } from "../../src/runtime.ts";

test("doctor verifies the current public MCP server over stdio", async () => {
  const root = mkdtempSync(join(tmpdir(), "convorel-doctor-"));
  const previous = setRuntimePaths({
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
  });
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const executable = join(root, "agent-browser");
  writeFileSync(executable, "#!/bin/sh\nprintf 'agent-browser fixture\\n'\n", {
    mode: 0o700,
  });
  writePreference("browser.executable", executable);
  resetAgentBrowserInvocation();
  let released = false,
    report: any;
  try {
    const browser: any = {
      epoch: async () => "fixture",
      tabs: async () => ({ tabs: [] }),
      release: async () => {
        released = true;
      },
    };
    const result = await runDoctor(
      { version: 1, workspace, cdp: "http://127.0.0.1:9222" },
      browser,
      [workspace],
      (value) => {
        report = value;
      },
    );
    expect(result).toBe(0);
    expect(report.localMcp.status).toBe("verified");
    expect(report.localMcp.tools.sort()).toEqual([
      "artifact",
      "capabilities",
      "exec",
      "memory",
    ]);
    expect(report.localMcp.roots).toEqual([
      expect.objectContaining({ path: workspace }),
    ]);
    expect(released).toBe(true);
  } finally {
    setRuntimePaths(previous);
    resetAgentBrowserInvocation();
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor rejects valid but unexpected public tools and roots", () => {
  const tools = ["artifact", "capabilities", "exec", "memory"].map((name) => ({
    name,
  }));
  const expected = [{ rootId: "root-id", path: "/shared" }];
  const data = { mode: "guarded", roots: expected };
  expect(() => assertDoctorMcp(tools, data, expected)).not.toThrow();
  for (const names of [tools.slice(1), [...tools, { name: "other" }]])
    expect(() => assertDoctorMcp(names, data, expected)).toThrow(
      "MCP_CONTRACT_MISMATCH",
    );
  for (const roots of [
    [],
    [{ rootId: "other", path: "/shared" }],
    [{ rootId: "root-id", path: "/other" }],
  ])
    expect(() => assertDoctorMcp(tools, { ...data, roots }, expected)).toThrow(
      "MCP_CONTRACT_MISMATCH",
    );
});
