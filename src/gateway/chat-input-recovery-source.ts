import { AsyncLocalStorage } from "node:async_hooks";
import type { createOperatorInputRecoverySource } from "../agents/operator-run-recovery-source.js";
import { shouldComputeCommandAuthorized } from "../auto-reply/command-detection.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { NormalizedChatSendRequest } from "./server-methods/chat-send-request.js";

export const CHAT_INPUT_RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;

export type ChatInputRecoveryTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  message: PersistedUserTurnMessage;
  requestHash: string;
};

type ChatInputRecoveryAdmission = {
  target: ChatInputRecoveryTarget;
  message: PersistedUserTurnMessage;
  requestFingerprint: string;
  suppressCommandInterpretation: boolean;
};

export const chatInputRecoveryAdmission = resolveGlobalSingleton(
  Symbol.for("openclaw.chatInputRecoveryAdmission"),
  () => new AsyncLocalStorage<ChatInputRecoveryAdmission>(),
);

export function readChatInputRecoveryAdmission(
  runId: string,
): ChatInputRecoveryAdmission | undefined {
  const current = chatInputRecoveryAdmission.getStore();
  return current?.target.runId === runId ? current : undefined;
}

/** Keep only execution options; approved text and media live in the input itself. */
export function createChatInputRecovery(params: {
  request: NormalizedChatSendRequest;
  source: ReturnType<typeof createOperatorInputRecoverySource>;
}) {
  const { request, source } = params;
  // Attached-client capabilities cannot be re-created after the connection ends.
  if (
    !source ||
    request.toolBindings ||
    request.goalOperation ||
    request.turnKind !== "main" ||
    (request.systemInputProvenance && request.systemInputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const p = request.p;
  return {
    version: 1 as const,
    source,
    clientInfo: request.clientInfo,
    suppressCommandInterpretation:
      request.suppressCommandInterpretation ||
      !shouldComputeCommandAuthorized(request.inboundMessage),
    request: {
      thinking: p.thinking,
      fastMode: p.fastMode,
      fastAutoOnSeconds: p.fastAutoOnSeconds,
      timeoutMs: p.timeoutMs,
      deliver: p.deliver,
      queueMode: p.queueMode,
      replyToId: p.replyToId,
      originatingChannel: p.originatingChannel,
      originatingTo: p.originatingTo,
      originatingAccountId: p.originatingAccountId,
      originatingThreadId: p.originatingThreadId,
      systemInputProvenance: request.systemInputProvenance,
      systemProvenanceReceipt: request.systemProvenanceReceipt,
    },
  };
}
