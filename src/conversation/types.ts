import type { Message, PageState } from "../browser/chatgpt/page.ts";
import type { RunControl } from "../browser/semantic.ts";
import type { ArchiveNotice } from "../archive/post-archive.ts";
import type { Config } from "../config/config.ts";
import type { DiagnosticStep } from "../storage/diagnostics.ts";
import type { PromptContext } from "./prompt.ts";

export type { DiagnosticStep };

/** One fixed-token diagnostic event; page text and exception bodies stay out. */
export type DiagnosticFailure = {
  taskId: string;
  runId: string;
  event: "observe_failed" | "operation_result";
  step: DiagnosticStep;
  code: string;
  retryable?: boolean;
};

export interface RejectedSendRecovery {
  expectedUserMessageId: string;
  expectedUrl: string;
  input: string;
  reason: string;
  evidence: unknown;
  rejectedAt: number;
  confirmCloudflareChallenge: boolean;
}
export interface Run {
  id: string;
  requestId: string;
  inputHash: string;
  /** Original request and frozen runtime guidance; absent on historical runs. */
  input?: string;
  promptContext?: PromptContext;
  prompt: string;
  promptHash: string;
  marker: string;
  state: string;
  userMessageId?: string;
  reply?: Message;
  replyHash?: string;
  branch?: string[];
  error?: string;
  createdAt: string;
  observedModel?: string;
  lastObservedAt?: string;
  observationError?: { at: string; message: string; retryable: boolean };
  submittedAt?: string;
  completionProbe?: {
    fingerprint: string;
    unchangedSince: string;
    lastRefreshedAt?: string;
    refreshes: number;
    failures: number;
    error?: string;
  };
  sendRecoveries?: {
    at: string;
    priorUserMessageId: string;
    priorAttemptId: string;
    attemptId: string;
    reason: string;
    target: string;
    url: string;
    priorError?: string;
    evidence: {
      method: string;
      url: string;
      status: number;
      timestamp: number;
    };
    confirmedCloudflareChallenge: true;
  }[];
  draftRecovery?: {
    draft: string;
    hash: string;
    target: string;
    at: string;
    cleared: boolean;
  };
}
export interface Binding {
  target: string;
  epoch: string;
  owned: boolean;
  closed?: boolean;
  opening?: boolean;
}
export interface Naming {
  type: string;
  topic: string;
  language?: "en" | "zh";
}
export interface Task {
  version: 1;
  id: string;
  config: Config;
  workspaceId: string;
  url?: string;
  binding?: Binding;
  /** Former main targets left untouched after navigation away from this task. */
  detachedBindings?: (Binding & { reason: "navigated" | "blank" })[];
  opening?: boolean;
  pageRecreations?: number;
  currentRun: string;
  attemptId: string;
  runs: Run[];
  naming?: Naming;
  organization?: any;
  organizationObservation?: {
    epoch: string;
    target?: string;
    opening?: boolean;
    closed?: boolean;
    ownershipExpired?: boolean;
    transferredToMain?: boolean;
    error?: string;
  };
  cleanup?: any;
  /** Outcome of this operation only; never persisted as source state. */
  archive?: ArchiveNotice;
  workspaceBindingChange?: {
    from: string;
    to: string;
    at: string;
    priorPrompt?: string;
    priorPromptHash?: string;
  };
}
/** The page handle Browser.page() attaches to one target. Control-aware
 * adapters resolve fresh semantic refs after their checked preflight. */
export interface Page {
  runControl?: RunControl;
  session: string;
  run: (...args: string[]) => Promise<any>;
  runChecked: (
    args: string[],
    beforeDispatch: () => Promise<void>,
  ) => Promise<any>;
  read: () => Promise<PageState>;
}
/** The result of one Markdown-copy attempt; ok=false carries a reason code. */
export type CaptureAttempt = { ok: boolean; reason?: string };
