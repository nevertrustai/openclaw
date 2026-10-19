import { describe, expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import { scenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  updateWarmImage,
  captureOperation,
  pause,
  closeWarmState,
} from "./crabbox-warm-scenarios.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { recoverCrabboxWarmImageCapture } from "./crabbox-worker-warm-image-store.js";
import {
  checkpointResult,
  CHECKPOINT_ID,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const DAY_MS = 86_400_000;

describe("Crabbox capture recovery", () => {
  it.each([
    { phase: "scrub", fails: false },
    { phase: "scrub", fails: true },
    { phase: "create", fails: false },
    { phase: "create", fails: true },
  ])("retains $phase ownership during reuse (fails=$fails)", async ({ phase, fails }) => {
    const gate = pause();
    let block = false,
      phaseEntered = false;
    const s = scenario(async ({ argv }) => {
      if (
        block &&
        !phaseEntered &&
        (phase === "create" ? argv[2] === "create" : argv[1] === "run")
      ) {
        phaseEntered = true;
        await gate.wait();
        if (fails) {
          return commandResult({ code: 7, stderr: "capture phase failed" });
        }
      }
      if (block && argv[2] === "create") {
        return checkpointResult("chk_after_delay", argv[argv.indexOf("--id") + 1]!, "available");
      }
      return undefined;
    });
    await s.capture();
    const first = await s.provision("first"),
      second = await s.provision("second");
    const now = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const image = updateWarmImage({ createdAtMs: now - DAY_MS });
    block = true;
    const stopping = s.stop(first);
    await gate.entered;
    const selector = (await s.summary())?.capture?.selector;
    try {
      // Age alone cannot transfer an active capture's ownership.
      clock.mockReturnValue(now + 15 * DAY_MS);
      await s.stop(second);
      expect(await s.summary()).toMatchObject({ capture: { selector, stale: true } });
      expect(s.store.lookup(image.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
      const reused = await s.provision("while-capturing");
      expect(s.checkpoints("fork").at(-1)?.[3]).toBe(CHECKPOINT_ID);
      await s.stop(reused);
      expect(s.checkpoints("create")).toHaveLength(phase === "create" ? 2 : 1);
    } finally {
      gate.release();
    }
    await stopping;
    expect(s.commands("stop").length).toBeGreaterThan(0);
    if (!fails) {
      expect(s.calls.at(-1)?.argv[2]).toBe("delete");
    }
    expect(s.store.lookup(image.key)?.image?.checkpointId).toBe(
      fails ? CHECKPOINT_ID : "chk_after_delay",
    );
    expect((await s.summary())?.capture?.selector).toBe(
      fails && phase === "create" ? selector : undefined,
    );
  });

  it("recovers the exact uncertain claim after restart", async () => {
    let failCreate = false;
    const s = scenario(({ argv }) =>
      failCreate && argv[2] === "create"
        ? commandResult({ termination: "timeout", code: null, killed: true })
        : undefined,
    );
    await s.capture();
    const now = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(now + DAY_MS);
    failCreate = true;
    await s.capture("uncertain");
    const selector = (await s.summary())!.capture!.selector;
    await closeWarmState(s.provider);
    const restarted = scenario(undefined, s.stateDir);
    clock.mockReturnValue(now + 2 * DAY_MS);
    await restarted.capture("after-restart");
    expect(restarted.checkpoints("create")).toEqual([]);
    expect(restarted.checkpoints("fork")[0]?.[3]).toBe(CHECKPOINT_ID);
    expect((await restarted.summary())?.capture?.selector).toBe(selector);
    await recoverCrabboxWarmImageCapture(crabboxState, selector, true);
    expect((await restarted.summary())?.checkpointId).toBe(CHECKPOINT_ID);
    await restarted.capture("after-recovery");
    expect(restarted.checkpoints("create")).toHaveLength(1);
  });

  it.each([false, true])("fences recovered scrub completion (fails=%s)", async (fails) => {
    const gate = pause();
    let block = false;
    const s = scenario(async ({ argv }) => {
      if (!block || argv[1] !== "run") {
        return undefined;
      }
      block = false;
      await gate.wait();
      return fails ? commandResult({ code: 7 }) : undefined;
    });
    await s.capture();
    const image = updateWarmImage({ createdAtMs: Date.now() - DAY_MS });
    const lease = await s.provision("closed-scrub");
    block = true;
    const stopping = s.stop(lease);
    await gate.entered;
    try {
      await recoverCrabboxWarmImageCapture(
        crabboxState,
        (await s.summary())!.capture!.selector,
        true,
      );
      s.store.update(
        image.key,
        (current) =>
          current && {
            ...current,
            operation: captureOperation("replacement-generation", {
              leaseId: "cbx_replacement",
              provider: "aws",
              phase: "scrubbing",
            }),
          },
      );
    } finally {
      gate.release();
    }
    await stopping;
    expect(s.checkpoints("create")).toHaveLength(1);
    expect(await s.summary()).toMatchObject({
      capture: { selector: "replacement-generation" },
      checkpointId: CHECKPOINT_ID,
    });
  });

  it("reclaims idle images, never capture-owned images", async () => {
    const s = scenario();
    await s.capture();
    const image = s.entry(),
      now = Date.now();
    const retained = {
      ...image.value,
      image: { ...image.value.image!, lastDemandAtMs: now - DAY_MS },
      operation: captureOperation("capacity-capture", {
        leaseId: "cbx_capturing",
        provider: "aws",
      }),
    };
    s.store.register(image.key, retained);
    for (let index = 0; index < 127; index++) {
      s.store.register(`idle-${index}`, {
        ...image.value,
        image: { ...image.value.image!, checkpointId: `chk_idle_${index}`, lastDemandAtMs: now },
      });
    }
    s.calls.length = 0;
    await s.capture("different-profile", { ...PROFILE, class: "fast" });
    expect(s.checkpoints("delete").map((argv) => argv[3])).toEqual(["chk_idle_0"]);
    expect(s.checkpoints("create")).toHaveLength(1);
    expect(s.store.lookup(image.key)).toEqual(retained);
    expect(s.store.entries()).toHaveLength(128);
  });
});
