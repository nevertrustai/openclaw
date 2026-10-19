import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, vi } from "vitest";
import { getRuntimeConfig as getHostRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import type { resolveSessionMutationAuthorization } from "./session-sharing.js";
import {
  getGatewayConfigModule,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

export async function activeRunContext(params: {
  runId: string;
  sessionId: string;
  sessionKey: string;
  persistence: ReturnType<typeof createDeferredCore<void>>;
  ownerConnId?: string;
  terminalPersistenceError?: Error;
}) {
  const { runId, sessionId, sessionKey, persistence, ownerConnId, terminalPersistenceError } =
    params;
  rpcSourceTesting.clear();
  const registration = registerChatAbortController({
    runId,
    sessionId,
    sessionKey,
    sourceWork: persistence.promise,
    target: captureSessionTarget({
      storeScope: resolveSessionStorePathCore(getHostRuntimeConfig().session?.store),
      sessionKey,
      incarnation: sessionId,
    }),
    timeoutMs: 60_000,
    ownerConnId,
  });
  if (!registration.entry) {
    throw new Error("expected active run registration");
  }
  onTestFinished(registration.cleanup);
  const entry = registration.entry;
  let operation: ReturnType<typeof createReplyOperation> | undefined;
  const claim = await claimSessionControllerTask(entry.input, (mailboxClaim) => {
    operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      target: entry.input.target,
      mailboxClaim,
    });
    markReplyOperationExecutionStarted(operation);
    operation.setPhase("running");
  });
  if (!operation) {
    throw new Error("expected active run operation");
  }
  const activeOperation = operation;
  const finish = () => {
    activeOperation.complete();
    releaseSessionControllerClaim(claim);
  };
  const aborted = createDeferredCore();
  const onAbort = () => aborted.resolve();
  entry.input.abortSignal.addEventListener("abort", onAbort, { once: true });
  const terminalStarted = createDeferredCore();
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
      return;
    }
    entry.adapter.projectSessionTerminalPending = false;
    entry.adapter.projectSessionTerminalPersistence = persistence.promise;
    void persistence.promise.then(
      () => {
        entry.adapter.projectSessionTerminalPersistence = undefined;
        entry.adapter.projectSessionTerminalPersisted = true;
        finish();
      },
      (error: unknown) => {
        markChatAbortTerminalPersistenceError(entry, error);
        finish();
      },
    );
    terminalStarted.resolve();
    if (terminalPersistenceError) {
      persistence.reject(terminalPersistenceError);
    }
  });
  const chatRunState = createChatRunState();
  return {
    aborted: aborted.promise,
    context: {
      agentRunSeq: new Map([[runId, 0]]),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      rpcSourceTesting,
      chatRunState,
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => ({ sessionKey, clientRunId: runId })),
    },
    controller: registration.controller,
    terminalStarted: terminalStarted.promise,
    unsubscribe(this: void) {
      entry.input.abortSignal.removeEventListener("abort", onAbort);
      unsubscribe();
      finish();
      registration.cleanup();
    },
  };
}

export function waitForArchivePhase(
  phase: Promise<unknown>,
  archive: Promise<unknown>,
  signal: AbortSignal,
) {
  return racePromiseWithAbortSignal(
    Promise.race([
      phase,
      archive.then((result) => {
        throw new Error("Archive settled before the expected fixture phase", { cause: result });
      }),
    ]),
    signal,
  );
}

export function identifiedClient(profileId: string): GatewayClient {
  return {
    connId: `${profileId}-connection`,
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

export function workerPlacement(params: {
  sessionId: string;
  sessionKey: string;
  state: WorkerSessionPlacementRecord["state"];
  agentId?: string;
  environmentId?: string | null;
}): WorkerSessionPlacementRecord {
  const awaitingEnvironment = params.state === "local" || params.state === "requested";
  const awaitingBundle = awaitingEnvironment || params.state === "provisioning";
  const awaitingWorkspace = awaitingBundle || params.state === "syncing";
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? "main",
    executionMode: "worker-turn",
    state: params.state,
    generation: 2,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId:
      params.environmentId !== undefined
        ? params.environmentId
        : awaitingEnvironment
          ? null
          : "worker-environment",
    activeOwnerEpoch: ["active", "draining", "reconciling", "reclaimed", "failed"].includes(
      params.state,
    )
      ? 1
      : null,
    workspaceBaseManifestRef: awaitingWorkspace ? null : "manifest-ref",
    remoteWorkspaceDir: awaitingWorkspace ? null : "/workspace",
    workerBundleHash: awaitingBundle ? null : "bundle-hash",
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: params.state === "failed" ? "worker recovery stopped" : null,
  } as WorkerSessionPlacementRecord;
}

export function placementReader(current: () => WorkerSessionPlacementRecord | undefined) {
  return {
    async prepareSessionPlacement(sessionId: string) {
      return {
        prepareRead: () => undefined,
        current: () => {
          const placement = current();
          return placement?.sessionId === sessionId ? placement : undefined;
        },
        release() {},
      };
    },
    getMany(sessionIds: readonly string[]) {
      const placement = current();
      return new Map(
        placement && sessionIds.includes(placement.sessionId)
          ? [[placement.sessionId, placement]]
          : [],
      );
    },
  };
}

export async function archiveLifecycleRequestContext(
  overrides: Record<string, unknown>,
): Promise<GatewayRequestContext> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const loadGatewayModelCatalog = async () => [];
  return {
    trackExecution: trackAsyncWork,
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig,
    loadGatewayModelCatalog,
    readPreparedGatewayModelCatalog: async () => ({ entries: await loadGatewayModelCatalog() }),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

type LifecycleHandlerResponse = {
  ok: boolean;
  payload?: unknown;
  error?: Parameters<RespondFn>[2];
};

async function handlerResponse(invoke: (respond: RespondFn) => Promise<void> | undefined) {
  let response: LifecycleHandlerResponse | undefined;
  await invoke((ok, payload, error) => {
    response = { ok, payload, error };
  });
  return expectDefined(response, "lifecycle handler response");
}

export function archiveTarget(key: string, expectedSessionId: string) {
  return { key, expectedSessionId };
}

export function expectArchived(storePath: string, sessionKey: string) {
  expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toEqual(expect.any(Number));
}

export async function invokeArchiveHandler(params: {
  authorization: NonNullable<
    ReturnType<typeof resolveSessionMutationAuthorization>["authorization"]
  >;
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  expectedSessionId: string;
}): Promise<LifecycleHandlerResponse> {
  const handlers = await getSessionsHandlers();
  const target = archiveTarget(params.sessionKey, params.expectedSessionId);
  return handlerResponse((respond) =>
    handlers["sessions.patch"]?.({
      req: {} as never,
      params: { ...target, archived: true },
      client: params.client,
      context: params.context,
      isWebchatConnect: () => false,
      sessionMutationAuthorization: params.authorization,
      respond,
    } as never),
  );
}

export async function invokeVisibilityHandler(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  visibility: "draft" | "shared";
}): Promise<LifecycleHandlerResponse> {
  const handlers = await getSessionsHandlers();
  return handlerResponse((respond) =>
    handlers["session.visibility.set"]?.({
      params: { sessionKey: params.sessionKey, visibility: params.visibility },
      client: params.client,
      context: params.context,
      respond,
    } as never),
  );
}
