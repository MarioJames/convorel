import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../src/process.ts";
import { helpTopics, renderHelp } from "../../src/cli/help/index.ts";

const cli = join(import.meta.dir, "../../src/cli.ts");
const root = mkdtempSync(join(tmpdir(), "convorel-cli-help-"));
const project = join(root, "project");
const browserBin = join(root, "bin");
mkdirSync(project);
mkdirSync(browserBin);
writeFileSync(
  join(browserBin, "agent-browser"),
  "#!/bin/sh\nprintf '%s\\n' 'agent-browser 9.9.9'\n",
  { mode: 0o755 },
);

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
      env: { ...childEnv(), PATH: browserBin },
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

test("each command help explains that command and does not create private directories", async () => {
  const rootHelp = renderHelp(["--help"])!;
  expect(rootHelp).toContain("conversation start --id ID --run UUID");
  expect(rootHelp).toContain("convorel <command> --help");
  expect(rootHelp).toContain("diagnostics.enabled");
  for (const topic of helpTopics()) {
    const text = renderHelp(topic.args);
    expect(text, topic.args.join(" ")).toContain(topic.usage);
    expect(text).not.toBe(rootHelp);
    expect(rootHelp).toContain(topic.usage);
  }
  const wait = renderHelp(["conversation", "wait", "--help"])!;
  expect(wait).toContain("at most 86400");
  expect(wait).toContain("generation in the browser continues");
  expect(wait).not.toContain("mcp serve");
  const configSet = renderHelp([
    "config",
    "set",
    "model",
    "help-must-not-write",
    "--help",
  ])!;
  expect(configSet).toContain("browser.actionIntervalMs");
  expect(configSet).not.toContain("conversation create");
  expect(renderHelp(["help", "diagnostics"])).toContain("--fields LIST");
  expect(() => renderHelp(["nope", "--help"])).toThrow("Unknown help topic");
  for (const args of [
    ["--help"],
    ["-h"],
    ["help"],
    ["conversation"],
    ["conversation", "wait", "--help"],
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
    expect(result.stderr, args.join(" ")).toBe("");
    expect(result.stdout.length, args.join(" ")).toBeGreaterThan(40);
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
