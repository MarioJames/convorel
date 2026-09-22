import { sha } from "../hash.ts";
import type { Task } from "./types.ts";

/** A saved reply is readable without restoring a browser or the source workspace. */
export function savedResult(task: Task, run?: string) {
  if (run && run !== task.currentRun) throw new Error("STALE_RUN");
  const current = task.runs.find((item) => item.id === task.currentRun);
  if (!current) throw new Error("RUN_MISSING");
  if (
    current.state !== "complete" ||
    !current.reply ||
    current.replyHash !== sha(current.reply.text)
  )
    throw new Error("RESULT_NOT_COMPLETE");
  return {
    taskId: task.id,
    runId: current.id,
    url: task.url,
    reply: current.reply,
    replyHash: current.replyHash,
    userMessageId: current.userMessageId,
    branch: current.branch,
  };
}
