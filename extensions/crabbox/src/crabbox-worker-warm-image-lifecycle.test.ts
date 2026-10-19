import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  checkpointArgs,
  closeWarmState,
  commandArgs,
  firstWarmImage,
  updateWarmImage,
  warmEntry,
} from "./crabbox-warm-scenarios.test-support.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import { recoverCrabboxWarmImageCapture } from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  checkpointResult,
  createProjectOptions,
  createWarmProvider,
  provisionWarmProfile,
  CHECKPOINT_ID,
  LEASE_ID,
  PROFILE,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox warm-image lifecycle ownership", () => {
  it("keeps idle renewal through capture admission and capture, then stops it before release", async () => {
    vi.useFakeTimers();
    const inspectionEntered = createDeferred<void>();
    const finishInspection = createDeferred<void>();
    const captureEntered = createDeferred<void>();
    const finishCapture = createDeferred<void>();
    let destroying = false;
    let periodicHeartbeatCount = 0;
    let heartbeatSignal: AbortSignal | undefined;
    const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
      if (argv[1] === "heartbeat" && argv.includes("--idle-timeout")) {
        periodicHeartbeatCount++;
        heartbeatSignal = options.signal;
      }
      if (destroying && argv[1] === "inspect") {
        inspectionEntered.resolve();
        await finishInspection.promise;
      }
      if (destroying && argv[2] === "create") {
        captureEntered.resolve();
        await finishCapture.promise;
      }
      return undefined;
    });
    let teardown: Promise<void> | undefined;
    try {
      const lease = await provisionWarmProfile(provider);
      await vi.advanceTimersByTimeAsync(0);
      const beforeAdmission = periodicHeartbeatCount;
      destroying = true;
      teardown = destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });
      void teardown.catch(() => {});
      await inspectionEntered.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(periodicHeartbeatCount).toBeGreaterThan(beforeAdmission);
      expect(heartbeatSignal?.aborted).toBe(false);
      finishInspection.resolve();
      await captureEntered.promise;
      const beforeCapture = periodicHeartbeatCount;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(periodicHeartbeatCount).toBeGreaterThan(beforeCapture);
      expect(commandArgs(calls, "stop")).toEqual([]);
      finishCapture.resolve();
      await teardown;
      expect(heartbeatSignal?.aborted).toBe(true);
      const afterRelease = periodicHeartbeatCount;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(periodicHeartbeatCount).toBe(afterRelease);
      expect(commandArgs(calls, "stop")).toHaveLength(1);
    } finally {
      finishInspection.resolve();
      finishCapture.resolve();
      try {
        await teardown;
      } finally {
        await provider.dispose();
        vi.useRealTimers();
      }
    }
  });

  it("enrolls after detected setup failure, records diagnostics, and suppresses teardown capture after restart", async () => {
    const events: string[] = [];
    const { options, observe } = createProjectOptions(events);
    const recipePreparation = {
      source: "detected" as const,
      ignoredPropertiesNote: "devcontainer image ignored on cloud machines",
      phaseDurationsMs: { detectedInstall: 75 },
      failure: { reason: "npm ci failed", outputTail: "synthetic missing dependency" },
    };
    options.project.prepare.mockResolvedValue({
      seedKey: "a".repeat(64),
      cacheHit: false,
      captureSkipped: "npm ci failed",
      recipePreparation,
    });
    const initial = createWarmProvider(observe);
    const lease = await provisionWarmProfile(
      initial.provider,
      PROFILE,
      "detected-failure",
      undefined,
      options,
    );

    expect(events).toContain("enrollment-begun");
    expect(events).not.toContain("capture");
    expect(events).not.toContain("runtime-granted");
    expect(await firstWarmImage()).toMatchObject({
      state: "no-image",
      recipePreparation,
      allocations: { [lease.leaseId]: { phase: "enrolled", captureSkipped: "npm ci failed" } },
    });

    await closeWarmState(initial.provider);
    const restarted = createWarmProvider(undefined, initial.stateDir);
    await destroyAndWait(restarted.provider, { leaseId: lease.leaseId, profile: PROFILE });
    expect(checkpointArgs(restarted.calls, "create")).toEqual([]);
    expect(commandArgs(restarted.calls, "stop").length).toBeGreaterThan(0);
    expect((await firstWarmImage())?.recipePreparation).toEqual(recipePreparation);
  });

  it("retains declared recipe failure diagnostics while refusing dispatch", async () => {
    const events: string[] = [];
    const { options, observe } = createProjectOptions(events);
    const recipePreparation = {
      source: "devcontainer" as const,
      phaseDurationsMs: { onCreate: 30 },
      failure: { reason: "onCreateCommand failed", outputTail: "synthetic exit 7" },
    };
    options.project.prepare.mockImplementation(async (transport) => {
      await transport.recordRecipePreparation?.(recipePreparation);
      throw new Error("onCreateCommand failed");
    });
    const { provider, calls } = createWarmProvider(observe);

    await expect(
      provisionWarmProfile(provider, PROFILE, "declared-failure", undefined, options),
    ).rejects.toThrow("onCreateCommand failed");
    expect(events).not.toContain("enrollment-begun");
    expect(events).not.toContain("capture");
    expect(commandArgs(calls, "stop").length).toBeGreaterThan(0);
    expect(await firstWarmImage()).toMatchObject({
      state: "no-image",
      recipePreparation,
      allocations: {},
    });
  });

  it("replays a cold allocation after restart even after another lease publishes the first image", async () => {
    const initial = createWarmProvider();
    const lease = await provisionWarmProfile(initial.provider, PROFILE, "response-lost");
    await captureWarmImage(initial.provider, PROFILE, "first-template");
    await closeWarmState(initial.provider);

    const restarted = createWarmProvider(undefined, initial.stateDir);
    const replay = await provisionWarmProfile(restarted.provider, PROFILE, "response-lost");

    expect(replay.leaseId).toBe(lease.leaseId);
    expect(commandArgs(restarted.calls, "warmup").length).toBeGreaterThan(0);
    expect(checkpointArgs(restarted.calls, "fork")).toEqual([]);
  });

  it("pins the original checkpoint through refresh, restart, and an indeterminate stop", async () => {
    let captures = 0;
    let stopFails = false;
    const command = ({ argv }: CommandCall) => {
      if (argv[2] === "create") {
        return checkpointResult(
          `chk_generation_${++captures}`,
          argv[argv.indexOf("--id") + 1]!,
          "available",
        );
      }
      if (stopFails && argv[1] === "stop") {
        return commandResult({ code: 7, stderr: "stop unavailable" });
      }
      return undefined;
    };
    const initial = createWarmProvider(command);
    await captureWarmImage(initial.provider, PROFILE, "initial-template");
    const lease = await provisionWarmProfile(initial.provider, PROFILE, "response-lost");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
    await captureWarmImage(initial.provider, PROFILE, "refresh-template");
    expect(await firstWarmImage()).toMatchObject({
      checkpointId: "chk_generation_2",
      retirement: { checkpointId: "chk_generation_1" },
    });
    expect(checkpointArgs(initial.calls, "delete")).toEqual([]);
    await closeWarmState(initial.provider);

    const restarted = createWarmProvider(command, initial.stateDir);
    await provisionWarmProfile(restarted.provider, PROFILE, "response-lost");
    expect(checkpointArgs(restarted.calls, "fork")[0]?.[3]).toBe("chk_generation_1");
    stopFails = true;
    await expect(
      restarted.provider.destroy({ leaseId: lease.leaseId, profile: PROFILE }),
    ).rejects.toThrow();
    expect((await firstWarmImage())?.allocations[lease.leaseId]?.choice).toEqual({
      kind: "checkpoint",
      checkpointId: "chk_generation_1",
    });
    expect(checkpointArgs(restarted.calls, "delete")).toEqual([]);

    stopFails = false;
    restarted.calls.length = 0;
    await destroyAndWait(restarted.provider, { leaseId: lease.leaseId, profile: PROFILE });
    expect(restarted.calls.findIndex(({ argv }) => argv[1] === "stop")).toBeLessThan(
      restarted.calls.findIndex(({ argv }) => argv[2] === "delete"),
    );
    const released = await firstWarmImage();
    expect(released?.allocations[lease.leaseId]).toBeUndefined();
    expect(released?.retirement).toBeUndefined();
  });

  it("retains the old warm image when refresh scrub fails", async () => {
    let refreshing = false;
    const { provider, calls, warn } = createWarmProvider(({ argv }) =>
      refreshing && argv[1] === "run"
        ? commandResult({ code: 7, stderr: "refresh failed" })
        : undefined,
    );
    await captureWarmImage(provider);
    const lease = await provisionWarmProfile(provider);
    const store = openWarmImageStore();
    const image = warmEntry();
    const existing = {
      ...image.value,
      image: { ...image.value.image!, createdAtMs: Date.now() - 24 * 60 * 60 * 1_000 },
    };
    store.register(image.key, existing);
    calls.length = 0;
    refreshing = true;

    await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });

    expect(warn).toHaveBeenCalledOnce();
    expect(store.lookup(image.key)?.image).toEqual(existing.image);
    expect((await firstWarmImage())?.capture?.phase).toBeUndefined();
    expect(checkpointArgs(calls, "delete")).toEqual([]);
    refreshing = false;
    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, "after-failed-refresh");
    expect(checkpointArgs(calls, "fork")[0]?.[3]).toBe(CHECKPOINT_ID);
    expect(commandArgs(calls, "warmup")).toEqual([]);
  });

  it.each([
    { action: "inspect", missing: false, keepPrevious: 0 as const },
    { action: "inspect", missing: true, keepPrevious: 0 as const },
    { action: "fork", missing: false, keepPrevious: 0 as const },
    { action: "fork", missing: false, keepPrevious: 1 as const },
  ])(
    "preserves a refreshed image when an older $action finishes afterward (missing=$missing, keepPrevious=$keepPrevious)",
    async ({ action, missing, keepPrevious }) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const commandBlocked = createDeferred<void>();
      const started = createDeferred<void>();
      let blockNext = false;
      let refreshing = false;
      const replacementId = "chk_profile_refreshed";
      const { provider, calls } = createWarmProvider(
        async ({ argv }) => {
          if (blockNext && argv[2] === action) {
            blockNext = false;
            started.resolve();
            await commandBlocked.promise;
            if (missing) {
              return commandResult({
                stdout: JSON.stringify({
                  localState: "available",
                  providerState: "missing",
                  nextAction: "delete",
                }),
              });
            }
          }
          if (refreshing && argv[2] === "create") {
            return checkpointResult(replacementId, LEASE_ID, "available");
          }
          return undefined;
        },
        undefined,
        {
          warmImagePolicy: {
            refreshAfterMs: 86_400_000,
            retainUnusedMs: 14 * 86_400_000,
            keepPrevious,
          },
        },
      );
      await captureWarmImage(provider);
      const lease = await provisionWarmProfile(provider);
      const store = openWarmImageStore();
      const image = updateWarmImage({
        state: action === "inspect" ? "pending" : "available",
        createdAtMs: Date.now() - 24 * 60 * 60 * 1_000,
        lastDemandAtMs: now - 1_000,
      });
      blockNext = true;
      const provisioning = provisionWarmProfile(
        provider,
        PROFILE,
        `provision:v2:${"1".repeat(64)}`,
      );
      await started.promise;
      refreshing = true;
      try {
        await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });
      } finally {
        commandBlocked.resolve();
      }
      await provisioning;

      expect(store.lookup(image.key)?.image?.checkpointId).toBe(replacementId);
      expect(store.lookup(image.key)?.previous?.lastDemandAtMs).toBe(
        keepPrevious ? now : undefined,
      );
      calls.length = 0;
      await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
      expect(checkpointArgs(calls, "fork")[0]?.[3]).toBe(replacementId);
    },
  );

  it("pauses an abandoned empty reservation after restart until exact acknowledged recovery", async () => {
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider);
    const store = openWarmImageStore();
    const image = warmEntry();
    store.register(image.key, {
      version: 3,
      allocations: {},
      operation: {
        type: "capture",
        id: "migrated-capture",
        phase: "uncertain",
        startedAtMs: Date.now() - 1_200_001,
      },
    });

    const restarted = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(restarted.provider);

    expect(checkpointArgs(restarted.calls, "create")).toHaveLength(0);
    expect(checkpointArgs(restarted.calls, "delete")).toEqual([]);
    const capture = (await firstWarmImage())?.capture;
    expect(capture?.stale).toBe(true);
    expect(capture?.leaseId).toBeUndefined();
    await recoverCrabboxWarmImageCapture(crabboxState, capture!.selector, true);
    await captureWarmImage(restarted.provider);
    expect(checkpointArgs(restarted.calls, "create")).toHaveLength(1);
    expect(store.lookup(image.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
  });

  it.each([false, true])(
    "reserves one capture when leases stop concurrently (refresh=%s)",
    async (refresh) => {
      const scrubBlocked = createDeferred<void>();
      let capturing = false;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (capturing && argv[1] === "run") {
          await scrubBlocked.promise;
        }
        return undefined;
      });
      const first = await provisionWarmProfile(provider);
      const secondOperationId = `provision:v2:${"1".repeat(64)}`;
      const second = await provisionWarmProfile(provider, PROFILE, secondOperationId);
      if (refresh) {
        await captureWarmImage(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
        updateWarmImage({ createdAtMs: Date.now() - 24 * 60 * 60 * 1_000 });
      }
      calls.length = 0;
      capturing = true;

      const firstDestroy = destroyAndWait(provider, { leaseId: first.leaseId, profile: PROFILE });
      await vi.waitFor(() =>
        expect(
          calls.some(
            ({ argv, options }) =>
              argv[1] === "run" && options.input?.toString().includes("CRABBOX_SCRUB_NODE_SCRIPT"),
          ),
        ).toBe(true),
      );
      const secondDestroy = destroyAndWait(provider, { leaseId: second.leaseId, profile: PROFILE });
      await secondDestroy;
      scrubBlocked.resolve();
      await firstDestroy;

      expect(checkpointArgs(calls, "create")).toHaveLength(1);
      expect(commandArgs(calls, "stop")).toHaveLength(2);
    },
  );
});
