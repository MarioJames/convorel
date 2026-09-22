import type { State } from "../storage/state.ts";
import { taskLockName } from "../storage/state.ts";
import { Workspace } from "../workspace/workspace.ts";
import { conversationStatus } from "../conversation/status.ts";
import { savedResult } from "../conversation/result.ts";
import { publishTask } from "../archive/post-archive.ts";
import { required } from "../command.ts";
import type { Task } from "../conversation/types.ts";

/** The caller checks private paths before dispatching these local-state operations. */
export async function localConversationCommand(
  sub: "list" | "status" | "result",
  options: Record<string, string>,
  store: State,
  print: (value: unknown) => void,
) {
  if (sub === "list") {
    print(
      (store.tasks() as Task[]).map((task) => ({
        id: task.id,
        url: task.url,
        currentRun: task.currentRun,
        state: task.runs.at(-1)?.state,
        locked: store.isLockedActive(taskLockName(task.id)),
        summary: conversationStatus(task),
      })),
    );
    return 0;
  }
  const id = required(options, "id");
  const task = store.read<Task>("task-" + id);
  if (sub === "result") {
    const result = savedResult(task, options.run);
    print({ ...result, archive: await publishTask(store.root, id) });
    return 0;
  }
  if (options.run && options.run !== task.currentRun)
    throw new Error("STALE_RUN");
  const expected = options.workspace
    ? new Workspace(options.workspace).root
    : undefined;
  const workspaceMismatch =
    expected && expected !== task.config.workspace
      ? {
          expected,
          bound: task.config.workspace,
          recovery:
            task.runs.length === 1 &&
            task.runs[0].state === "prepared" &&
            !task.runs[0].userMessageId &&
            !task.url
              ? "rebind-workspace"
              : "inspect_saved_prompt_and_binding",
        }
      : null;
  print({
    ...task,
    summary: conversationStatus(task),
    workspaceMismatch,
    locked: store.isLockedActive(taskLockName(id)),
  });
  return workspaceMismatch ? 2 : 0;
}
