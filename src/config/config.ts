import { preference } from "./preferences.ts";
import { projectId } from "../browser/chatgpt/organize.ts";

export interface Config {
  version: 1;
  workspace: string;
  cdp: string;
  model?: string;
  projectUrl?: string;
  projectName?: string;
}

// Only new bindings read mutable preferences. Existing tasks retain their snapshot.
export function conversationConfig(
  base: Config,
  read: typeof preference = preference,
): Config {
  const model = read("model")?.trim() || undefined;
  const projectUrl = read("project.url")?.trim() || undefined;
  const projectName = read("project.name")?.trim() || undefined;
  if (!!projectUrl !== !!projectName)
    throw new Error(
      "PROJECT_CONFIG_INCOMPLETE: set both project.url and project.name, or leave both empty",
    );
  if (projectUrl) projectId(projectUrl);
  return {
    version: 1,
    workspace: base.workspace,
    cdp: base.cdp,
    model,
    projectUrl,
    projectName,
  };
}
