/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountDetection,
  useFirstRunFixtures,
  selectManualProvider,
  setInput,
  authButton,
  waitForText,
  pageButton,
  authOption,
} from "./model-setup-first-run.test-support.ts";

const utility = {
  ...candidate("provider-auto:local", "local/setup", true),
  modelTarget: "utility" as const,
};
const activatedUtility = {
  done: true,
  status: "done",
  modelActivation: { modelRef: utility.modelRef, modelTarget: utility.modelTarget },
};
const utilitySelection = {
  kind: utility.kind,
  modelRef: utility.modelRef,
  modelTarget: "utility",
};
const onboarding = { search: "?onboarding=1" };

function expectRequest(
  request: ReturnType<typeof createFirstRunContext>["request"],
  method: string,
  params: object,
) {
  expect(request).toHaveBeenCalledWith(method, expect.objectContaining(params), expect.anything());
}
const expectAssistant = (context: ReturnType<typeof createFirstRunContext>["context"]) =>
  waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("custodian", onboarding));

function createUtilityContext() {
  const fixture = createFirstRunContext();
  return {
    ...fixture,
    mount: (result: Partial<SystemAgentSetupDetectResult>, firstRun = true) =>
      mountDetection(fixture.context, fixture.client, result, firstRun),
  };
}

describe("ModelSetupPage utility roles", () => {
  useFirstRunFixtures("synthetic-utility-device-key");

  it("opens the setup assistant after explicit utility activation outside first run", async () => {
    const { context, request, mount } = createUtilityContext();
    request.mockResolvedValue(activatedUtility);
    const { page } = await mount({ candidates: [utility] }, false);
    expect(page.textContent).toContain("Setup & utility");
    expect(page.textContent).toContain("Use for setup");
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, utility.kind);
    await waitForText(page, "Setup & utility model ready");
    const success = page.querySelector(".model-setup-success")!;
    expect(success.textContent).not.toContain("start chatting");
    expect(success.textContent).not.toContain("Active model");
    [...success.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Open setup assistant"))!
      .click();
    await expectAssistant(context);
    expect(request.mock.calls[0]?.[1]).toMatchObject(utilitySelection);
    expect(context.navigate).not.toHaveBeenCalledWith("chat");
  });

  it.each([false, true])(
    "keeps the configured utility available for reopening and repair (primary: %s)",
    async (primary) => {
      const { context, request, mount } = createUtilityContext();
      request.mockResolvedValue(activatedUtility);
      const { page } = await mount({
        candidates: [utility],
        utilityModel: utility.modelRef,
        ...(primary
          ? { configuredModel: "cloud/primary", setupComplete: true }
          : { setupModel: utility.modelRef }),
      });

      expect(page.querySelector(".model-setup__current") !== null).toBe(primary);
      expect(page.querySelector(`[data-candidate-kind="${utility.kind}"]`)).toBeNull();
      expect(page.textContent).toContain(
        primary
          ? "Regular chats use your primary model"
          : "Choose a primary model below for regular chats",
      );
      const buttons = [...page.querySelectorAll<HTMLButtonElement>(".model-setup__utility button")];
      buttons.find((button) => button.textContent?.includes("Open setup assistant"))!.click();
      expect(context.navigate).toHaveBeenCalledWith("custodian", primary ? {} : onboarding);
      expect(request).not.toHaveBeenCalled();
      buttons.find((button) => button.textContent?.includes("Recheck & repair"))!.click();
      await waitForFast(() =>
        expectRequest(request, "openclaw.setup.activate.start", utilitySelection),
      );
    },
  );

  it.each(["api-key", "oauth"] as const)(
    "preserves utility acknowledgement through %s setup",
    async (kind) => {
      const { context, request, mount } = createUtilityContext();
      const oauth = kind === "oauth";
      const method = oauth ? "openclaw.setup.auth.start" : "openclaw.setup.activate.start";
      const params = oauth
        ? { authChoice: "utility-login", modelTarget: "utility" }
        : {
            kind,
            authChoice: "manual-utility",
            apiKey: "synthetic-utility-key",
            modelTarget: "utility",
          };
      if (oauth) {
        vi.spyOn(window, "open").mockReturnValue(null);
      }
      request.mockImplementation(async (called, actual) => {
        if (called === method) {
          expect(actual).toMatchObject(params);
          return oauth ? { done: false, status: "running" } : activatedUtility;
        }
        if (oauth && called === "wizard.next") {
          expect(readFirstRunActivationReceipt(context)).toMatchObject({
            kind: "provider-auth",
            modelTarget: "utility",
            modelRef: null,
          });
          return activatedUtility;
        }
        throw new Error(`Unexpected method ${called}`);
      });
      const { page } = await mount(
        oauth
          ? {
              authOptions: [
                {
                  ...authOption("utility-login", "Utility account"),
                  modelTarget: "utility",
                },
              ],
            }
          : {
              manualProviders: [
                { id: "manual-utility", label: "Utility API key", modelTarget: "utility" },
              ],
            },
      );
      if (oauth) {
        authButton(page, "utility-login")!.click();
      } else {
        await selectManualProvider(page, "manual-utility");
        setInput(page, 'input[type="password"]', "synthetic-utility-key");
        await page.updateComplete;
        pageButton(page, ".model-setup__manual .btn.primary")!.click();
      }
      await expectAssistant(context);
      expectRequest(request, method, params);
      expect(request.mock.calls.map(([called]) => called)).toEqual([
        method,
        ...(oauth ? ["wizard.next"] : []),
      ]);
    },
  );

  it.each(["direct", "detected", "missing"] as const)(
    "retains the utility role when preparation returns a %s model",
    async (outcome) => {
      const { context, request, mount } = createUtilityContext();
      const direct = outcome === "direct";
      const usable = outcome !== "missing";
      const prepared = {
        ...detection,
        ...(direct ? {} : { configuredModel: "cloud/primary", setupComplete: true }),
        prepareOptions: [{ id: "local", label: "Local utility", modelTarget: "utility" as const }],
      };
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.prepare.start") {
          return {
            done: true,
            status: "done",
            ...(direct ? { preparedModelRef: utility.modelRef } : {}),
          };
        }
        if (!direct && method === "openclaw.setup.detect") {
          return {
            ...prepared,
            utilityModel: utility.modelRef,
            candidates: usable ? [utility] : [],
          };
        }
        if (method === "openclaw.setup.activate.start") {
          return activatedUtility;
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mount(prepared, direct);
      pageButton(page, '[data-prepare-choice="local"] button')!.click();
      if (direct) {
        await expectAssistant(context);
      } else {
        await waitForText(
          page,
          usable
            ? "Setup & utility model ready"
            : "Local utility did not expose a usable local model",
        );
        expect(page.querySelector(".model-setup__current")?.textContent).toContain("primary");
        expect(page.querySelector(".model-setup__utility")).toBeNull();
      }
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.prepare.start",
        ...(direct ? [] : ["openclaw.setup.detect"]),
        ...(usable ? ["openclaw.setup.activate.start"] : []),
      ]);
      if (usable) {
        expectRequest(request, "openclaw.setup.activate.start", {
          agentId: "main",
          ...utilitySelection,
        });
      }
    },
  );

  it.each([
    { replyTarget: "utility" as const, expected: true },
    { replyTarget: undefined, expected: false },
  ])(
    "recovers only the owned utility verification alongside a primary with reply=$replyTarget",
    async ({ replyTarget, expected }) => {
      const { context, request, mount } = createUtilityContext();
      persistFirstRunActivationReceipt(context, utility);
      request.mockResolvedValue({
        ok: true,
        modelRef: utility.modelRef,
        ...(replyTarget ? { modelTarget: replyTarget } : {}),
      });
      const { page } = await mount({
        candidates: [utility],
        utilityModel: utility.modelRef,
        configuredModel: "cloud/primary",
        setupComplete: true,
      });
      await waitForFast(() => expect(request).toHaveResolved());
      await page.updateComplete;

      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.verify",
        { agentId: "main", modelTarget: "utility" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      if (expected) {
        expect(context.navigate).toHaveBeenCalledWith("custodian", onboarding);
      } else {
        expect(context.navigate).not.toHaveBeenCalled();
        expect(page.querySelector(".model-setup__verified")).toBeNull();
      }
    },
  );
});
