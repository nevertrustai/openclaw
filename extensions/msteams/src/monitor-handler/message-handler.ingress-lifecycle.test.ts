import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createMSTeamsIngress } from "../msteams-ingress.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  createMessageHandlerDeps,
  createTurnContext,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const openDM: OpenClawConfig = {
  channels: { msteams: { dmPolicy: "open", allowFrom: ["*"] } },
};

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return { ...actual, createChannelIngressMonitor: vi.fn(actual.createChannelIngressMonitor) };
});

function createLifecycle(): MSTeamsIngressLifecycle & {
  onAdopted: ReturnType<typeof vi.fn>;
  onAbandoned: ReturnType<typeof vi.fn>;
} {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
  };
}

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return createTurnContext(activity, { sent: "sent", updated: "updated" });
}

function directActivity(id: string, text: string): MSTeamsTurnContext["activity"] {
  return buildChannelActivity({
    id,
    text,
    conversation: { id: "dm-conversation", conversationType: "personal" },
    channelData: {},
    entities: [],
  }) as MSTeamsTurnContext["activity"];
}

function createHandler(cfg = openDM, createDebouncer = createInboundDebouncer, debounceMs = 40) {
  const { deps } = createMessageHandlerDeps(cfg, {
    createInboundDebouncer: createDebouncer,
    resolveInboundDebounceMs: vi.fn(() => debounceMs),
  });
  return createMSTeamsMessageHandler(deps);
}
function expectAdopted(lifecycle: ReturnType<typeof createLifecycle>) {
  expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1);
  expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
}

function createClockedDebounce() {
  vi.useFakeTimers();
  let drain = async () => {};
  const createDebouncer: typeof createInboundDebouncer = (options) => {
    const debouncer = createInboundDebouncer(options);
    drain = debouncer.drain;
    return debouncer;
  };
  const flush = async (milliseconds: number) => {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await drain();
  };
  return {
    createDebouncer,
    flush,
    async close() {
      try {
        await flush(40);
      } finally {
        vi.useRealTimers();
      }
    },
  };
}

describe("Microsoft Teams drain claim ownership", () => {
  beforeEach(() => {
    dispatch.mockClear();
  });

  it.each([
    {
      name: "merged-flush constituents",
      cfg: { ...openDM, messages: { inbound: { debounceMs: 40 } } },
      messages: [
        directActivity("activity-first", "part one"),
        directActivity("activity-second", "part two"),
      ],
      delay: 40,
      dispatches: 1,
      body: "part one\npart two",
    },
    {
      name: "mention-gated no-dispatch turn",
      cfg: { channels: { msteams: { groupPolicy: "open" as const, requireMention: true } } },
      messages: [
        buildChannelActivity({ id: "activity-gated", text: "not for the bot", entities: [] }),
      ],
      delay: 20,
      dispatches: 0,
      body: undefined,
    },
  ])(
    "adopts every deferred claim for $name",
    async ({ cfg, messages, delay, dispatches, body }) => {
      const clock = createClockedDebounce();
      const handler = createHandler(cfg, clock.createDebouncer, delay);
      const claims = messages.map(() => createLifecycle());
      try {
        for (const [index, message] of messages.entries()) {
          expect(await handler(context(message), claims[index])).toEqual({ kind: "deferred" });
        }
        await clock.flush(delay);
        expect(dispatch).toHaveBeenCalledTimes(dispatches);
        for (const claim of claims) {
          expectAdopted(claim);
        }
        if (body) {
          expect(dispatch.mock.calls[0]?.[0].ctx.BodyForAgent).toContain(body);
        }
      } finally {
        await clock.close();
      }
    },
  );

  it("dispatches HTML-only text through the immediate debounce flush without double stripping", async () => {
    const handler = createHandler();
    const lifecycle = createLifecycle();

    await handler(
      context({
        ...directActivity("activity-html", ""),
        attachments: [
          {
            contentType: "TEXT/HTML",
            content: "<at>Bot</at><p>Use x &lt; 5 &copy;; literal &lt;at&gt;Alice&lt;/at&gt;</p>",
          },
        ],
      }),
      lifecycle,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      ctx: { BodyForAgent: expect.stringContaining("Use x < 5 ©; literal <at>Alice</at>") },
      replyOptions: { turnAdoptionLifecycle: { admission: "exclusive" } },
    });
    expectAdopted(lifecycle);
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-abandon-"));
    const stateDir = await fs.realpath(created);
    type Queue = NonNullable<Parameters<typeof createMSTeamsIngress>[0]["queue"]>;
    type Payload = Parameters<Queue["enqueue"]>[1];
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "msteams",
      accountId: "test-app",
      stateDir,
    });
    const incoming = directActivity("activity-abandon", "retry me");
    await queue.enqueue(
      "activity-abandon",
      { version: 1, receivedAt: now - 2 * 24 * 60 * 60_000, rawActivity: JSON.stringify(incoming) },
      { laneKey: "dm-conversation", receivedAt: now - 2 * 24 * 60 * 60_000 },
    );
    const dispatchMock = dispatch;
    const priorImplementation = dispatchMock.getMockImplementation();
    dispatchMock.mockRejectedValue(new Error("Microsoft Teams dispatch failed before adoption"));

    let stopCurrent: (() => Promise<void>) | undefined;
    const createIntegratedIngress = () => {
      let capturedDrain: (() => Promise<void>) | undefined;
      const createDebouncer: typeof createInboundDebouncer = (options) => {
        const debouncer = createInboundDebouncer(options);
        capturedDrain = debouncer.drain;
        return debouncer;
      };
      const handler = createHandler(openDM, createDebouncer);
      const ingress = createMSTeamsIngress({
        accountId: "test-app",
        queue,
        runtime: { error: vi.fn(), log: vi.fn() },
        dispatch: async (activity, lifecycle) => await handler(context(activity), lifecycle),
      });
      const monitorResult = vi.mocked(createChannelIngressMonitor).mock.results.at(-1);
      if (monitorResult?.type !== "return" || !capturedDrain) {
        throw new Error("Expected the Microsoft Teams ingress and debounce owners");
      }
      const monitor = monitorResult.value;
      const drainDebounce = capturedDrain;
      stopCurrent = async () => {
        await monitor.pause();
        await monitor.waitForIdle();
        await vi.advanceTimersByTimeAsync(40);
        await drainDebounce();
        await ingress.stop();
      };
      return { ...ingress, waitForIdle: monitor.waitForIdle, drainDebounce };
    };
    type Pending = Awaited<ReturnType<typeof queue.listPending>>[number];
    const restart = async (
      timestamp: number,
      expected: number | Pending,
      dispatches: number,
      replay = true,
    ) => {
      vi.setSystemTime(timestamp);
      const ingress = createIntegratedIngress();
      ingress.start();
      if (replay) {
        await ingress.accept(incoming);
      }
      await ingress.waitForIdle();
      if (typeof expected === "number") {
        await vi.advanceTimersByTimeAsync(40);
        await ingress.drainDebounce();
      }
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toEqual([
        typeof expected === "number"
          ? expect.objectContaining({
              id: "activity-abandon",
              attempts: expected,
              lastAttemptAt: expect.any(Number),
              lastError: "turn-abandoned",
            })
          : expected,
      ]);
      expect(dispatchMock).toHaveBeenCalledTimes(dispatches);
      const observed = pending[0];
      if (!observed || observed.lastAttemptAt === undefined) {
        throw new Error("Missing Microsoft Teams retry timestamp");
      }
      await ingress.stop();
      return { ...observed, lastAttemptAt: observed.lastAttemptAt };
    };

    try {
      const firstAttempt = await restart(now, 1, 1, false);
      await restart(firstAttempt.lastAttemptAt + 999, firstAttempt, 1);
      const secondAttempt = await restart(firstAttempt.lastAttemptAt + 1_001, 2, 2);

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("activity-abandon", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Microsoft Teams seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }
      const thresholdAttempt = await restart(
        secondAttempt.lastAttemptAt + 64_001,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        3,
      );

      const beyondAttempt = await restart(
        thresholdAttempt.lastAttemptAt + 128_001,
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1,
        4,
      );
      await restart(beyondAttempt.lastAttemptAt + 1_000, beyondAttempt, 4);
    } finally {
      try {
        await stopCurrent?.();
      } finally {
        vi.useRealTimers();
        dispatchMock.mockReset();
        if (priorImplementation) {
          dispatchMock.mockImplementation(priorImplementation);
        }
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    }
  });
});
