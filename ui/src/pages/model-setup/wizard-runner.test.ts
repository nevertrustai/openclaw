import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import * as uuid from "../../lib/uuid.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { callsFor } from "./model-setup-first-run.test-support.ts";
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

function startedWizard(reply: (method: string) => unknown) {
  return vi.fn(async (method: string) =>
    method === "openclaw.setup.auth.start" ? running : reply(method),
  );
}

function pendingCancellation(pending: Promise<unknown>) {
  return startedWizard((method) => (method === "wizard.cancel" ? pending : keyStep));
}

function pendingAnswer(pending: Promise<unknown>) {
  let nextCalls = 0;
  return startedWizard(() => (++nextCalls === 1 ? keyStep : pending));
}

function lateAdmission(status: "running" | "busy" = "running", deadline = false) {
  const admission = createDeferred<WizardNextResult>();
  let runningSession: string | null = null;
  let firstSessionId = "";
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
          options?.signal?.addEventListener(
            "abort",
            () =>
              admission.reject(
                new Error(deadline ? "aborted" : "Gateway retired the aborted start request"),
              ),
            { once: true },
          );
          if (deadline && typeof options?.timeoutMs === "number") {
            setTimeout(
              () => admission.reject(new Error("Gateway retired the timed-out request")),
              options.timeoutMs,
            );
          }
          return admission.promise;
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
    resolve: () => {
      if (status === "busy") {
        admission.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Setup busy",
            details: { code: "SETUP_ADMISSION_BUSY" },
          }),
        );
      } else {
        runningSession = firstSessionId;
        admission.resolve({ sessionId: firstSessionId, ...running });
      }
    },
    session: () => runningSession,
    firstSession: () => firstSessionId,
  };
}

describe("ModelSetupWizardRunner", () => {
  it.each(["runtime", "mcp"] as const)(
    "cancels late %s admission on its captured client",
    async (kind) => {
      const sessionId = "00000000-0000-4000-8000-000000000001";
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
      const getAgentId = vi.fn(() => "wrong-agent");
      const onStart = vi.fn();
      const runner = createRunner({ getClient: () => client, getAgentId, onStart });
      const params = {
        agentId: "research",
        runtimeId: "acp-opencode",
        configPatch: { fixture: "enable-runtime" },
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
    const callsBeforeAcknowledgment = callsFor(request, "wizard.cancel");
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
    expect(callsFor(originalRequest, "wizard.cancel")).toHaveLength(1);
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "wizard.next",
      ...Array<string>(3).fill("wizard.cancel"),
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

  it.each(["interrupted", "terminal"] as const)(
    "reconciles %s replies across reconnect",
    async (outcome) => {
      const reply = createDeferred<unknown>();
      const request = pendingAnswer(reply.promise);
      const replacement = vi.fn<GatewayRequestHandler>().mockResolvedValue({
        ...running,
        step: { id: "model-review", type: "note" },
      });
      const { runner, terminal, rebind } = runnerFixture(request, { getAgentId: () => "research" });
      await runner.start("meta-api-key");
      const answer = runner.answer("synthetic-key");
      runner.suspend();
      if (outcome === "terminal") {
        reply.resolve({
          done: true,
          status: "done",
          modelActivation: { modelRef: "meta/fixture-model" },
        });
        await answer;
        expect(terminal).not.toHaveBeenCalled();
      }
      rebind(replacement);
      const resumed = await runner.resume();
      if (outcome === "terminal") {
        expect(resumed).toMatchObject({ modelActivation: { modelRef: "meta/fixture-model" } });
        expect(replacement).not.toHaveBeenCalled();
        expect(terminal).toHaveBeenCalledOnce();
      } else {
        expect(replacement).toHaveBeenCalledExactlyOnceWith(
          "wizard.next",
          { sessionId: expect.any(String) },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        reply.resolve({ done: true, status: "cancelled" });
        await answer;
        expect(terminal).not.toHaveBeenCalled();
        expect(runner.state).toMatchObject({
          phase: "step",
          authChoice: "meta-api-key",
          step: { id: "model-review" },
        });
        expect(callsFor(request, "wizard.cancel")).toHaveLength(0);
      }
    },
  );

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
    const reads = callsFor(request, "wizard.next");
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

  it.each(["closed", "running", "busy"] as const)(
    "releases late admission after %s",
    async (outcome) => {
      const method = "openclaw.setup.auth.start";
      const deadline = outcome !== "closed";
      if (deadline) {
        vi.useFakeTimers();
      }
      const fixture = lateAdmission(outcome === "busy" ? "busy" : "running", deadline);
      const { request } = fixture;
      const { runner, terminal } = runnerFixture(request);
      try {
        const started = runner.start("original", method);
        if (deadline) {
          await vi.advanceTimersByTimeAsync(30_000);
          await started;
          expect(runner.state).toEqual({ phase: "error", message: "not responding" });
        } else {
          runner.close();
        }
        fixture.resolve();
        if (deadline) {
          await vi.runAllTimersAsync();
        } else {
          await started;
        }
        expect(fixture.session()).toBeNull();
        if (deadline) {
          expect(terminal).toHaveBeenCalledOnce();
          const lateCancels = callsFor(request, "wizard.cancel").filter(
            ([, params]) => params?.sessionId === fixture.firstSession(),
          );
          expect(lateCancels).toHaveLength(outcome === "busy" ? 1 : 2);
          await runner.cancel();
        } else {
          expect(terminal).toHaveBeenCalledWith({ done: true, status: "cancelled" });
          expect(request).toHaveBeenCalledWith(
            "wizard.cancel",
            { sessionId: fixture.firstSession() },
            { timeoutMs: 30_000 },
          );
        }
        await expect(runner.start("replacement", method)).resolves.toEqual({ startMethod: method });
        expect(runner.state).toEqual({ phase: "done" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
    expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(1);
    expect(callsFor(request, "wizard.next")).toHaveLength(2);
    expect(callsFor(request, "wizard.cancel")).toEqual([]);
  });
});
