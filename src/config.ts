import { installationEnv } from "./env.ts";
import { projectId } from "./chatgpt/organize.ts";

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
  read: typeof installationEnv = installationEnv,
): Config {
  const model = read("CONVOREL_MODEL")?.trim() || undefined;
  const projectUrl = read("CONVOREL_PROJECT_URL")?.trim() || undefined;
  const projectName = read("CONVOREL_PROJECT_NAME")?.trim() || undefined;
  if (!!projectUrl !== !!projectName)
    throw new Error(
      "PROJECT_CONFIG_INCOMPLETE: set both CONVOREL_PROJECT_URL and CONVOREL_PROJECT_NAME, or leave both empty",
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
