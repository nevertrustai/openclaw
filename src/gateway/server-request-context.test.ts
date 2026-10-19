import { writeFileSync } from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  assertAgentDatabaseAdmitted,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  getAgentDatabaseStartupAdmission,
  withAgentDatabaseStartupAdmission,
} from "../state/agent-database-startup.js";
import * as deletionJournal from "../state/agent-deletion-journal.read.js";
import * as userProfileCatalog from "../state/user-profile-list.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureGatewayDeviceRevocation } from "./device-revocation.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import {
  makeContextParams,
  makeCronState,
  makeGatewayClient,
  type RequestRuntime,
} from "./server-request-context.test-support.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

vi.mock("./server/health-state.js", () => ({
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 1),
}));

function makeDeviceClient(connId: string, deviceId: string, role = "primary") {
  return {
    connId,
    connect: { device: { id: deviceId }, role },
    socket: { close: vi.fn() },
  };
}

function approvalClient(
  connId: string,
  clientId: Parameters<typeof makeGatewayClient>[0]["clientId"],
  overrides: Partial<Parameters<typeof makeGatewayClient>[0]> = {},
) {
  return makeGatewayClient({ connId, clientId, scopes: ["operator.approvals"], ...overrides });
}

function deviceContext(clients: ReturnType<typeof makeDeviceClient>[]) {
  const params = makeContextParams({ clients: new Set(clients) as never });
  return { context: createGatewayRequestContext(params), runtime: params.runtime };
}

describe("createGatewayRequestContext", () => {
  it("keeps startup observation bound to copied contexts after transport context loss", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.useFakeTimers();
      const pathname = state.statePath("pending-agent.sqlite");
      writeFileSync(pathname, "synthetic identity; native preparation is separate proof");
      const journal = vi
        .spyOn(deletionJournal, "readAgentDeletionJournalStatusInWorker")
        .mockResolvedValue("absent");
      const preparation = createDeferredCore();
      const startupReason = "synthetic transport startup inspection";
      const assertAdmitted = () => assertAgentDatabaseAdmitted("main", { env: state.env });
      try {
        await withAgentDatabaseStartupAdmission(async (admission) => {
          recordAgentDatabaseAdmissions(
            admission.defer({
              env: state.env,
              inspections: [
                {
                  target: { agentId: "main", path: pathname },
                  result: Promise.resolve({ incompatible: [], indeterminate: [] }),
                },
              ],
              reason: startupReason,
            }),
            { env: state.env, source: "startup" },
          );
          const owner = admission.adopt();
          admission.activate({
            isCurrent: () => true,
            preparationReady: preparation.promise,
            openAgent: async () => {},
            migrateAgent: async () => {},
            publishAgent: async () => {},
          });
          const config = { agents: { entries: { main: {} } } };
          const context = createGatewayRequestContext(makeContextParams());
          context.getRuntimeConfig = () => config;
          const respond = vi.fn();
          const handler = vi.fn<GatewayRequestHandler>(({ respond: reply }) => {
            assertAdmitted();
            reply(true, { sessions: [] });
          });
          let request: Promise<void> | undefined;
          try {
            request = runInDetachedAsyncContext(() => {
              expect(getAgentDatabaseStartupAdmission()).toBeUndefined();
              expect(assertAdmitted).toThrow(startupReason);
              return handleGatewayRequest({
                req: {
                  type: "req",
                  id: "detached-startup-read",
                  method: "sessions.list",
                  params: { agentId: "main" },
                },
                context: { ...context },
                client: makeGatewayClient({
                  connId: "detached-reader",
                  clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
                  scopes: ["operator.admin"],
                }),
                respond,
                isWebchatConnect: () => false,
                extraHandlers: { "sessions.list": handler },
              });
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(handler).not.toHaveBeenCalled();
            expect(respond).not.toHaveBeenCalled();
            expect(assertAdmitted).toThrow(startupReason);
            preparation.resolve();
            await request;
            expect(handler).toHaveBeenCalledOnce();
            expect(respond).toHaveBeenCalledExactlyOnceWith(true, { sessions: [] });
          } finally {
            const requestSettled = request?.catch(() => {});
            preparation.resolve();
            await owner.stop();
            await requestSettled;
            recordAgentDatabaseAdmissions([], { env: state.env, source: "startup" });
          }
        });
      } finally {
        journal.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("prepares every recipient before the real merge's first notification and contains resolution failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const source = ensureProfileForEmail("event-source@example.test");
      const target = ensureProfileForEmail("event-target@example.test");
      const third = ensureProfileForEmail("event-third@example.test");
      using _ = {
        [Symbol.dispose]: (await userProfileCatalog.prepareUserProfileCatalog()).release,
      };
      const frames: Array<{ connId: string; event: string; recipientProfileId?: string }> = [];
      const clients = new GatewayClientRegistry();
      for (const [index, profile] of [source, target, third].entries()) {
        clients.add({
          ...makeGatewayClient({
            connId: `event-${index}`,
            clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
            scopes: ["operator.admin"],
          }),
          usesSharedGatewayAuth: false,
          presenceKey: `event-${index}`,
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: null,
            avatarRevision: "1",
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          },
          socket: {
            readyState: 1,
            bufferedAmount: 0,
            close: vi.fn(),
            send: (
              wire: string | Buffer,
              options?: { binary: false } | (() => void),
              done?: () => void,
            ) => {
              frames.push({ connId: `event-${index}`, ...JSON.parse(String(wire)) });
              (typeof options === "function" ? options : done)?.();
            },
          } as unknown as GatewayWsClient["socket"],
        });
      }
      const peers = [...clients];
      const broadcaster = createGatewayBroadcaster({
        clients,
        preparePresenceProjection: (presence) => () => presence,
      });
      const params = makeContextParams({ clients, ...broadcaster });
      const context = createGatewayRequestContext(params);
      for (const peer of peers) {
        prepareGatewayRecipientProfile(peer);
      }
      const subscribers = createSessionEventSubscriberRegistry();
      for (const peer of peers) {
        subscribers.subscribe(peer.connId);
      }
      const chatRunState = createChatRunState();
      const subscriptions = startGatewayEventSubscriptions({
        scheduler: createTestGatewayScheduler(),
        ...broadcaster,
        signal: new AbortController().signal,
        log: params.log,
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: subscribers,
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        restartRecoveryCandidates: new Map(),
        refreshConnectedUserProfiles: () => context.refreshConnectedUserProfile?.(),
      });
      try {
        linkEmail("event-source@example.test", target.id);
        for (const [index, profileId] of [target.id, target.id, third.id].entries()) {
          expect(
            new Set(
              frames
                .filter((frame) => frame.connId === `event-${index}`)
                .map((frame) => frame.recipientProfileId),
            ),
          ).toEqual(new Set([profileId]));
        }
        expect(frames.some((frame) => frame.event === "sessions.changed")).toBe(true);
        const authenticated = peers.map((peer) => peer.authenticatedUserProfile);
        const resolve = vi
          .spyOn(userProfileCatalog, "readResidentUserProfileIdentity")
          .mockImplementationOnce(() => {
            throw new Error("fixture storage unavailable");
          });
        try {
          context.refreshConnectedUserProfile?.();
          expect(peers.map((peer) => peer.preparedRecipientProfileId)).toEqual([
            undefined,
            target.id,
            third.id,
          ]);
          peers.forEach((peer, index) => {
            expect(peer.authenticatedUserProfile).toBe(authenticated[index]);
            expect(peer.invalidated).not.toBe(true);
          });
        } finally {
          resolve.mockRestore();
        }
      } finally {
        subscriptions.lifecycleUnsub();
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        await subscriptions.agentUnsub();
      }
    });
  });

  it("reuses the canonical connection liveness predicate", () => {
    const isConnectionActive = vi.fn(() => true);
    const params = makeContextParams();
    Object.assign(params.runtime, { isConnectionActive });

    const context = createGatewayRequestContext(params);

    expect(context.isConnectionActive).toBe(isConnectionActive);
  });

  it("cleans connection-scoped replace-sets with the other session subscriptions", () => {
    const calls: [string, string][] = [];
    const record = (name: string) => (connId: string) => {
      calls.push([name, connId]);
    };
    const params = makeContextParams();
    params.runtime.sessionEventSubscribers.unsubscribe = record("session-events");
    params.runtime.sessionMessageSubscribers.unsubscribeAll = record("messages");
    params.runtime.sessionObserver.removeConnection = record("observer");
    params.runtime.runtimeState.controlUiSessionPullRequests = {
      unsubscribe: record("pull-requests"),
    } as never;
    params.runtime.runtimeState.sessionViewerPresence = {
      unsubscribe: record("presence"),
    } as never;
    createGatewayRequestContext(params).unsubscribeAllSessionEvents("conn-control-ui");
    expect(calls).toEqual(
      ["session-events", "messages", "observer", "pull-requests", "presence"].map((name) => [
        name,
        "conn-control-ui",
      ]),
    );
  });

  it("reads the portal service after its transport becomes available", () => {
    let portalService: GatewayRequestContext["portalService"];
    const params = makeContextParams();
    params.runtime.transportBridge.getPortalService = () => portalService;
    const context = createGatewayRequestContext(params);

    expect(context.portalService).toBeUndefined();
    portalService = {
      open: vi.fn(async () => {
        throw new Error("unused");
      }),
      list: vi.fn(() => []),
      listWorkerPortals: vi.fn(() => []),
      close: vi.fn(async () => {}),
      closeWorkerPortals: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
    };
    expect(context.portalService).toBe(portalService);
    portalService = undefined;
    expect(context.portalService).toBeUndefined();
  });

  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: RequestRuntime["runtimeState"] = {
      cronState: makeCronState({ cron: cronA, storePath: "/tmp/cron-a" }),
      configReloader: { isConfigReloadSettled: () => true },
    };

    const context = createGatewayRequestContext(makeContextParams({ runtimeState }));

    expect(context.cron).toBe(cronA);
    expect(context.cronStorePath).toBe("/tmp/cron-a");

    runtimeState.cronState = makeCronState({ cron: cronB, storePath: "/tmp/cron-b" });

    expect(context.cron).toBe(cronB);
    expect(context.cronStorePath).toBe("/tmp/cron-b");
  });

  it("reads config reload status and readiness through the live kernel bridge", () => {
    let status: "active" | "disabled" | undefined;
    let settled = true;
    const params = makeContextParams();
    params.runtime.kernel.getConfigReloaderHotReloadStatus = () => status;
    params.runtime.runtimeState.configReloader.isConfigReloadSettled = () => settled;
    const context = createGatewayRequestContext(params);

    expect(context.getConfigReloaderHotReloadStatus?.()).toBeUndefined();
    expect(context.getDeferredChannelReloads?.()).toEqual([]);

    status = "active";
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("active");
    expect(context.isConfigReloadSettled()).toBe(true);
    settled = false;
    expect(context.isConfigReloadSettled()).toBe(false);

    status = "disabled";
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("disabled");

    const deferred = [{ channel: "discord", publicationPending: true }];
    params.runtime.runtimeState.configReloader = {
      isConfigReloadSettled: () => false,
      getDeferredChannelReloads: () => deferred,
    };
    expect(context.getDeferredChannelReloads?.()).toEqual(deferred);

    params.runtime.lifecycle.closePreludeStarted = true;
    expect(context.getDeferredChannelReloads?.()).toEqual([]);
  });

  it("publishes worker services through the kernel bridge", () => {
    const workerPlacementDiskSpaceReader = { read: vi.fn(), version: vi.fn(() => 1) };
    const repositoryWorkspaceMutationService = { mutate: vi.fn() };
    const context = createGatewayRequestContext(
      makeContextParams({
        workerPlacementRuntime: {
          diskSpace: workerPlacementDiskSpaceReader,
          runnerAvailability: undefined,
          repositoryWorkspaceMutationService,
        },
      }),
    );

    expect(context.workerPlacementDiskSpaceReader).toBe(workerPlacementDiskSpaceReader);
    expect(context.workerRepositoryWorkspaceMutationService).toBe(
      repositoryWorkspaceMutationService,
    );
  });

  it.each([false, true])("selects capable approval routes (delivery clients: %s)", (delivery) => {
    const clients = [
      approvalClient("cli", GATEWAY_CLIENT_IDS.CLI, { scopes: ["operator.admin"] }),
      approvalClient("backend", GATEWAY_CLIENT_IDS.GATEWAY_CLIENT, {
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      }),
      ...(delivery
        ? [
            approvalClient("control-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, {
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            }),
            approvalClient("ios", GATEWAY_CLIENT_IDS.IOS_APP, {
              mode: GATEWAY_CLIENT_MODES.UI,
              scopes: ["operator.admin"],
            }),
            approvalClient("bridge", GATEWAY_CLIENT_IDS.CLI, {
              caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
            }),
            approvalClient("acp", GATEWAY_CLIENT_IDS.CLI, {
              caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
            }),
            approvalClient("tui", GATEWAY_CLIENT_IDS.TUI),
            approvalClient("plugin-bridge", GATEWAY_CLIENT_IDS.CLI, {
              caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS],
            }),
            approvalClient("runtime", GATEWAY_CLIENT_IDS.GATEWAY_CLIENT, {
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              approvalRuntime: true,
            }),
            approvalClient("invalidated-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, { invalidated: true }),
            approvalClient("unscoped-ui", GATEWAY_CLIENT_IDS.CONTROL_UI, { scopes: [] }),
          ]
        : []),
    ];
    const context = createGatewayRequestContext(
      makeContextParams({ clients: new Set(clients) as never }),
    );
    expect(context.hasExecApprovalClients?.()).toBe(delivery);
    for (const [approvalKind, recipients] of [
      [undefined, ["control-ui", "ios", "bridge", "acp", "runtime"]],
      ["plugin", ["control-ui", "bridge", "tui", "plugin-bridge", "runtime"]],
      ["system-agent", ["control-ui", "bridge", "runtime"]],
    ] as const) {
      expect(
        context.getApprovalClientConnIds?.(approvalKind ? { approvalKind } : undefined),
      ).toEqual(new Set(delivery ? recipients : []));
    }
    if (delivery) {
      expect(context.hasExecApprovalClients?.("control-ui")).toBe(true);
      expect(
        context.getApprovalClientConnIds?.({
          excludeConnId: "control-ui",
          filter: (client) => client.connect.client.id === GATEWAY_CLIENT_IDS.IOS_APP,
        }),
      ).toEqual(new Set(["ios"]));
    }
  });

  it.each([false, true])("invalidates matching device authority (disconnect: %s)", (disconnect) => {
    const target = makeDeviceClient("conn-target", "device-1");
    const unrelated = makeDeviceClient("conn-unrelated", "device-2");
    const { context, runtime } = deviceContext([target, unrelated]);
    const detached = captureGatewayDeviceRevocation(context, { deviceId: "device-1" }, () => true);
    onTestFinished(detached.release);
    expect(detached.isCurrent()).toBe(true);
    const reason = disconnect ? "device-removed" : "device-token-rotated";
    if (disconnect) {
      context.disconnectClientsForDevice?.("device-1");
      expect(target.socket.close).toHaveBeenCalledWith(4001, "device removed");
      expect(runtime.watchNodeHttpRuntime.disconnectSessionsForDevice).toHaveBeenCalledWith(
        "device-1",
        undefined,
      );
    } else {
      context.invalidateClientsForDevice?.("device-1", { reason });
      expect(target.socket.close).not.toHaveBeenCalled();
      expect(runtime.nodeRegistry.invalidateConnectionForPairingChange).toHaveBeenCalledWith(
        "conn-target",
        reason,
      );
      expect(runtime.watchNodeHttpRuntime.invalidateSessionsForDevice).toHaveBeenCalledWith(
        "device-1",
        { reason },
      );
    }
    expect(detached.isCurrent()).toBe(false);
    expect(target).toMatchObject({ invalidated: true, invalidatedReason: reason });
    expect((unrelated as { invalidated?: boolean }).invalidated).toBeUndefined();
    expect(unrelated.socket.close).not.toHaveBeenCalled();
  });

  it.each(["live", "disconnected"])(
    "disconnects only authority for the reassigned durable profile (%s transport)",
    (transport) => {
      const target = {
        ...approvalClient("profile-target", GATEWAY_CLIENT_IDS.CONTROL_UI, {
          scopes: ["operator.admin"],
        }),
        authenticatedUserProfile: { profileId: "profile-ada" },
      };
      const unrelated = {
        ...approvalClient("profile-unrelated", GATEWAY_CLIENT_IDS.CONTROL_UI, { scopes: [] }),
        authenticatedUserProfile: { profileId: "profile-grace" },
      };
      const unidentified = approvalClient("shared-secret", GATEWAY_CLIENT_IDS.CLI, {
        scopes: ["operator.admin"],
      });
      const clients = new GatewayClientRegistry([target, unrelated, unidentified] as never);
      const releases = Array.from(clients, (peer) => clients.retainRequest(peer));
      onTestFinished(() => {
        releases.forEach((release) => release());
        expect([...clients.authorityClients]).toEqual([...clients]);
      });
      if (transport === "disconnected") {
        clients.clear();
      }
      const context = createGatewayRequestContext(makeContextParams({ clients }));
      target.socket.close.mockImplementation(() => {
        expect((target as { invalidated?: boolean }).invalidated).toBe(true);
      });

      if (transport === "disconnected") {
        expect(context.getClientConnIds?.()).toEqual(new Set());
        expect(context.hasExecApprovalClients?.()).toBe(false);
      }
      context.disconnectClientsForUserProfile?.("profile-ada");

      expect(target).toMatchObject({
        invalidated: true,
        invalidatedReason: "operator-role-changed",
      });
      expect(target.socket.close).toHaveBeenCalledWith(4001, "operator role changed");
      expect(unrelated.socket.close).not.toHaveBeenCalled();
      expect(unidentified.socket.close).not.toHaveBeenCalled();
    },
  );

  it("invalidateClientsForDevice filters by role when provided", () => {
    const primary = makeDeviceClient("conn-primary", "device-1");
    const secondary = makeDeviceClient("conn-secondary", "device-1", "secondary");
    const { context } = deviceContext([primary, secondary]);
    context.invalidateClientsForDevice?.("device-1", { role: "primary" });

    expect((primary as { invalidated?: boolean }).invalidated).toBe(true);
    expect((secondary as { invalidated?: boolean }).invalidated).toBeUndefined();
  });
});
