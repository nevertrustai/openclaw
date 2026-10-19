import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { bindOperatorModelExecution } from "../agents/admitted-run-context.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  setGatewayRestartPolicy,
} from "../infra/restart.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import * as sessionQueries from "../sessions/session-controller.queries.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createChannelManager } from "./server-channels.js";
import { createContext as createGatewayTestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import type { ManagedGatewayConfigReloaderParams } from "./server-reload-contracts.js";
import {
  createManagedReloadTestParams,
  createDirectConfigWriteFixture,
  createConfigWriteNotification,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import {
  createMockRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { disconnectDisallowedGatewayPolicyClients } from "./server/ws-origin-policy.js";

let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
const registry = createEmptyPluginRegistry();
beforeEach(() => {
  installWatcherMock();
  registrySnapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(registry);
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  resetGatewayRestartStateForInProcessRestart();
  setGatewayRestartPolicy({ allowExternal: false });
  resetGatewayWorkAdmission();
});

function createPolicyFixture(initialConfig: OpenClawConfig) {
  setRuntimeConfigSnapshot(initialConfig);
  const clock = createGatewaySchedulerClock(Date.now());
  const writer = createDirectConfigWriteFixture(initialConfig);
  const context = createGatewayTestContext();
  const channelManager = createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: () => initialConfig,
    getPluginRegistry: () => registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const start = (
    overrides: Pick<ManagedGatewayConfigReloaderParams, "clients" | "reconcileRuntimePolicy"> &
      Partial<ManagedGatewayConfigReloaderParams>,
  ) =>
    startManagedGatewayConfigReloader(
      createManagedReloadTestParams({
        scheduler: createTestGatewayScheduler(clock.clock),
        getPluginRegistry: () => registry,
        initialConfig,
        channelManager,
        startChannel: channelManager.startChannel,
        stopChannel: channelManager.stopChannel,
        readSnapshot: writer.readSnapshot,
        subscribeToWrites: writer.subscribeToWrites,
        resolveGatewayContext: () => context,
        activateRuntimeSecrets: createMockRuntimeSecretsActivator(),
        ...overrides,
      }),
    );
  const accepted: NonNullable<Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>>[] =
    [];
  const dispatcher = (connId?: string) =>
    createDispatchTestHarness({
      connId,
      buildRequestContext: () => context,
      extraHandlers: {
        // Capture authority through the classified operator write route.
        wake: async (options) => {
          const source = await captureGatewayOperatorRunAuthority({
            client: options.client,
            context,
            hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          });
          assert(source);
          accepted.push(source);
          options.respond(true, { accepted: true });
        },
      },
    });
  const write = (config: OpenClawConfig, revision: number, prefix = "role") => {
    assert(writer.ref.current);
    return publishConfigWrite(
      writer.ref.current,
      createConfigWriteNotification(
        config,
        `${prefix}-${revision}`,
        revision,
        `runtime-${revision}`,
        `source-${revision}`,
      ),
    );
  };
  return { clock, context, start, dispatcher, accepted, write };
}

function createPolicyClient(
  config: OpenClawConfig,
  profileId: string,
  scopes: string[],
  options: Parameters<typeof createOperatorWsClient>[0] = {},
  role: Parameters<typeof captureGatewayAuthPolicy>[1] = null,
) {
  const connection = new AbortController();
  return {
    ...createOperatorWsClient({
      ...options,
      scopes,
      socket: { close: vi.fn(() => connection.abort()) },
    }),
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      avatarRevision: "1",
      updatedAt: 1,
    },
    authPolicy: captureGatewayAuthPolicy(config, role),
    connectionSignal: connection.signal,
  };
}

const role = (scopes: OperatorScope[]) => ({
  agents: "*" as const,
  scopes,
  sessions: { others: "none" as const },
});

it("commits model-only role changes without retiring permitted models or original source work", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const profile = ensureProfileForEmail("reload-model-reader@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const roleName = "reader.modelPolicy.allow";
    const initialConfig: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } },
      },
      gateway: {
        roles: {
          default: roleName,
          definitions: {
            [roleName]: { ...role(["operator.write"]), modelPolicy: {} },
          },
        },
      },
    };
    const candidate = structuredClone(initialConfig);
    candidate.gateway!.roles!.definitions[roleName]!.modelPolicy = { deny: ["fixture/a"] };
    const { clock, context, start, dispatcher, accepted, write } =
      createPolicyFixture(initialConfig);
    const client = createPolicyClient(initialConfig, profile.id, ["operator.write"]);
    const entered = createDeferred();
    const releasePreparation = createDeferred();
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    let rejectCandidate = true;
    const advance = vi.spyOn(preparedModelRuntime, "advancePreparedModelRuntimeConfig");
    const invalidate = vi.spyOn(preparedModelRuntime, "markPreparedModelRuntimeSnapshotsStale");
    const rebuild = vi.spyOn(preparedModelRuntime, "refreshPreparedModelRuntimeSnapshots");
    const reloader = start({
      clients: [client],
      reconcileRuntimePolicy: (config) =>
        disconnectDisallowedGatewayPolicyClients([client], config),
      activateRuntimeSecrets: createMockRuntimeSecretsActivator(async (config) => {
        entered.resolve();
        await releasePreparation.promise;
        if (rejectCandidate) {
          throw new Error("candidate preparation rejected");
        }
        return makePreparedSecretsSnapshot(config);
      }),
      requestRecoveryRestart,
    });
    let original: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    let modelA: ReturnType<typeof bindOperatorModelExecution>;
    let modelB: ReturnType<typeof bindOperatorModelExecution>;
    try {
      await reloader.ready;
      context.getRuntimeConfig = () => candidate;
      const getCommittedRuntimeConfig = reloader.getCommittedRuntimeConfig;
      assert(getCommittedRuntimeConfig);
      context.getCommittedRuntimeConfig = getCommittedRuntimeConfig;
      const dispatch = dispatcher();
      await dispatch.dispatcher.dispatch(
        { type: "req", id: "model-policy", method: "wake", params: {} },
        client,
      );
      expect(dispatch.send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "model-policy", ok: true, payload: { accepted: true } }),
      );
      original = accepted[0];
      assert(original);
      modelA = bindOperatorModelExecution(original.authority, {
        provider: "fixture",
        model: "a",
      });
      modelB = bindOperatorModelExecution(original.authority, {
        provider: "fixture",
        model: "b",
      });
      assert(modelA && modelB);
      vi.spyOn(sessionQueries, "getActiveSessionRunCount").mockReturnValue(2);
      const rejected = write(candidate, 1, "roles");
      const rejectedReload = clock.wake();
      await Promise.race([
        entered.promise,
        rejected.then(() => {
          throw new Error("candidate settled before preparation");
        }),
      ]);
      expect(getCommittedRuntimeConfig()).toBe(initialConfig);
      expect([modelA.signal.aborted, modelB.signal.aborted]).toEqual([false, false]);
      expect(original.authority.assertCurrent).not.toThrow();
      releasePreparation.resolve();
      await expect(rejected).resolves.toBe("failed");
      // The receipt precedes lease cleanup; join the scheduler turn before the next wake.
      await rejectedReload;
      expect(getCommittedRuntimeConfig()).toBe(initialConfig);
      expect([modelA.signal.aborted, modelB.signal.aborted]).toEqual([false, false]);

      rejectCandidate = false;
      const applied = write(candidate, 2, "roles");
      await clock.wake();
      await expect(applied).resolves.toBe("applied");
      expect(getCommittedRuntimeConfig()).toEqual(candidate);
      expect([modelA.signal.aborted, modelB.signal.aborted]).toEqual([true, false]);
      expect(modelA.assertCurrent).toThrow("operator role cannot use this model");
      expect(modelB.assertCurrent).not.toThrow();
      expect(original.authority.signal?.aborted).toBe(false);
      expect(original.authority.assertCurrent).not.toThrow();
      expect(client.socket.close).not.toHaveBeenCalled();
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
      expect(advance).toHaveBeenCalledOnce();
    } finally {
      releasePreparation.resolve();
      try {
        await reloader.stop();
      } finally {
        modelA?.release();
        modelB?.release();
        for (const source of accepted) {
          source.release();
        }
      }
    }
  });
});

it.each(["scopes", "access policy"] as const)(
  "reloads roles without retiring unaffected work when %s change",
  async (revocation) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const initialConfig: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "contributor",
            definitions: {
              contributor: role(["operator.write", "operator.approvals"]),
              maintainer: role(["operator.admin"]),
            },
          },
        },
      };
      const maintainer = ensureProfileForEmail("role-maintainer@example.test");
      const contributor = ensureProfileForEmail("role-contributor@example.test");
      setUserProfileRole(maintainer.id, "maintainer");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const { clock, context, start, dispatcher, accepted, write } =
        createPolicyFixture(initialConfig);
      const clients = [
        { profile: maintainer, scopes: ["operator.admin"] },
        { profile: contributor, scopes: ["operator.write"] },
      ].map(({ profile, scopes }, index) =>
        createPolicyClient(
          initialConfig,
          profile.id,
          scopes,
          { connId: `role-reload-${index}` },
          { role: "operator" },
        ),
      );
      const reloader = start({
        clients,
        reconcileRuntimePolicy: (config, phase) => {
          if (phase === "committed") {
            disconnectDisallowedGatewayPolicyClients(clients, config);
          }
        },
      });
      try {
        await reloader.ready;
        const getConfig = reloader.getCommittedRuntimeConfig;
        assert(getConfig);
        context.getCommittedRuntimeConfig = getConfig;
        context.getRuntimeConfig = getConfig;
        const dispatchers = clients.map((client) => dispatcher(client.connId));
        for (const [index, client] of clients.entries()) {
          const dispatch = dispatchers[index]!;
          await dispatch.dispatcher.dispatch(
            { type: "req", id: "accepted", method: "wake", params: {} },
            client,
          );
          expect(dispatch.send).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
        }
        expect(accepted).toHaveLength(2);
        const writeScopes = async (
          scopes: OperatorScope[],
          revision: number,
          accessPolicyPlugin?: string,
        ) => {
          const candidate = structuredClone(initialConfig);
          candidate.gateway!.roles!.definitions.contributor!.scopes = scopes;
          candidate.gateway!.roles!.definitions.contributor!.accessPolicyPlugin =
            accessPolicyPlugin;
          const applied = write(candidate, revision);
          await clock.wake();
          await expect(applied).resolves.toBe("applied");
        };
        await writeScopes(["operator.admin"], 1);
        // A wider role must neither grant new scopes to accepted work nor retire it.
        for (const [index, source] of accepted.entries()) {
          expect.soft(clients[index]!.connectionSignal.aborted).toBe(false);
          expect.soft(source.authority.signal?.aborted).toBe(false);
          expect.soft(source.authority.assertCurrent).not.toThrow();
          expect(source.authority.scopes).toEqual(clients[index]!.connect.scopes);
        }
        await writeScopes(
          revocation === "scopes" ? ["operator.sessions.write"] : ["operator.write"],
          2,
          revocation === "access policy" ? "test-access-policy" : undefined,
        );
        expect(clients[0]!.connectionSignal.aborted).toBe(false);
        expect(accepted[0]!.authority.assertCurrent).not.toThrow();
        expect(accepted[0]!.authority.signal?.aborted).toBe(false);
        expect(clients[1]!.connectionSignal.aborted).toBe(true);
        expect(accepted[1]!.authority.signal?.aborted).toBe(true);
        expect(accepted[1]!.authority.assertCurrent).toThrow();
        await dispatchers[1]!.dispatcher.dispatch(
          { type: "req", id: "revoked", method: "wake", params: {} },
          clients[1]!,
        );
        expect(accepted).toHaveLength(2);
        await writeScopes(["operator.write", "operator.approvals"], 3);
        expect(accepted[1]!.authority.signal?.aborted).toBe(true);
        expect(accepted[1]!.authority.assertCurrent).toThrow();
      } finally {
        await reloader.stop();
        for (const source of accepted) {
          source.release();
        }
      }
    });
  },
);
