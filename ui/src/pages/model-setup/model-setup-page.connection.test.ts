/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { listSetupInferenceAuthOptions } from "../../../../src/system-agent/setup-inference-auth-options.js";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  authButton,
  pageButton,
  mountDetection,
  mockRequests,
  runningStep,
  callsFor,
} from "./model-setup-first-run.test-support.ts";
import {
  createContext,
  detection,
  type TestModelSetupPage,
} from "./test-helpers/page.test-support.ts";

const authStatus: ModelAuthStatusResult = {
  ts: 1,
  providers: [],
  providerCapabilities: [
    {
      provider: "radius",
      apiKeySupported: false,
      quickApiKeySetup: false,
      loginOptions: [
        {
          id: "radius/radius",
          brandId: "radius",
          label: "Radius account",
          kind: "oauth",
          featured: true,
        },
      ],
    },
  ],
};

const setup = {
  ...detection,
  authOptions: listSetupInferenceAuthOptions([
    {
      pluginId: "setup-only",
      providerId: "setup-only",
      methodId: "oauth",
      choiceId: "setup-only",
      choiceLabel: "Setup-only account",
      appGuidedAuth: "oauth",
      onboardingFeatured: true,
    },
  ]),
};
const configSnapshot = {
  config: {},
  sourceConfig: {},
  raw: "{}",
  hash: "unchanged",
  valid: true,
  issues: [],
};
function configureRequests(
  request: ReturnType<typeof createContext>["request"],
  handlers: Parameters<typeof mockRequests>[1],
) {
  mockRequests(request, {
    "models.authStatus": () => authStatus,
    "config.get": () => configSnapshot,
    "openclaw.setup.detect": () => setup,
    ...handlers,
  });
}

const signInMethod = (operation: "connect" | "setup") =>
  operation === "connect" ? "models.authLogin" : "openclaw.setup.auth.start";
const labelFor = (operation: "connect" | "setup") =>
  operation === "connect" ? "Radius account" : "Setup-only account";

async function startSignIn(page: TestModelSetupPage, operation: "connect" | "setup") {
  if (operation === "setup") {
    authButton(page, "setup-only")!.click();
    return;
  }
  pageButton(page, "[data-models-connect]")!.click();
  await waitForFast(() =>
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain("Radius account"),
  );
  pageButton(page, '[data-models-login-provider="radius"]')!.click();
  await page.updateComplete;
  [...page.querySelectorAll<HTMLButtonElement>("[data-models-login-choice] button")]
    .find((button) => button.textContent?.includes("Radius account"))!
    .click();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["connect", "setup"] as const)(
  "Model Setup completes %s OAuth from a browser callback without manual submission",
  async (operation) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { context, client, request, runtimeConfig } = createContext();
    vi.spyOn(window, "open").mockReturnValue(null);
    const callback = createDeferred();
    const manual = new AbortController();
    let session: WizardSession | undefined;
    let verificationRuns = 0;
    configureRequests(request, {
      [signInMethod(operation)]: () => {
        session = new WizardSession(async (prompter, _signal, active) => {
          await prompter.note("Approve this account in your browser.", "Account access");
          await prompter.openUrl?.("https://example.invalid/authorize");
          void prompter
            .text({ message: "Paste the redirect URL", signal: manual.signal })
            .catch(() => {});
          await callback.promise;
          manual.abort();
          if (operation === "setup") {
            verificationRuns += 1;
            active.setModelActivation({ modelRef: "fixture/verified" });
          }
        });
        return { done: false, status: "running" };
      },
      "wizard.next": async (params) => {
        if (!session) {
          throw new Error("Expected registered wizard start");
        }
        const answer = (params as WizardNextParams).answer;
        if (answer) {
          expect(answer.value).toBeUndefined();
          await session.answer(answer.stepId, answer.value);
        }
        return session.next();
      },
      "wizard.cancel": () => {
        session?.cancel();
        return { status: "cancelled" };
      },
    });
    try {
      const { page } = await mountDetection(context, client, setup, false);
      const setupButton = authButton(page, "setup-only")!;
      await startSignIn(page, operation);
      await waitForFast(() => {
        const signIn = page.querySelector(".wizard-step__sign-in");
        expect(signIn).not.toBeNull();
        expect(signIn?.textContent).toContain("Waiting for approval in your browser…");
      });
      expect(page.querySelector(".model-setup-wizard h2")?.textContent?.trim()).toBe(
        labelFor(operation),
      );
      expect(verificationRuns).toBe(0);
      callback.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForFast(
        () =>
          expect(page.textContent).toContain(
            operation === "connect" ? "Provider credentials saved." : "Connection verified",
          ),
        { timeout: 3000 },
      );
      expect(verificationRuns).toBe(operation === "connect" ? 0 : 1);
      expect(page.textContent).not.toContain("Approve this account in your browser.");
      expect(page.textContent).not.toContain("https://example.invalid/authorize");
      expect(setupButton.textContent?.trim()).toBe("Set up & verify");
      expect(callsFor(request, "openclaw.setup.activate.start")).toHaveLength(0);
      if (operation === "connect") {
        expect(request).toHaveBeenCalledWith(
          "models.authLogin",
          expect.objectContaining({ authChoice: "radius/radius", agentId: "main" }),
          expect.anything(),
        );
        expect(callsFor(request, "openclaw.setup.auth.start")).toHaveLength(0);
      }
    } finally {
      callback.resolve();
      manual.abort();
      session?.cancel();
      await session?.whenSettled();
      runtimeConfig.dispose();
    }
  },
);

it.each(["agent", "connection", "cancel"] as const)(
  "Model Setup discards an account inventory after %s changes",
  async (change) => {
    const { context, client, request, runtimeConfig, snapshot } = createContext();
    const inventory = createDeferred<ModelAuthStatusResult>();
    configureRequests(request, { "models.authStatus": () => inventory.promise });
    try {
      const { page } = await mountDetection(context, client, setup, false);
      pageButton(page, "[data-models-connect]")!.click();
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "models.authStatus")).toBe(true),
      );
      if (change === "agent") {
        context.settingsAgentSelection.state.selectedId = "other";
      }
      if (change === "connection") {
        snapshot.hello = { ...snapshot.hello };
      }
      if (change === "cancel") {
        pageButton(page, "openclaw-modal-dialog button")!.click();
      } else {
        page.routeData = { firstRun: false };
      }
      await page.updateComplete;
      inventory.resolve(authStatus);
      await inventory.promise;
      await page.updateComplete;
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    } finally {
      inventory.resolve(authStatus);
      runtimeConfig.dispose();
    }
  },
);

it.each([
  ["connect", "terminal"],
  ["setup", "request"],
] as const)(
  "Model Setup shows %s recovery context directly after a %s failure",
  async (operation, failure) => {
    const { context, client, request, runtimeConfig } = createContext();
    vi.spyOn(window, "open").mockReturnValue(null);
    const finish = createDeferred();
    const diagnostic = "Token exchange returned no refresh token.";
    const guidance = "Check the client ID, client secret, and redirect URI.";
    const url = "https://example.invalid/authorize?code=synthetic";
    const authorization = `Open the authorization URL: ${url}`;
    let reads = 0;
    configureRequests(request, {
      [signInMethod(operation)]: () => ({ done: false, status: "running" }),
      "wizard.next": async () => {
        reads += 1;
        if (reads <= 2) {
          return runningStep({
            id: `note-${reads}`,
            type: "note",
            executor: "client",
            message: reads === 1 ? guidance : authorization,
          });
        }
        if (reads === 3) {
          return runningStep({
            id: "approval",
            type: "progress",
            executor: "gateway",
            message: "Waiting for approval",
            externalUrl: url,
          });
        }
        await finish.promise;
        if (failure === "request") {
          throw new Error(diagnostic);
        }
        return { done: true, status: "error", error: diagnostic };
      },
      "wizard.cancel": () => ({ status: "cancelled" }),
    });
    try {
      const { page } = await mountDetection(context, client, setup, false);
      await startSignIn(page, operation);
      await waitForFast(() =>
        expect(page.querySelector(".wizard-step__sign-in")?.textContent).toContain(
          "Waiting for approval in your browser…",
        ),
      );
      const modal = page.querySelector("openclaw-modal-dialog")!;
      const label = labelFor(operation);
      expect(modal.querySelector("h2")?.textContent?.trim()).toBe(label);
      expect(modal.textContent).not.toContain(guidance);
      expect(modal.textContent).not.toContain(url);
      finish.resolve();
      const expectedError = [diagnostic, guidance, authorization].join("\n\n");
      await waitForFast(() =>
        expect(modal.querySelector(".model-setup-wizard__error-text")?.textContent).toBe(
          expectedError,
        ),
      );
      expect(modal.querySelector("h2")?.textContent?.trim()).toBe(label);
      expect(modal.querySelector(".wizard-step__sign-in")).toBeNull();
      const alert = modal.querySelector("[role=alert]")!;
      expect(alert.textContent).toContain(guidance);
      expect(alert.textContent).toContain(url);
      expect(alert.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')).not.toBeNull();
      expect(modal.querySelector("details")).toBeNull();
      expect(reads).toBe(4);
      expect(callsFor(request, "openclaw.setup.activate.start")).toHaveLength(0);
    } finally {
      finish.resolve();
      runtimeConfig.dispose();
    }
  },
);
