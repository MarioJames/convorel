declare const BUILD_COMMIT: string;
import { agentBrowserLocation, COMPILED } from "../runtime.ts";
import { upgrade, versionCheck } from "../distribution/upgrade.ts";
import packageInfo from "../../package.json";
import { opts, type Printer } from "./args.ts";

export async function runVersion(
  area: string | undefined,
  sub: string | undefined,
  rest: string[],
  print: Printer,
) {
  if (
    rest.length ||
    (sub !== undefined && !(area === "version" && sub === "--check"))
  )
    throw new Error("Expected version [--check] or --version");
  if (area === "--version") console.log(packageInfo.version);
  else
    print({
      version: packageInfo.version,
      commit:
        typeof BUILD_COMMIT === "string" ? BUILD_COMMIT : "source checkout",
      runtime: COMPILED ? "standalone" : `bun ${Bun.version}`,
      architecture: process.arch,
      browserController: agentBrowserLocation(),
      ...(sub === "--check" ? await versionCheck() : {}),
    });
  return 0;
}

export async function runUpgrade(args: string[], print: Printer) {
  const o = opts(args.slice(1));
  for (const key of Object.keys(o))
    if (key !== "version") throw new Error(`Unknown upgrade option --${key}`);
  if (o.version !== undefined && !o.version)
    throw new Error("Missing --version");
  print(await upgrade(o.version));
  return 0;
}
