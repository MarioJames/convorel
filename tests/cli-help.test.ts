import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../src/command.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "convorel-cli-help-"));
const project = join(root, "project");
mkdirSync(project);

async function run(args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      cli,
      "--config-dir",
      join(root, "config"),
      "--state-dir",
      join(root, "state"),
      ...args,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

function errorOf(stderr: string) {
  return JSON.parse(stderr).error as string;
}

test("help requests print usage and do not create private directories", async () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["help"],
    ["conversation"],
    ["conversation", "--help"],
    ["diagnostics", "--help"],
    ["config", "set", "model", "help-must-not-write", "--help"],
    ["config", "unset", "model", "--help"],
    ["version", "--check", "--help"],
    ["setup", "--workspace", project, "--cdp", "1", "--help"],
    ["doctor", "--help"],
    ["mcp", "serve", "--help"],
    ["skills", "install", "--help"],
    ["tunnel", "doctor", "--help"],
  ]) {
    const result = await run(args);
    expect(result.status, args.join(" ")).toBe(0);
    expect(result.stdout, args.join(" ")).toContain(
      "conversation wait --id ID [--run UUID] [--timeout-seconds SECONDS]",
    );
    expect(result.stdout).toContain(
      "diagnostics --task ID [--run UUID] [--fields LIST]",
    );
    expect(result.stdout).toContain(
      "[--type TYPE --topic TOPIC [--language en|zh]]",
    );
    expect(result.stdout).toContain("diagnostics.enabled");
    expect(result.stdout).toContain("browser.actionIntervalMs");
    expect(result.stdout).toContain("browser.navigationWaitMs");
    expect(result.stderr, args.join(" ")).toBe("");
  }
  expect(existsSync(join(root, "config"))).toBe(false);
  expect(existsSync(join(root, "state"))).toBe(false);
});

test("unknown and invalid command options fail before their side effects", async () => {
  expect(
    (await run(["init", "--workspace", project, "--cdp", "1"])).status,
  ).toBe(0);
  const listed = await run(["config", "list"]);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout).settings).toHaveLength(13);
  expect(
    errorOf(
      (await run(["config", "set", "diagnostics.enabled", "yes"])).stderr,
    ),
  ).toContain("INVALID_VALUE");
  expect(
    errorOf(
      (await run(["config", "set", "browser.actionIntervalMs", "0"])).stderr,
    ),
  ).toContain("INVALID_VALUE");
  expect(
    (await run(["config", "set", "browser.navigationWaitMs", "10000"])).status,
  ).toBe(0);
  const typo = await run([
    "conversation",
    "wait",
    "--id",
    "help-check",
    "--timeout-secodns",
    "60",
  ]);
  expect(typo.status).toBe(1);
  expect(errorOf(typo.stderr)).toContain(
    "Unknown wait option --timeout-secodns",
  );
  const zero = await run([
    "conversation",
    "wait",
    "--id",
    "help-check",
    "--run",
    "00000000-0000-4000-8000-000000000000",
    "--timeout-seconds",
    "0",
  ]);
  expect(zero.status).toBe(1);
  expect(errorOf(zero.stderr)).toContain("INVALID_TIMEOUT");
  expect(errorOf((await run(["doctor", "--local", "typo"])).stderr)).toContain(
    "DOCTOR_LOCAL_BOOLEAN",
  );
  expect(
    errorOf((await run(["doctor", "--unknown", "true"])).stderr),
  ).toContain("Unknown doctor option --unknown");
  expect(
    errorOf((await run(["recover-lock", "--tabs", "false"])).stderr),
  ).toContain("LOCK_SELECTOR_BOOLEAN");
  expect(
    errorOf(
      (
        await run([
          "recover-lock",
          "--task",
          "task-a",
          "--watch-task",
          "task-b",
        ])
      ).stderr,
    ),
  ).toContain("LOCK_SELECTOR_REQUIRED");
  expect(
    errorOf((await run(["conversation", "list", "--unknown", "true"])).stderr),
  ).toContain("Unknown list option --unknown");
  const created = await run([
    "conversation",
    "create",
    "--id",
    "help-check",
    "--prompt",
    "CLI verification",
    "--type",
    "DES",
    "--topic",
    "CLI verification",
    "--language",
    "zh",
  ]);
  expect(created.status).toBe(0);
  expect(
    errorOf(
      (
        await run([
          "conversation",
          "create",
          "--id",
          "help-language-only",
          "--prompt",
          "CLI verification",
          "--language",
          "zh",
        ])
      ).stderr,
    ),
  ).toContain("Missing --type");
  expect(
    errorOf(
      (
        await run([
          "conversation",
          "followup",
          "--id",
          "help-check",
          "--prompt",
          "Followup",
          "--request-id",
          "help-followup",
          "--type",
          "DES",
          "--topic",
          "Not allowed",
        ])
      ).stderr,
    ),
  ).toContain("NAMING_REQUIRES_CREATE_OR_ORGANIZE");
  const diagnostics = await run([
    "diagnostics",
    "--task",
    "help-check",
    "--fields",
    "status,complete",
  ]);
  expect(diagnostics.status).toBe(0);
  expect(JSON.parse(diagnostics.stdout)).toEqual({
    status: "ok",
    complete: false,
  });
  rmSync(root, { recursive: true, force: true });
});
