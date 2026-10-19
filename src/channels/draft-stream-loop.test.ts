import { setImmediate as nextMacrotask } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const useClock = (now = 10_000) => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
};

type LoopOptions<T> = Parameters<typeof createDraftStreamLoop<T>>[0];

function createLoop<T = string>(
  sendOrEditStreamMessage: LoopOptions<T>["sendOrEditStreamMessage"],
  overrides: Partial<LoopOptions<T>> = {},
) {
  return createDraftStreamLoop<T>({
    throttleMs: 0,
    isStopped: () => false,
    sendOrEditStreamMessage,
    ...overrides,
  });
}

function blockedSend<T = string>(nextResult?: boolean) {
  const pending = createDeferred<boolean | void>();
  const send = vi
    .fn<LoopOptions<T>["sendOrEditStreamMessage"]>()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(nextResult);
  return { pending, send };
}

function backgroundError() {
  const received = createDeferred<unknown>();
  const onBackgroundFlushError = vi.fn(received.resolve);
  return { received: received.promise, onBackgroundFlushError };
}

describe("createDraftStreamLoop", () => {
  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["unchanged", "rejected"])(
    "sends a newer coalesced value after an %s send",
    async (outcome) => {
      useClock();
      const { pending, send } = blockedSend(true);
      const error = new Error("send rejected");
      const { received, onBackgroundFlushError } = backgroundError();
      const loop = createLoop(send, {
        throttleMs: 1_000,
        coalesceInFlight: true,
        onBackgroundFlushError,
      });
      loop.update("First snapshot");
      loop.update("New milestone");
      if (outcome === "rejected") {
        pending.reject(error);
        await expect(loop.waitForInFlight()).rejects.toBe(error);
        await received;
        expect(onBackgroundFlushError).toHaveBeenCalledExactlyOnceWith(error);
      } else {
        pending.resolve(false);
        await loop.waitForInFlight();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith("New milestone");
      loop.stop();
    },
  );

  it("coalesces updates arriving during a send without delaying explicit attention flushes", async () => {
    useClock();
    const { pending, send } = blockedSend();
    const loop = createLoop(send, {
      throttleMs: 1_000,
      coalesceInFlight: true,
    });
    loop.update("First milestone");
    loop.update("Second milestone");
    loop.update("Latest milestone");
    pending.resolve();
    await loop.waitForInFlight();
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith("Latest milestone");
    loop.update("Approval required");
    await loop.flush();
    expect(send).toHaveBeenLastCalledWith("Approval required");
    loop.stop();
  });

  it("takes the latest queued text without interrupting the in-flight send", async () => {
    useClock(0);
    const { pending, send } = blockedSend(true);
    const loop = createLoop(send);

    loop.update("in flight");
    await flushMicrotasks();
    loop.update("queued first");
    loop.update("queued latest");

    expect(vi.getTimerCount()).toBe(1);
    expect(loop.takePending()).toBe("queued latest");
    expect(vi.getTimerCount()).toBe(0);

    pending.resolve(true);
    await loop.waitForInFlight();
    await flushMicrotasks();

    expect(send).toHaveBeenCalledExactlyOnceWith("in flight");
  });

  it("contains synchronous sender failures from background flushes", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const error = new Error("send failed");
      const { received, onBackgroundFlushError } = backgroundError();
      const send = vi.fn(async (_text: string) => true);
      send.mockImplementationOnce(() => {
        throw error;
      });
      const loop = createLoop(send, { onBackgroundFlushError });

      loop.update("hello");
      await received;
      await nextMacrotask();
      await loop.flush();

      expect(rejections).toStrictEqual([]);
      expect(onBackgroundFlushError).toHaveBeenCalledWith(error);
      expect(send.mock.calls).toEqual([["hello"], ["hello"]]);
      await nextMacrotask();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves generic pending updates when consecutive sends return false", async () => {
    const initial = { text: "initial", blocks: ["initial-blocks"] };
    const latest = { text: "latest", blocks: ["latest-blocks"] };
    const { pending, send } = blockedSend<typeof initial>();
    send.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const loop = createLoop(send, {
      emptyValue: { text: "", blocks: [] },
      isEmpty: (update) => !update.text,
    });

    loop.update(initial);
    await flushMicrotasks();
    loop.update(latest);
    pending.resolve(false);
    await loop.flush();
    await loop.flush();

    expect(send.mock.calls).toEqual([[initial], [latest], [latest]]);
  });
});
