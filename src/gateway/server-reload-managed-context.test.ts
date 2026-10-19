import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requestGatewayRestartWithSignalAdmission } from "../infra/restart.js";
import {
  getLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import type { GatewayPluginReloadResult } from "./server-reload-contracts.js";
import {
  captureConfigWriteListener,
  createConfigWriteNotification,
  createConfigWriteListenerRef,
  createManagedReloadTestParams,
  createValidConfigSnapshot,
  enableChannelReloadsForTest,
} from "./server-reload-handlers.config.test-support.js";
import type { startManagedGatewayConfigReloader as StartManagedGatewayConfigReloader } from "./server-reload-managed.js";
import {
  createTestRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";

// Model preparation has its own lifecycle coverage; this regression needs the
// real reload transaction and async owners, not a cold model/plugin runtime.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  advancePreparedModelRuntimeConfig: vi.fn(),
  beginPreparedModelRuntimePluginDrain: () => ({ pendingPublication: false, release: () => {} }),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));

type ManagedReloaderParams = Parameters<typeof StartManagedGatewayConfigReloader>[0];
type ManagedReloaderTestParams = Pick<
  ManagedReloaderParams,
  "initialConfig" | "readSnapshot" | "subscribeToWrites" | "scheduler"
> &
  Partial<ManagedReloaderParams>;

let pluginRegistrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
let restoreChannelReloadEnv: () => void;

beforeEach(() => {
  const watcher = installWatcherMock();
  onTestFinished(() => watcher.restore());
  pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
  restoreChannelReloadEnv = enableChannelReloadsForTest();
});

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
  restoreChannelReloadEnv();
});

function startManagedGatewayConfigReloader(
  startManagedGatewayConfigReloaderImpl: typeof StartManagedGatewayConfigReloader,
  params: ManagedReloaderTestParams,
) {
  setRuntimeConfigSnapshot(params.initialConfig);
  return startManagedGatewayConfigReloaderImpl(
    createManagedReloadTestParams({
      promoteSnapshot: vi.fn(async () => true) as never,
      reloadPlugins: vi.fn(async ({ prepareConfigEffects }) => {
        prepareConfigEffects({ pluginIds: new Set(), channels: new Set() }).retire();
        return {
          runtime: { operationId: "test-reload", generation: 1, pluginIds: [] },
          activeChannels: new Set(),
        } satisfies GatewayPluginReloadResult;
      }),
      channelManager: {
        pruneInactiveChannelAccountState: vi.fn(),
        releaseChannelRouteHandoffs: vi.fn(),
      } as never,
      activateRuntimeSecrets: createTestRuntimeSecretsActivator(async ({ config }) =>
        makePreparedSecretsSnapshot(config),
      ),
      ...params,
      requestRecoveryRestart:
        params.requestRecoveryRestart ?? requestGatewayRestartWithSignalAdmission,
    }),
  );
}

describe("managed gateway reload context", () => {
  it("starts replacement channels with the current Gateway owner after a writer settles", async () => {
    // Scheduler jobs retain the writer context even when the fake clock wakes elsewhere.
    const time = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(time.clock);
    const initialConfig: OpenClawConfig = {
      channels: { telegram: { accounts: { default: { name: "Before" } } } },
    };
    const nextConfig: OpenClawConfig = {
      channels: { telegram: { accounts: { default: { name: "After" } } } },
    };
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "telegram" }),
      reload: { configPrefixes: ["channels.telegram"] },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
    const writerContext = new AsyncLocalStorage<string>();
    const previousGateway = new LegacyPluginSdkResourceHost();
    const currentGateway = new LegacyPluginSdkResourceHost();
    const writerWork = new AsyncWorkScope();
    const writeListenerRef = createConfigWriteListenerRef();
    const channelContexts: Array<
      [string | undefined, LegacyPluginSdkResourceHost, AbortSignal | undefined]
    > = [];
    const logReloadError = vi.fn<(message: string) => void>();
    const startChannel = vi.fn(async () => {
      const host = getLegacyPluginSdkResourceHost();
      channelContexts.push([writerContext.getStore(), host, getAsyncWorkSignal()]);
      return host.invoke(() => new Map());
    });
    const startupWork = new AsyncWorkScope();
    let reloader: ReturnType<typeof StartManagedGatewayConfigReloader> | undefined;
    try {
      // Production lazily imports this module inside the first Gateway's SDK host.
      // Keep that module instance when the replacement Gateway takes ownership.
      const { startManagedGatewayConfigReloader: startReloader } = await previousGateway.run(
        () => import("./server-reload-managed.js"),
      );
      await previousGateway.close();
      reloader = currentGateway.run(() =>
        startupWork.run(() =>
          startManagedGatewayConfigReloader(startReloader, {
            scheduler,
            initialConfig,
            readSnapshot: async () => createValidConfigSnapshot(nextConfig, "profile-change"),
            subscribeToWrites: captureConfigWriteListener(writeListenerRef),
            startChannel,
            logReload: { info: vi.fn(), warn: vi.fn(), error: logReloadError },
          }),
        ),
      );
      await reloader.ready;
      await startupWork.drain();
      const application = createRuntimeConfigWriteApplication();
      const listener = writeListenerRef.current;
      if (!listener) {
        throw new Error("Expected managed config write listener");
      }
      writerContext.run("channel-turn", () =>
        writerWork.run(() => {
          listener(
            attachRuntimeConfigWriteApplication(
              createConfigWriteNotification(
                nextConfig,
                "profile-change",
                1,
                "runtime-profile-change",
                "source-profile-change",
              ),
              application,
            ),
          );
        }),
      );
      await writerWork.drain();
      expect(startChannel).not.toHaveBeenCalled();
      await time.advanceBy(0);

      const status = await application.result;
      expect(startChannel).toHaveBeenCalled();
      for (const [writer, host, signal] of channelContexts) {
        expect(writer).toBeUndefined();
        expect(host === currentGateway, "reload must use the current Gateway SDK host").toBe(true);
        expect(signal).toBeUndefined();
      }
      expect(status, logReloadError.mock.calls.flat().join("\n")).toBe("applied");
    } finally {
      try {
        await reloader?.stop();
        await scheduler.stop();
      } finally {
        await Promise.all([previousGateway.close(), currentGateway.close()]);
      }
    }
  });
});
