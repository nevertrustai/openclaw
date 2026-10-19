import { setImmediate as nextMacrotask } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
  takeMessageIdAfterStop,
} from "./draft-stream-controls.js";

type LifecycleOptions = Parameters<typeof createFinalizableDraftLifecycle<string>>[0];

function draft(messageId = "preview-old") {
  const message: { id: string | undefined } = { id: messageId };
  const options = {
    stopForClear: async () => {},
    readMessageId: () => message.id,
    clearMessageId: () => {
      message.id = undefined;
    },
    isValidMessageId: (value: unknown): value is string => typeof value === "string",
    warnPrefix: "cleanup failed",
  };
  const state = { stopped: false, final: false };
  const lifecycle = (
    overrides: Pick<LifecycleOptions, "deleteMessage"> & Partial<LifecycleOptions>,
  ) =>
    createFinalizableDraftLifecycle({
      ...options,
      state,
      throttleMs: 250,
      sendOrEditStreamMessage: async () => true,
      ...overrides,
    });
  return { message, options, state, lifecycle };
}

describe("draft-stream-controls", () => {
  it("takeMessageIdAfterStop stops, reads, and clears message id", async () => {
    const events: string[] = [];
    let messageId: string | undefined = "m-1";

    const result = await takeMessageIdAfterStop({
      stopForClear: async () => {
        events.push("stop");
      },
      readMessageId: () => {
        events.push("read");
        return messageId;
      },
      clearMessageId: () => {
        events.push("clear");
        messageId = undefined;
      },
    });

    expect(result).toBe("m-1");
    expect(messageId).toBeUndefined();
    expect(events).toEqual(["stop", "read", "clear"]);
  });

  it("clearFinalizableDraftMessage claims a failed delete and reports its retry target", async () => {
    const warn = vi.fn();
    const { message, options } = draft("m-3");
    const onDeleteFailure = vi.fn();
    const deleteMessage = vi.fn(async () => {
      throw new Error("boom");
    });

    await clearFinalizableDraftMessage({
      ...options,
      deleteMessage,
      onDeleteFailure,
      warn,
    });

    expect(message.id).toBeUndefined();
    expect(onDeleteFailure).toHaveBeenCalledWith("m-3");
    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");
  });

  it("clearFinalizableDraftMessage claims an id before concurrent clears", async () => {
    const { options } = draft("m-3");
    const pendingDelete = createDeferred();
    const deleteMessage = vi.fn(() => pendingDelete.promise);
    const clear = () =>
      clearFinalizableDraftMessage({
        ...options,
        deleteMessage,
      });

    const firstClear = clear();
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("m-3"));
    await clear();
    pendingDelete.resolve();
    await firstClear;

    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("clearFinalizableDraftMessage preserves a replacement id while delete is in flight", async () => {
    const { message, options } = draft();
    const pendingDelete = createDeferred();
    const deleteMessage = vi.fn(() => pendingDelete.promise);

    const clearPromise = clearFinalizableDraftMessage({
      ...options,
      deleteMessage,
    });
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));

    message.id = "preview-new";
    pendingDelete.resolve();
    await clearPromise;

    expect(message.id).toBe("preview-new");
  });

  it("clearFinalizableDraftMessage reports the failed target after its id is replaced", async () => {
    const { message, options } = draft();
    const pendingDelete = createDeferred();
    const onDeleteFailure = vi.fn();
    const deleteMessage = vi.fn(() => pendingDelete.promise);
    const clearPromise = clearFinalizableDraftMessage({
      ...options,
      deleteMessage,
      onDeleteFailure,
    });
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));

    message.id = "preview-new";
    pendingDelete.reject(new Error("boom"));
    await clearPromise;

    expect(onDeleteFailure).toHaveBeenCalledWith("preview-old");
    expect(message.id).toBe("preview-new");
  });

  it("lifecycle retries a failed old deletion after the current id is replaced", async () => {
    const { message, lifecycle: createLifecycle } = draft();
    const pendingDelete = createDeferred();
    const warn = vi.fn();
    const deleteMessage = vi
      .fn<(messageId: string) => Promise<void>>()
      .mockImplementationOnce(() => pendingDelete.promise)
      .mockResolvedValue(undefined);
    const lifecycle = createLifecycle({
      deleteMessage,
      warn,
    });

    const firstClear = lifecycle.clear();
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));
    message.id = "preview-new";
    pendingDelete.reject(new Error("boom"));
    await firstClear;

    expect(message.id).toBe("preview-new");
    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");

    await lifecycle.clear();

    expect(deleteMessage.mock.calls.map(([id]) => id)).toEqual([
      "preview-old",
      "preview-old",
      "preview-new",
    ]);
    expect(message.id).toBeUndefined();
  });

  it("lifecycle does not retry a successful delete when its success callback fails", async () => {
    const { message, lifecycle: createLifecycle } = draft();
    const deleteMessage = vi.fn(async () => {});
    const warn = vi.fn();
    const lifecycle = createLifecycle({
      deleteMessage,
      onDeleteSuccess: () => {
        throw new Error("callback boom");
      },
      warn,
    });

    await lifecycle.clear();
    await lifecycle.clear();

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(message.id).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("cleanup failed after delete: callback boom");
  });

  it("keeps deletion serialized when stop rejects during an earlier clear", async () => {
    const { message, state, lifecycle: createLifecycle } = draft();
    const deleteStarted = createDeferred();
    const releaseDelete = createDeferred();
    const pendingSend = createDeferred();
    const stopError = new Error("flush failed");
    const deletedIds: string[] = [];
    let activeDeletes = 0;
    let maxActiveDeletes = 0;
    const lifecycle = createLifecycle({
      throttleMs: 0,
      sendOrEditStreamMessage: () => pendingSend.promise,
      deleteMessage: async (id) => {
        deletedIds.push(id);
        activeDeletes += 1;
        maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
        try {
          if (id === "preview-old") {
            deleteStarted.resolve();
            await releaseDelete.promise;
          }
        } finally {
          activeDeletes -= 1;
        }
      },
    });
    const firstClear = lifecycle.clearWithStop(async () => {});
    let stopped: Promise<unknown> | undefined;
    let secondClear: Promise<void> | undefined;
    try {
      await deleteStarted.promise;
      message.id = "preview-new";
      lifecycle.update("Pending update");
      stopped = lifecycle.stop().catch((error: unknown) => error);
      expect(state.final).toBe(true);
      secondClear = lifecycle.clear();
      pendingSend.reject(stopError);
      // Let queued promise reactions run while the first physical deletion is still held.
      await nextMacrotask();
      expect(maxActiveDeletes).toBe(1);

      releaseDelete.resolve();
      await Promise.all([firstClear, secondClear]);
      expect(await stopped).toBe(stopError);
      expect(deletedIds).toEqual(["preview-old", "preview-new"]);
    } finally {
      pendingSend.resolve();
      releaseDelete.resolve();
      await Promise.allSettled([firstClear, stopped, secondClear]);
      lifecycle.loop.stop();
    }
  });

  it("lifecycle seal ignores late updates without clearing the preview id", async () => {
    const { message, state, lifecycle: createLifecycle } = draft("m-5");
    const sendOrEditStreamMessage = vi.fn(async () => true);
    const deleteMessage = vi.fn(async () => {});

    const lifecycle = createLifecycle({
      sendOrEditStreamMessage,
      deleteMessage,
    });

    lifecycle.update("stale");
    await lifecycle.seal();
    lifecycle.update("late");
    await lifecycle.loop.flush();

    expect(state.final).toBe(true);
    expect(message.id).toBe("m-5");
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);
    expect(sendOrEditStreamMessage).toHaveBeenCalledWith("stale");
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
