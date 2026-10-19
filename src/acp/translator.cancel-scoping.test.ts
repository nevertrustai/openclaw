import type { PromptResponse } from "@agentclientprotocol/sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { promptAgent } from "./translator.prompt-harness.test-support.js";
import { createTranslatorScenario, expectSingleCall } from "./translator.scenario.test-support.js";

const SESSION_KEY = "agent:main:shared";
const SESSION_ID = "session-1";

function chat(runId: string, payload: Record<string, unknown> = {}): EventFrame {
  return {
    type: "event",
    event: "chat",
    payload: { runId, sessionKey: SESSION_KEY, seq: 1, state: "final", ...payload },
  };
}

function tool(runId: string, toolCallId = "tool-2"): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      stream: "tool",
      data: { phase: "start", name: "read_file", toolCallId, args: { path: "notes.txt" } },
    },
  };
}

function createHarness(
  options: {
    sessions?: string[];
    accepted?: boolean;
    provenanceMode?: "meta";
    send?: () => Promise<Record<string, unknown>>;
  } = {},
) {
  const runIds: string[] = [];
  const request = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === "chat.send") {
        const runId = expectDefined(params?.idempotencyKey as string | undefined, "Gateway run id");
        runIds.push(runId);
        if (options.send) {
          return options.send();
        }
        return options.accepted ? { runId, status: "started" } : new Promise<never>(() => {});
      }
      return {};
    },
  );
  const { agent, sessionStore, sessionUpdate } = createTranslatorScenario(request, {
    sessions: options.sessions,
    sessionKey: SESSION_KEY,
    provenanceMode: options.provenanceMode,
  });
  return { agent, request, sessionUpdate, sessionStore, runIds };
}

type Harness = ReturnType<typeof createHarness>;
type Pending = { promptPromise: Promise<PromptResponse>; runId: string };

function blockAbort(h: Harness, first: Pending) {
  const settled = vi.fn();
  void first.promptPromise.then(settled);
  const started = createDeferred();
  const released = createDeferred();
  h.request.mockImplementationOnce(async (method) => {
    expect(method).toBe("chat.abort");
    expect(settled).not.toHaveBeenCalled();
    started.resolve();
    await released.promise;
    return {};
  });
  return { started: started.promise, release: released.resolve };
}

async function start(h: Harness, sessionId = SESSION_ID): Promise<Pending> {
  const before = h.runIds.length;
  const promptPromise = promptAgent(h.agent, sessionId);
  await vi.waitFor(() => expect(h.runIds).toHaveLength(before + 1));
  return {
    promptPromise,
    runId: expectDefined(h.runIds[before], "submitted run id"),
  };
}

async function finish(h: Harness, pending: Pending, seq = 1) {
  await h.agent.handleGatewayEvent(chat(pending.runId, { seq }));
  await expect(pending.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
}

function expectAbort(h: Harness, runId: string) {
  expect(h.request).toHaveBeenCalledWith("chat.abort", { sessionKey: SESSION_KEY, runId });
}

async function blockedReplacement(accepted = false, text = "hello") {
  const h = createHarness({ accepted });
  const first = await start(h);
  const abort = blockAbort(h, first);
  const replacement = promptAgent(h.agent, SESSION_ID, text);
  await abort.started;
  return { h, first, abort, replacement };
}

describe("acp translator cancel and run scoping", () => {
  it("closes a replacement while its prior abort is pending and removes the session", async () => {
    const { h, first, abort, replacement } = await blockedReplacement();
    const closed = h.agent.closeSession({ sessionId: SESSION_ID, _meta: {} });
    expectAbort(h, first.runId);
    expect(h.runIds).toEqual([first.runId]);
    abort.release();
    await expect(closed).resolves.toEqual({});
    expect(h.runIds).toEqual([first.runId]);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
    expect(h.sessionStore.getSession(SESSION_ID)).toBeUndefined();
  });

  it("settles shutdown when a superseded prompt's abort never returns", async () => {
    const h = createHarness();
    const first = await start(h);
    h.request.mockImplementationOnce(async (method) => {
      expect(method).toBe("chat.abort");
      return new Promise<never>(() => {});
    });
    const replacement = promptAgent(h.agent);
    await vi.waitFor(() => expectAbort(h, first.runId));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      h.agent.shutdown().then(() => "closed"),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("still pending"), 25);
      }),
    ]);
    clearTimeout(timeout);
    expect(result).toBe("closed");
    expect(h.runIds).toEqual([first.runId]);
    await expect(replacement).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("closes an admitted prompt when shutdown interrupts its blocked final snapshot", async ({
    signal,
  }) => {
    const h = createHarness({ accepted: true });
    const pending = await start(h);
    const started = createDeferred();
    const snapshot = createDeferred<Record<string, unknown>>();
    h.request.mockImplementation(async (method) => {
      if (method === "sessions.list") {
        started.resolve();
        return snapshot.promise;
      }
      return {};
    });
    const terminalEvent = h.agent.handleGatewayEvent(chat(pending.runId));
    await started.promise;
    const shutdown = h.agent.shutdown();
    try {
      await withinTest(shutdown, signal);
      await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    } finally {
      snapshot.resolve({ sessions: [] });
      await terminalEvent;
      await shutdown;
    }
  });

  it("closes every queued overlapping admission when cancellation wins the blocked abort", async () => {
    const { h, first, abort, replacement: second } = await blockedReplacement();
    const third = promptAgent(h.agent);
    const cancellation = h.agent.cancel({ sessionId: SESSION_ID });
    abort.release();
    await cancellation;
    expect(h.runIds).toEqual([first.runId]);
    for (const prompt of [first.promptPromise, second, third]) {
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    }
  });

  it("submits only the latest of three overlapping prompts after the active abort settles", async () => {
    const { h, first, abort, replacement: second } = await blockedReplacement(true, "second");
    const third = promptAgent(h.agent, SESSION_ID, "third");
    await Promise.resolve();
    expectAbort(h, first.runId);
    expect(h.runIds).toEqual([first.runId]);
    abort.release();
    await vi.waitFor(() => expect(h.runIds).toHaveLength(2));
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.send",
      "chat.abort",
      "chat.send",
    ]);
    expect(
      h.request.mock.calls
        .filter(([method]) => method === "chat.send")
        .map(([, params]) => params?.message),
    ).toEqual(["[Working directory: /tmp]\n\nhello", "[Working directory: /tmp]\n\nthird"]);
    const runId = expectDefined(h.runIds[1], "latest admitted run");
    expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(runId);
    await finish(h, { promptPromise: third, runId });
  });

  it("does not replay a superseded prompt after its delayed provenance rejection", async () => {
    const firstSend = createDeferred<Record<string, unknown>>();
    let sends = 0;
    const h = createHarness({
      provenanceMode: "meta",
      send: () => (sends++ === 0 ? firstSend.promise : new Promise<never>(() => {})),
    });
    const first = await start(h);
    const replacement = await start(h);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    firstSend.reject(
      Object.assign(new Error("system provenance fields require admin scope"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(h.runIds).toEqual([first.runId, replacement.runId]);
    expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
    await finish(h, replacement);
  });

  it("does not let a stale cancel completion remove a newer prompt", async () => {
    const h = createHarness();
    const first = await start(h);
    const abort = blockAbort(h, first);
    const cancellation = h.agent.cancel({ sessionId: SESSION_ID });
    await abort.started;
    const replacement = await start(h);
    abort.release();
    await cancellation;
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
    await finish(h, replacement);
  });

  it("cancel uses pending runId when there is no active run", async () => {
    const h = createHarness();
    const pending = await start(h);
    h.sessionStore.clearActiveRun(SESSION_ID);
    await h.agent.cancel({ sessionId: SESSION_ID });
    expectAbort(h, pending.runId);
    await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("cancel from an idle session does not abort another session sharing its key", async () => {
    const h = createHarness({ sessions: [SESSION_ID, "session-2"] });
    const pending = await start(h, "session-2");
    await h.agent.cancel({ sessionId: SESSION_ID });
    expect(h.request.mock.calls.filter(([method]) => method === "chat.abort")).toEqual([]);
    expect(h.sessionStore.getSession("session-2")?.activeRunId).toBe(pending.runId);
    await finish(h, pending);
  });

  it("drops stale text from a final snapshot after replacement during thought delivery", async () => {
    const h = createHarness();
    const first = await start(h);
    const started = createDeferred();
    const released = createDeferred();
    h.sessionUpdate.mockImplementationOnce(async () => {
      started.resolve();
      await released.promise;
    });
    const staleSnapshot = h.agent.handleGatewayEvent(
      chat(first.runId, {
        message: {
          content: [
            { type: "thinking", thinking: "old hidden thought" },
            { type: "text", text: "old visible response" },
          ],
        },
      }),
    );
    await started.promise;
    expect(h.sessionUpdate).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "old hidden thought" },
      },
    });
    const replacement = await start(h);
    released.resolve();
    await staleSnapshot;
    expect(
      h.sessionUpdate.mock.calls.filter(
        ([payload]) => payload.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toEqual([]);
    expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(replacement.runId);
    await expect(first.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    await finish(h, replacement, 2);
  });

  it("routes only matching run events when session keys are shared", async () => {
    const h = createHarness({ sessions: [SESSION_ID, "session-2"] });
    const first = await start(h);
    const second = await start(h, "session-2");
    h.sessionUpdate.mockClear();
    await h.agent.handleGatewayEvent(chat("run-other"));
    await h.agent.handleGatewayEvent(tool("run-other"));
    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(first.runId);
    expect(h.sessionStore.getSession("session-2")?.activeRunId).toBe(second.runId);
    await h.agent.handleGatewayEvent(tool(second.runId));
    expectSingleCall(h.sessionUpdate, {
      sessionId: "session-2",
      update: { sessionUpdate: "tool_call", toolCallId: "tool-2", status: "in_progress" },
    });
    await finish(h, second, 2);
    expect(h.sessionStore.getSession(SESSION_ID)?.activeRunId).toBe(first.runId);
    await finish(h, first, 3);
  });
});
