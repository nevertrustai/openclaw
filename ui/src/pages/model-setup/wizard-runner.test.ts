import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import * as uuid from "../../lib/uuid.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { ModelSetupWizardRunner } from "./wizard-runner.ts";

type RunnerOptions = ConstructorParameters<typeof ModelSetupWizardRunner>[0];
const running = { done: false, status: "running" } as const;
const keyStep = { ...running, step: { id: "key", type: "text" } } as const;

function createRunner(options: Pick<RunnerOptions, "getClient"> & Partial<RunnerOptions>) {
  return new ModelSetupWizardRunner({
    getAgentId: () => null,
    onChange: () => undefined,
    requestFailedMessage: () => "failed",
    cancelledMessage: () => "cancelled",
    sessionExpiredMessage: () => "expired",
    gatewayNotRespondingMessage: () => "not responding",
    ...options,
  });
}

function runnerFixture(request: GatewayRequestHandler, options: Partial<RunnerOptions> = {}) {
  let client = createTestGatewayClient(request);
  const terminal = vi.fn();
  const runner = createRunner({ getClient: () => client, onStart: () => terminal, ...options });
  return {
    runner,
    terminal,
    rebind: (replacementRequest: GatewayRequestHandler) => {
      client = createTestGatewayClient(replacementRequest);
    },
  };
}

function pendingCancellation(pending: Promise<unknown>) {
  return vi.fn(async (method: string) => {
    if (method === "openclaw.setup.auth.start") {
      return running;
    }
    return method === "wizard.cancel" ? pending : keyStep;
  });
}

function pendingAnswer(pending: Promise<unknown>) {
  let nextCalls = 0;
  return vi.fn(async (method: string) => {
    if (method === "openclaw.setup.auth.start") {
      return running;
    }
    return ++nextCalls === 1 ? keyStep : pending;
  });
}

function lateAdmission(status: "running" | "busy" = "running", deadline = false) {
  let runningSession: string | null = null;
  let firstSessionId = "";
  let resolveFirstStart: () => void = () => {
    throw new Error("the first setup request did not start");
  };
  let startCount = 0;
  const request = vi.fn(
    async (
      method: string,
      params?: { sessionId?: string },
      options?: { signal?: AbortSignal; timeoutMs?: number | null },
    ) => {
      if (method === "openclaw.setup.auth.start") {
        const sessionId = params?.sessionId;
        if (!sessionId) {
          throw new Error("missing setup session");
        }
        if (startCount++ === 0) {
          firstSessionId = sessionId;
          return await new Promise((resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  new Error(deadline ? "aborted" : "Gateway retired the aborted start request"),
                ),
              { once: true },
            );
            if (deadline && typeof options?.timeoutMs === "number") {
              setTimeout(
                () => reject(new Error("Gateway retired the timed-out request")),
                options.timeoutMs,
              );
            }
            resolveFirstStart = () => {
              if (status === "busy") {
                reject(
                  new GatewayRequestError({
                    code: "UNAVAILABLE",
                    message: "Setup busy",
                    details: { code: "SETUP_ADMISSION_BUSY" },
                  }),
                );
                return;
              }
              runningSession = sessionId;
              resolve({ sessionId, ...running });
            };
          });
        }
        if (runningSession) {
          throw new Error("wizard already running");
        }
        return { sessionId, done: true, status: "done" };
      }
      if (method === "wizard.cancel") {
        if (runningSession !== params?.sessionId) {
          throw new Error("wizard not found");
        }
        runningSession = null;
        return { status: "cancelled" };
      }
      throw new Error(`unexpected request ${method}`);
    },
  );
  return {
    request,
    resolve: () => resolveFirstStart(),
    session: () => runningSession,
    firstSession: () => firstSessionId,
  };
}

describe("ModelSetupWizardRunner", () => {
  it.each(["runtime", "mcp"] as const)(
    "cancels late %s admission on its captured client",
    async (kind) => {
      const sessionId =
        kind === "runtime"
          ? "00000000-0000-4000-8000-000000000002"
          : "00000000-0000-4000-8000-000000000001";
      const generateUUID = vi.spyOn(uuid, "generateUUID").mockReturnValue(sessionId);
      const admission = createDeferred<WizardNextResult>();
      const original = new GatewayBrowserClient({ url: "ws://gateway-a.example.test" });
      const replacement = new GatewayBrowserClient({ url: "ws://gateway-b.example.test" });
      const originalRequest = vi
        .spyOn(original, "request")
        .mockReturnValueOnce(admission.promise)
        .mockResolvedValue({ status: "cancelled" });
      const replacementRequest = vi.spyOn(replacement, "request");
      let client = original;
      const getAgentId = vi.fn(() => (kind === "runtime" ? "wrong-agent" : "selected-agent"));
      const onStart = vi.fn();
      const runner = createRunner({ getClient: () => client, getAgentId, onStart });
      const params = {
        agentId: "research",
        runtimeId: "acp-opencode",
        configPatch: {
          plugins: { entries: { acpx: { config: { nativeAgents: { opencode: true } } } } },
        },
      };
      try {
        const start =
          kind === "runtime"
            ? runner.startRuntime(params, "OpenCode")
            : runner.startMcpLogin("docs");
        expect(originalRequest).toHaveBeenCalledWith(
          kind === "runtime" ? "openclaw.setup.runtime.start" : "mcp.authLogin",
          kind === "runtime" ? { ...params, sessionId } : { sessionId, serverName: "docs" },
          { timeoutMs: null },
        );
        expect(getAgentId).not.toHaveBeenCalled();
        if (kind === "mcp") {
          expect(onStart).toHaveBeenCalledWith("mcp.authLogin", undefined);
        }
        client = replacement;
        await runner.cancel();
        const cancellation = [
          "wizard.cancel",
          { sessionId, closeInput: true },
          { timeoutMs: 30_000 },
        ];
        expect(originalRequest.mock.calls[1]).toEqual(cancellation);
        admission.resolve(running);
        await expect(start).resolves.toBeNull();
        expect(originalRequest).toHaveBeenCalledTimes(3);
        expect(originalRequest.mock.calls.slice(1)).toEqual([cancellation, cancellation]);
        expect(replacementRequest).not.toHaveBeenCalled();
        expect(runner.state).toEqual({ phase: "idle" });
      } finally {
        admission.resolve({ done: true, status: "cancelled" });
        await runner.cancel();
        originalRequest.mockRestore();
        replacementRequest.mockRestore();
        generateUUID.mockRestore();
      }
    },
  );

  it("shares pending cancellation failure with teardown", async () => {
    const pending = createDeferred<unknown>();
    const request = pendingCancellation(pending.promise);
    const { runner, terminal } = runnerFixture(request, { getAgentId: () => "main" });
    await runner.start("provider-auth");
    const explicit = runner.requestCancellation();
    const teardown = runner.cancel();
    const callsBeforeAcknowledgment = request.mock.calls.filter(
      ([method]) => method === "wizard.cancel",
    );
    pending.reject(new Error("Cancellation transport disconnected"));
    await expect(Promise.all([explicit, teardown])).resolves.toEqual([undefined, undefined]);
    expect(callsBeforeAcknowledgment).toHaveLength(1);
    expect(runner.state).toEqual({ phase: "idle" });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("rebinds cancellation and retries settled attempts", async () => {
    const oldCancellation = createDeferred<unknown>();
    const originalRequest = pendingCancellation(oldCancellation.promise);
    let cancellations = 0;
    const replacementRequest = vi.fn(async (method: string) => {
      if (method === "wizard.next") {
        return keyStep;
      }
      if (method === "wizard.cancel") {
        cancellations += 1;
        if (cancellations === 1) {
          return { status: "running" };
        }
        if (cancellations === 2) {
          throw new Error("Cancellation transport disconnected");
        }
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected wizard request: ${method}`);
    });
    const { runner, terminal, rebind } = runnerFixture(originalRequest, {
      getAgentId: () => "main",
    });
    await runner.start("provider-auth");
    const pending = runner.requestCancellation();
    runner.suspend();
    rebind(replacementRequest);
    await runner.resume();
    await expect(runner.requestCancellation()).resolves.toBe("running");
    await expect(runner.requestCancellation()).rejects.toThrow(
      "Cancellation transport disconnected",
    );
    expect(runner.state).toMatchObject({ phase: "step", authChoice: "provider-auth" });
    await expect(runner.requestCancellation()).resolves.toBe("cancelled");
    expect(cancellations).toBe(3);
    expect(terminal).toHaveBeenCalledExactlyOnceWith({ done: true, status: "cancelled" });
    oldCancellation.resolve({ status: "cancelled" });
    await expect(pending).resolves.toBeUndefined();
    expect(terminal).toHaveBeenCalledOnce();
    expect(runner.state).toEqual({ phase: "idle" });
    expect(
      originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
    ).toHaveLength(1);
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "wizard.next",
      "wizard.cancel",
      "wizard.cancel",
      "wizard.cancel",
    ]);
  });

  it("retires detached admission authority on owner loss", async () => {
    const lateReply = createDeferred<WizardNextResult>();
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return await lateReply.promise;
      }
      if (method === "wizard.next") {
        return keyStep;
      }
      if (method === "wizard.cancel") {
        return await lateReply.promise;
      }
      throw new Error(`Unexpected wizard request: ${method}`);
    });
    const { runner, terminal: onTerminal } = runnerFixture(request, { getAgentId: () => "main" });
    const pending = runner.start("original-provider");
    runner.close({ retireOwner: true });
    const requestsAtRetirement = request.mock.calls.length;
    lateReply.resolve(running);
    await pending;
    expect(request).toHaveBeenCalledTimes(requestsAtRetirement);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(runner.state).toEqual({ phase: "idle" });
  });

  it("reconciles interrupted answers without replay or cancellation", async () => {
    const interrupted = createDeferred<unknown>();
    const originalRequest = pendingAnswer(interrupted.promise);
    const replacementRequest = vi.fn(
      async (_method: string, _params?: unknown, _options?: unknown) => ({
        done: false,
        status: "running",
        step: { id: "model-review", type: "note" },
      }),
    );
    const { runner, terminal, rebind } = runnerFixture(originalRequest, {
      getAgentId: () => "research",
    });
    await runner.start("meta-api-key");
    const answer = runner.answer("synthetic-key");
    runner.suspend();
    rebind(replacementRequest);
    await runner.resume();
    expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
      "wizard.next",
      { sessionId: expect.any(String) },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    interrupted.resolve({ done: true, status: "cancelled" });
    await answer;
    expect(terminal).not.toHaveBeenCalled();
    expect(runner.state).toMatchObject({
      phase: "step",
      authChoice: "meta-api-key",
      step: { id: "model-review" },
    });
    expect(
      originalRequest.mock.calls.filter(([method]) => method === "wizard.cancel"),
    ).toHaveLength(0);
  });

  it("reuses terminal replies received while disconnected", async () => {
    const terminalReply = createDeferred<unknown>();
    const request = pendingAnswer(terminalReply.promise);
    const afterReconnect = vi.fn();
    const {
      runner,
      terminal: onTerminal,
      rebind,
    } = runnerFixture(request, { getAgentId: () => "research" });
    await runner.start("meta-api-key");
    const answer = runner.answer("synthetic-key");
    runner.suspend();
    terminalReply.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/fixture-model" },
    });
    await answer;
    expect(onTerminal).not.toHaveBeenCalled();
    rebind(afterReconnect);
    expect(await runner.resume()).toMatchObject({
      modelActivation: { modelRef: "meta/fixture-model" },
    });
    expect(afterReconnect).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("advances notes without deadlines or duplicate answers", async () => {
    const done = createDeferred<unknown>();
    let nextCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "session-1", ...running };
      }
      if (method === "wizard.next" && ++nextCalls === 1) {
        return {
          ...running,
          step: { id: "note-1", type: "note", message: "Continue in browser" },
        };
      }
      return method === "wizard.next" ? done.promise : {};
    });
    const { runner } = runnerFixture(request, { getAgentId: () => "research" });

    await runner.start("openai-oauth");
    expect(request).toHaveBeenNthCalledWith(
      1,
      "openclaw.setup.auth.start",
      { sessionId: expect.any(String), agentId: "research", authChoice: "openai-oauth" },
      { timeoutMs: null },
    );
    expect(runner.state).toMatchObject({ phase: "step" });
    const answer = runner.answer(undefined, false);
    void runner.answer(undefined, false);
    expect(request).toHaveBeenCalledTimes(3);
    const reads = request.mock.calls.filter(([method]) => method === "wizard.next");
    expect(reads[1]?.[1]).toEqual({
      sessionId: expect.any(String),
      answer: { stepId: "note-1" },
    });
    expect(reads[1]?.[2]).toEqual(
      expect.objectContaining({ timeoutMs: null, signal: expect.any(AbortSignal) }),
    );
    done.resolve({ done: true, status: "done" });
    await expect(answer).resolves.toEqual({ startMethod: "openclaw.setup.auth.start" });
    expect(runner.state).toEqual({ phase: "done" });
  });

  it("releases late admission after close before restarting", async () => {
    const method = "openclaw.setup.auth.start";
    const fixture = lateAdmission();
    const { request } = fixture;
    const { runner, terminal: terminalResult } = runnerFixture(request);

    const firstStart = runner.start("original", method);
    runner.close();
    fixture.resolve();
    await firstStart;

    expect(fixture.session()).toBeNull();
    expect(terminalResult).toHaveBeenCalledWith({ done: true, status: "cancelled" });
    expect(request).toHaveBeenCalledWith(
      "wizard.cancel",
      { sessionId: fixture.firstSession() },
      { timeoutMs: 30_000 },
    );
    await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
    expect(runner.state).toEqual({ phase: "done" });
  });

  it.each([
    ["openclaw.setup.auth.start", "running"],
    ["openclaw.setup.auth.start", "busy"],
  ] as const)("retains late %s responses after deadline: %s", async (method, status) => {
    const terminal = status !== "running";
    vi.useFakeTimers();
    try {
      const fixture = lateAdmission(status, true);
      const { request } = fixture;
      const { runner, terminal: terminalResult } = runnerFixture(request);

      const timedOutStart = runner.start("original", method);
      await vi.advanceTimersByTimeAsync(30_000);
      await timedOutStart;
      expect(runner.state).toEqual({ phase: "error", message: "not responding" });

      fixture.resolve();
      await vi.runAllTimersAsync();
      expect(fixture.session()).toBeNull();
      expect(terminalResult).toHaveBeenCalledOnce();
      const cancelCalls = request.mock.calls.filter(
        ([requestMethod]) => requestMethod === "wizard.cancel",
      );
      const lateCancelCalls = cancelCalls.filter(
        ([, params]) => params?.sessionId === fixture.firstSession(),
      );
      expect(lateCancelCalls).toHaveLength(terminal ? 1 : 2);

      await runner.cancel();
      await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
      expect(runner.state).toEqual({ phase: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts expired sessions without cancellation or replay", async () => {
    let nextCount = 0;
    let answerSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "session-expired", ...running };
        }
        if (method === "wizard.next" && nextCount++ === 0) {
          return {
            ...running,
            step: { id: "api-key", type: "text", message: "API key", sensitive: true },
          };
        }
        if (method === "wizard.next") {
          answerSignal = options?.signal;
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "wizard not found",
            details: { code: "WIZARD_NOT_FOUND" },
          });
        }
        return { ok: true };
      },
    );
    const { runner } = runnerFixture(request, {
      sessionExpiredMessage: () => "Setup expired. Close and restart setup.",
    });

    await runner.start("api-key");
    await runner.answer("secret-key");

    expect(runner.state).toEqual({
      phase: "error",
      message: "Setup expired. Close and restart setup.",
    });
    expect(answerSignal?.aborted).toBe(true);
    await runner.cancel();
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.auth.start"),
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
  });
});
