import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import { scenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  checkpointArgs,
  warmImage,
  warmRecord,
  warmStore,
  warmAllocation,
  pause,
} from "./crabbox-warm-scenarios.test-support.js";
import {
  openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import {
  createWarmProvider,
  provisionWarmProfile,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

const { choice: _choice, imageGeneration: _generation, ...allocation } = warmAllocation();
const image = warmImage("chk_original");

function stateFixture(profile?: Partial<WarmProfileRecord>) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-store-"));
  const fixture = openWarmImageStore();
  const seed = (record: Partial<WarmProfileRecord>) =>
    fixture.register("profile", warmRecord(record));
  if (profile) {
    seed(profile);
  }
  return {
    fixture,
    seed,
    read: () => fixture.lookup("profile"),
    store: openCrabboxWarmImageStore(crabboxState),
  };
}

function recordAllocation(availableImage?: typeof image) {
  return openCrabboxWarmImageStore(crabboxState).recordAllocation({
    key: "profile",
    id: "new",
    allocation,
    availableImage,
    assertCurrent() {},
  });
}

function observeComparisons(before: () => void | Promise<void>, after?: () => void) {
  const open = crabboxState.openKeyedStoreV2;
  let attempts = 0;
  vi.spyOn(crabboxState, "openKeyedStoreV2").mockImplementation(
    <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      const compareAndApply = store.compareAndApply;
      return {
        ...store,
        compareAndApply: async (...args: Parameters<typeof compareAndApply>) => {
          if (++attempts === 1) {
            await before();
          }
          const result = await compareAndApply(...args);
          after?.();
          return result;
        },
      };
    },
  );
  return () => attempts;
}

describe("Crabbox asynchronous warm-image mutations", () => {
  it("normalizes diagnostics without migrating v3 records", async () => {
    const { fixture, store } = stateFixture();
    fixture.register("old", warmRecord());
    warmStore<unknown>().register("malformed", {
      version: 3,
      allocations: {},
      recipePreparation: { source: "unknown", commands: ["must not appear"] },
    });
    const recipePreparation = {
      source: "detected" as const,
      phaseDurationsMs: { detectedInstall: 20 },
      failure: { reason: "install failed", outputTail: "☃".repeat(6000) },
    };
    fixture.register("oversized", warmRecord({ recipePreparation }));

    expect(await store.lookup("old")).toEqual({ version: 3, allocations: {} });
    expect((await store.lookup("malformed"))?.recipePreparation).toBeUndefined();
    const diagnostics = (await store.entries()).find(({ key }) => key === "oversized")?.value
      .recipePreparation;
    expect(diagnostics?.phaseDurationsMs).toEqual({ detectedInstall: 20 });
    expect(Buffer.byteLength(diagnostics?.failure?.outputTail ?? "")).toBeLessThanOrEqual(16_384);
    expect(diagnostics?.failure?.outputTail).toMatch(/☃$/u);
  });

  it("rejects malformed refusals before reading or updating", async () => {
    const { store } = stateFixture();
    const raw = warmStore<unknown>();
    const valid = { atMs: 1, provider: "hetzner", message: "Native capture is unsupported" };
    for (const captureUnsupported of [
      null,
      { ...valid, atMs: -1 },
      { ...valid, atMs: 1.5 },
      { ...valid, atMs: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, atMs: "1" },
      { ...valid, provider: 1 },
      { ...valid, provider: "" },
      { ...valid, provider: "p".repeat(129) },
      { ...valid, message: 1 },
      { ...valid, message: "" },
      { ...valid, message: "m".repeat(1025) },
    ]) {
      raw.register("profile", { ...warmRecord(), captureUnsupported });

      await expect(store.lookup("profile")).rejects.toThrow("preparation state is invalid");
      const update = vi.fn(() => undefined);
      await expect(store.update("profile", update)).rejects.toThrow("preparation state is invalid");
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("rechecks retirement and siblings after conflict", async () => {
    const { seed, read } = stateFixture({ image });
    const attempts = observeComparisons(() => {
      seed({
        image,
        operation: { type: "retire", checkpointId: image.checkpointId },
        allocations: {
          sibling: { ...allocation, choice: { kind: "cold" }, imageGeneration: null },
        },
      });
    });
    const result = await recordAllocation(image);

    expect(result.choice).toEqual({ kind: "cold" });
    const committed = read()!;
    expect(Object.keys(committed.allocations).toSorted()).toEqual(["new", "sibling"]);
    expect(committed.operation).toEqual({
      type: "retire",
      checkpointId: image.checkpointId,
    });
    expect(attempts()).toBe(2);
  });

  it("rechecks capacity after a comparison conflict", async () => {
    const { seed, read } = stateFixture();
    const allocations = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `lease-${index}`,
        { ...allocation, choice: { kind: "cold" as const }, imageGeneration: null },
      ]),
    );
    seed({ allocations });
    observeComparisons(() => {
      delete allocations["lease-0"];
      seed({ allocations });
    });

    await expect(recordAllocation()).resolves.toMatchObject({
      key: "profile",
      choice: { kind: "cold" },
    });
    expect(Object.keys(read()!.allocations)).toHaveLength(256);
  });

  it("never replays an indeterminate mutation", async () => {
    const { read } = stateFixture();
    const attempts = observeComparisons(
      () => {},
      () => {
        throw new Error("fixture completion unavailable");
      },
    );

    await expect(recordAllocation()).rejects.toThrow("fixture completion unavailable");

    expect(attempts()).toBe(1);
    expect(read()?.allocations.new?.choice).toEqual({
      kind: "cold",
    });
  });

  it("returns the committed projection despite replacement", async () => {
    const s = scenario();
    s.store.register("profile", warmRecord({ image }));
    observeComparisons(
      () => {},
      () =>
        s.store.register(
          "profile",
          warmRecord({ image: { ...image, checkpointId: "chk_replacement" } }),
        ),
    );

    await expect(s.provider.images.pin(image.checkpointId, true)).resolves.toMatchObject({
      profileKey: "profile",
      checkpointId: image.checkpointId,
      pinned: { atMs: expect.any(Number) },
    });
    expect(s.store.lookup("profile")?.image?.checkpointId).toBe("chk_replacement");
  });

  it.each(["profile removed", "allocation removed", "allocation changed"] as const)(
    "refuses dispatch if its owner is %s",
    async (change) => {
      const initial = createWarmProvider();
      const lease = await provisionWarmProfile(initial.provider);
      await initial.provider.dispose();
      const fixture = openWarmImageStore();
      const entry = fixture.entries()[0]!;
      observeComparisons(() => {
        if (change === "profile removed") {
          fixture.delete(entry.key);
        } else {
          fixture.register(entry.key, {
            ...entry.value,
            allocations:
              change === "allocation removed"
                ? {}
                : {
                    [lease.leaseId]: {
                      ...entry.value.allocations[lease.leaseId]!,
                      machineClass: "fast",
                    },
                  },
          });
        }
      });
      const restarted = createWarmProvider(undefined, initial.stateDir);

      await expect(provisionWarmProfile(restarted.provider)).rejects.toThrow(
        "allocation changed before provisioning",
      );
      expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
      expect(checkpointArgs(restarted.calls, "fork")).toEqual([]);
      expect(fixture.lookup(entry.key)?.allocations[lease.leaseId]?.machineClass).toBe(
        change === "allocation changed" ? "fast" : undefined,
      );
    },
  );

  it.each(["pin", "rollback"] as const)(
    "drains admitted %s writes before disposal",
    async (action) => {
      const s = scenario();
      s.store.register(
        "profile",
        warmRecord({
          image,
          previous: { ...image, checkpointId: "chk_previous" },
        }),
      );
      const gate = pause();
      observeComparisons(gate.wait);
      const mutation =
        action === "pin"
          ? s.provider.images.pin(image.checkpointId, true)
          : s.provider.images.rollback("chk_previous");
      await gate.entered;
      const disposed = vi.fn();
      const disposal = s.provider.dispose().then(disposed);
      await Promise.resolve();
      expect(disposed).not.toHaveBeenCalled();
      gate.release();
      await mutation;
      await disposal;
      expect(disposed).toHaveBeenCalledOnce();
      expect(s.store.lookup("profile")?.image).toMatchObject(
        action === "pin"
          ? { pinned: { atMs: expect.any(Number) } }
          : { checkpointId: "chk_previous" },
      );
      await expect(s.provider.images.pin(image.checkpointId, false)).rejects.toThrow();
    },
  );
});
