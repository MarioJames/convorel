import {
  checkSkill,
  installSkill,
  updateSkill,
} from "../distribution/skills.ts";
import { opts, type Printer } from "./args.ts";

export async function runSkills(
  sub: string | undefined,
  rest: string[],
  print: Printer,
) {
  if (sub === "install") {
    print(await installSkill(opts(rest)));
    return 0;
  }
  if (sub === "check") {
    const report = await checkSkill(opts(rest));
    print(report);
    return report.status === "current" ? 0 : 2;
  }
  if (sub === "update") {
    const report = await updateSkill(opts(rest));
    print(report);
    return report.updated || report.status === "current" ? 0 : 2;
  }
  throw new Error("UNKNOWN_SKILLS_COMMAND");
}
