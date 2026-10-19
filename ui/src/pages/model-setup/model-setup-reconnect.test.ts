/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  callsFor,
  authButton,
  waitForElement,
  waitForText,
  configSnapshot,
  createFirstRunContext,
  detection as emptyDetection,
  runningStep,
} from "./model-setup-first-run.test-support.ts";
import type { TestModelSetupPage } from "./test-helpers/page.test-support.ts";
import {
  createPage,
  mountModelSetupPage,
  unmountModelSetupPage,
} from "./test-helpers/solid-page.test-support.tsx";

const detection: SystemAgentSetupDetectResult = {
  ...emptyDetection,
  authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
};

function createFixture() {
  const {
    context: originalContext,
    request,
    snapshot,
    publishGatewaySnapshot,
  } = createFirstRunContext();
  originalContext.runtimeConfig.dispose();
  const context = {
    ...originalContext,
    basePath: "",
    runtimeConfig: createRuntimeConfigCapability(originalContext.gateway),
  };
  context.gateway.connection.gatewayUrl = "ws://localhost";
  context.gateway.connection.token = "";
  const connectedSnapshot = {
    ...snapshot,
    hello: {
      ...snapshot.hello,
      features: { methods: ["openclaw.setup.detect", "openclaw.setup.verify"] },
    },
  };
  publishGatewaySnapshot(connectedSnapshot);
  const setGatewayPhase = (phase: "connected" | "reconnecting") => {
    publishGatewaySnapshot({
      ...connectedSnapshot,
      phase,
      hello: phase === "connected" ? { ...connectedSnapshot.hello } : null,
    });
  };
  return {
    context,
    request,
    runtimeConfig: context.runtimeConfig,
    setGatewayPhase,
    detectCalls: () => callsFor(request, "openclaw.setup.detect"),
  };
}

async function mountPage(context: ApplicationContext, visit = true): Promise<TestModelSetupPage> {
  const provider = createApplicationContextProvider(context);
  const page = createPage(context);
  if (visit) {
    page.routeData = { firstRun: false };
  }
  provider.append(page);
  document.body.append(provider);
  mountModelSetupPage(page);
  await page.updateComplete;
  return page;
}

function selectedModelDetail(page: TestModelSetupPage): string | undefined {
  return page.querySelector(".model-setup__current-copy > .muted")?.textContent?.trim();
}

describe("ModelSetupPage detection ownership", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("starts one detection when the visit arrives after mounting on a connected Gateway", async () => {
    const { context, request, runtimeConfig } = createFixture();
    request.mockResolvedValue(detection);
    const page = await mountPage(context, false);

    expect(request).not.toHaveBeenCalled();
    page.routeData = { firstRun: false };
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull();
    });
    runtimeConfig.dispose();
  });

  it("waits for the connected Gateway when the page mounts during reconnect", async () => {
    const { context, request, runtimeConfig, setGatewayPhase, detectCalls } = createFixture();
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect" ? detection : {},
    );
    setGatewayPhase("reconnecting");
    const page = await mountPage(context);

    expect(page.querySelector('[data-auth-choice="provider-auth"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    setGatewayPhase("connected");
    await vi.waitFor(() => {
      expect(detectCalls()).toHaveLength(1);
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull();
    });
    runtimeConfig.dispose();
  });

  it("cancels stale detection on reattach and accepts only the replacement result", async () => {
    const { context, request, runtimeConfig, detectCalls } = createFixture();
    const stale = createDeferred<SystemAgentSetupDetectResult>();
    let signal: AbortSignal | undefined;
    request.mockImplementationOnce(async (_method, _params, options) => {
      signal = options?.signal;
      return stale.promise;
    });
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect"
        ? { ...detection, configuredModel: "provider/current-model", setupComplete: true }
        : {},
    );
    const page = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(page.querySelector(".model-setup__loading")).not.toBeNull();
    const provider = page.parentElement!;
    unmountModelSetupPage(page);
    page.remove();
    page.routeData = { firstRun: false };
    provider.append(page);
    mountModelSetupPage(page);
    await vi.waitFor(() => expect(selectedModelDetail(page)).toBe("current-model"));
    expect(signal?.aborted).toBe(true);
    expect(detectCalls()).toHaveLength(2);
    expect(detectCalls().at(-1)).toEqual([
      "openclaw.setup.detect",
      { agentId: "main" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
    // A server can finish after local cancellation; it cannot publish into the next visit.
    stale.resolve({ ...detection, configuredModel: "provider/stale-model", setupComplete: true });
    await vi.waitFor(() => expect(request.mock.settledResults[0]?.type).toBe("fulfilled"));
    await page.updateComplete;
    expect(selectedModelDetail(page)).toBe("current-model");
    runtimeConfig.dispose();
  });

  it("recovers the selected provider wizard across a same-Gateway reconnect", async () => {
    const { context, request, runtimeConfig, setGatewayPhase } = createFixture();
    let oldWizardSignal: AbortSignal | undefined;
    let nextCalls = 0;
    request.mockImplementation(async (method, _params, options) => {
      if (method === "openclaw.setup.auth.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        nextCalls += 1;
        if (nextCalls > 1) {
          return runningStep({
            id: "provider-key",
            type: "text",
            message: "Enter the selected provider key",
            sensitive: true,
          });
        }
        oldWizardSignal = options?.signal;
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (method === "config.get") {
        return configSnapshot();
      }
      return method === "openclaw.setup.detect" ? detection : {};
    });
    const page = await mountPage(context);
    await waitForElement(page, '[data-auth-choice="provider-auth"]');
    authButton(page, "provider-auth")!.click();
    await vi.waitFor(() => expect(oldWizardSignal).toBeInstanceOf(AbortSignal));
    const start = request.mock.calls.find(([method]) => method === "openclaw.setup.auth.start")!;

    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");
    await waitForText(page, "Enter the selected provider key");
    expect(oldWizardSignal?.aborted).toBe(true);
    expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(1);
    expect(callsFor(request, "wizard.cancel")).toHaveLength(0);
    expect(request.mock.calls.findLast(([method]) => method === "wizard.next")?.[1]).toEqual({
      sessionId: (start[1] as { sessionId: string }).sessionId,
    });
    runtimeConfig.dispose();
  });
});
