/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { detection as emptyDetection } from "./model-setup-first-run.test-support.ts";
import { activationTargetId } from "./state.ts";
import {
  detected,
  mount,
  props,
  text,
  renderSetup,
  disposeViews,
  type ModelSetupViewProps,
} from "./test-helpers/view.test-support.tsx";

const find = <T extends Element = Element>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector);

function mountDetected(
  result: Partial<SystemAgentSetupDetectResult>,
  overrides: Partial<ModelSetupViewProps> = {},
) {
  return mount(
    props({ ...overrides, page: { phase: "ready", result: { ...detected, ...result } } }),
  );
}

function wizardProps(
  step: WizardStep,
  value: unknown = step.initialValue,
  validationError: string | null = null,
) {
  return props({
    wizard: { phase: "step", authChoice: "provider-auth", step, busy: false, validationError },
    wizardValue: value,
  });
}
const wizardStep = (step: WizardStep) => mount(wizardProps(step));

function mountManual(
  provider: SystemAgentSetupDetectResult["manualProviders"][number],
  overrides: Partial<ModelSetupViewProps>,
) {
  return mountDetected(
    { candidates: [], authOptions: [], recommendedInstalls: [], manualProviders: [provider] },
    { manualProviderId: provider.id, ...overrides },
  );
}

const ready: SystemAgentSetupDetectResult = {
  ...emptyDetection,
  configuredModel: "openai/gpt-5",
  setupComplete: true,
};

const firstRunProps = () =>
  props({
    page: { phase: "ready", result: ready },
    firstRun: true,
    manualProviderId: "",
    iconUrls: {},
  });

describe("renderModelSetup", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    disposeViews();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it("shows detected authentication without credential values", () => {
    const detail = "logged in · ChatGPT account · alex@example.com";
    const secret = "synthetic-private-token";
    const container = mountDetected({
      candidates: [{ ...detected.candidates[0]!, detail: `${detail} · token=${secret}` }],
    });
    const row = find(container, '[data-candidate-kind="codex-cli"]')!;

    expect(text(row)).toContain(detail);
    expect(text(row)).not.toContain(secret);
  });

  it("derives prepare rows from accepted choice ids and hides usable local candidates", () => {
    const onStartPrepare = vi.fn();
    const container = mount(props({ onStartPrepare }));

    const ollama = find<HTMLButtonElement>(container, '[data-prepare-choice="ollama"] button');
    const llamaCpp = find<HTMLButtonElement>(container, '[data-prepare-choice="llama-cpp"] button');
    expect(ollama?.textContent).toContain("Choose connection");
    expect(llamaCpp?.textContent).toContain("Set up model");
    expect(
      find<HTMLButtonElement>(container, '[data-prepare-choice="lmstudio"] button')?.textContent,
    ).toContain("Connect server");
    const llamaCppRow = find(container, '[data-prepare-choice="llama-cpp"]');
    expect(llamaCppRow?.querySelector('[data-provider-icon="llamacpp"]')).not.toBeNull();
    expect(text(llamaCppRow!)).toContain("llama.cpp");
    expect(text(llamaCppRow!)).not.toContain("Gemma");
    expect(llamaCppRow?.classList.contains("model-setup__prepare-row--featured")).toBe(false);
    ollama?.click();
    expect(onStartPrepare).toHaveBeenCalledWith(expect.objectContaining({ id: "ollama" }));

    const withUsableOllama = mountDetected({
      candidates: [
        ...detected.candidates,
        {
          kind: "provider-auto:ollama",
          label: "Ollama",
          detail: "available locally",
          modelRef: "ollama/qwen3:8b",
          recommended: false,
        },
      ],
    });
    expect(find(withUsableOllama, '[data-prepare-choice="ollama"]')).toBeNull();
  });

  it("renders recommended install cards only when candidates and sign-ins are empty", () => {
    const container = mountDetected({ candidates: [], authOptions: [] });

    expect(text(container)).toContain("Recommended installs");
    const card = find(container, '[data-recommended-install="ollama"]');
    expect(card?.querySelector("strong")?.textContent).toBe("Ollama");
    expect(card?.querySelector(".muted")?.textContent).toBe("Run open models locally");
    const icon = card?.querySelector<HTMLElement>('[data-provider-icon="ollama"]');
    const link = card?.querySelector<HTMLAnchorElement>("a");
    expect(icon).not.toBeNull();
    expect(card?.querySelector("img")).toBeNull();
    expect(link).toMatchObject({
      href: "https://ollama.com/download",
      target: "_blank",
      rel: "noopener",
    });

    const withSignIn = mountDetected({ candidates: [] });
    expect(find(withSignIn, ".model-setup__empty")).toBeNull();
  });

  it("uses explicit brand identity without guessing from labels or opaque ids", () => {
    const container = mountManual(
      {
        id: "custom-login",
        brandId: "claude",
        label: "Company account",
        icon: "https://cdn.example.com/custom.png",
      },
      { iconUrls: {} },
    );

    expect(find(container, '.model-setup__manual [data-provider-icon="claude"]')).not.toBeNull();
    expect(find<HTMLImageElement>(container, ".model-setup__manual img")).toBeNull();
  });

  it("uses proxied artwork for unknown providers and invalidates broken blobs", () => {
    const iconUrl = "https://cdn.example.com/acme.png";
    const onIconError = vi.fn();
    const container = mountManual(
      { id: "acme", label: "Acme", icon: iconUrl },
      { iconUrls: { [iconUrl]: "blob:acme" }, onIconError },
    );

    const image = find<HTMLImageElement>(container, ".model-setup__manual img");
    expect(image).toMatchObject({ src: "blob:acme", alt: "Acme" });
    image?.dispatchEvent(new Event("error"));
    expect(onIconError).toHaveBeenCalledWith(iconUrl);
    expect(container.innerHTML).not.toContain(iconUrl);
  });

  it("keeps saved replacement credentials selectable without repeating the current route", () => {
    const onActivateCandidate = vi.fn();
    const savedCandidate: SystemAgentSetupDetectResult["candidates"][number] = {
      kind: "saved-auth:openai:replacement",
      brandId: "openai",
      label: "Saved OpenAI credentials",
      detail: "Saved for retry after a failed setup test",
      modelRef: "openai/gpt-5",
      recommended: false,
      credentials: true,
    };
    const container = mountDetected(
      {
        configuredModel: savedCandidate.modelRef,
        setupComplete: true,
        candidates: [
          {
            ...savedCandidate,
            kind: "existing-model",
            label: "Current model",
            detail: "openai/gpt-5 — already configured",
          },
          { ...savedCandidate, kind: "provider-auto:openai", label: "OpenAI" },
          savedCandidate,
          {
            ...savedCandidate,
            kind: "claude-cli",
            brandId: "claude",
            label: "Claude Code",
            detail: "logged in",
            modelRef: "claude-cli/claude-opus-5",
          },
        ],
      },
      { onActivateCandidate },
    );

    expect(find(container, '[data-candidate-kind="existing-model"]')).toBeNull();
    expect(find(container, '[data-candidate-kind="provider-auto:openai"]')).toBeNull();
    expect(find(container, '[data-candidate-kind="claude-cli"]')).not.toBeNull();
    const current = find(container, ".model-setup__current")!;
    expect(find(current, "h2")?.textContent).toBe("Selected model");
    expect(find(current, "strong")?.textContent).toBe("OpenAI");
    expect(find(current, ".model-setup__current-copy .muted")?.textContent).toContain("gpt-5");
    const retry = find<HTMLButtonElement>(
      container,
      '[data-candidate-kind="saved-auth:openai:replacement"] button',
    );
    expect(retry).not.toBeNull();
    expect(retry!.disabled).toBe(false);
    retry!.click();
    expect(onActivateCandidate).toHaveBeenCalledExactlyOnceWith(savedCandidate);
  });

  it("renders connection verification progress", () => {
    const container = mountDetected(
      { configuredModel: "openai/gpt-5" },
      { verify: { phase: "checking" }, actionsDisabled: true },
    );
    expect(text(container)).toContain("Checking — asking openai/gpt-5 for a quick reply…");
    expect(find<HTMLButtonElement>(container, ".model-setup__current button")?.disabled).toBe(true);
  });

  it("renders successful connection verification with the answering model", () => {
    const container = mountDetected(
      { configuredModel: "openai/gpt-5" },
      { verify: { phase: "ok", modelRef: "anthropic/claude-opus-4-8", latencyMs: 1234 } },
    );
    expect(text(container)).toContain("Ready · 1234 ms");
    const current = find(container, ".model-setup__current");
    expect(current?.textContent).toContain("Anthropic");
    expect(current?.textContent).toContain("claude-opus-4-8");
    expect(current?.textContent).not.toContain("openai/gpt-5");
    expect(current?.querySelector('[data-provider-icon="claude"]')).not.toBeNull();
  });

  it("shows the current model without verification controls for non-admin and unsupported gateways", () => {
    const result = { ...detected, configuredModel: "openai/gpt-5" };
    const nonAdmin = mount(
      props({ page: { phase: "ready", result }, canAdmin: false, canVerify: false }),
    );
    const unsupportedGateway = mount(props({ page: { phase: "ready", result }, canVerify: false }));
    for (const page of [nonAdmin, unsupportedGateway]) {
      const current = find(page, ".model-setup__current")!;
      expect(find(current, "h2")?.textContent).toBe("Selected model");
      expect(find(current, "strong")?.textContent).toBe("OpenAI");
      expect(find(current, ".model-setup__current-copy .muted")?.textContent).toContain("gpt-5");
      expect(find(current, "button")).toBeNull();
    }
  });

  it.each([true, false])("reports device-code fallback success: %s", async (copied) => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    vi.stubGlobal("navigator", copied ? {} : { clipboard: { writeText } });
    const execCommand = vi.fn().mockImplementation(() => {
      expect(find<HTMLTextAreaElement>(document, "textarea")?.value).toBe("ABCD-EFGH");
      return copied;
    });
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
    const container = wizardStep({
      id: "device",
      type: "note",
      ...(copied
        ? {
            title: "Authorize device",
            message: "Use this code",
            externalUrl: "https://example.com/device",
          }
        : {}),
      deviceCode: { code: "ABCD-EFGH", ...(copied ? { expiresInMinutes: 10 } : {}) },
    });

    if (copied) {
      const link = find<HTMLAnchorElement>(container, 'a[href="https://example.com/device"]');
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noreferrer");
      expect(text(container)).toContain("ABCD-EFGH");
      expect(text(container)).toContain("Expires in 10 minutes");
    }
    const copy = find<HTMLButtonElement>(container, ".wizard-step__sign-in button");
    copy?.click();

    const feedback = copied ? "Copied!" : "Copy failed";
    await vi.waitFor(() => expect(copy?.textContent?.trim()).toBe(feedback));
    expect(copy?.getAttribute("aria-label")).toBeNull();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).toHaveBeenCalledTimes(copied ? 0 : 1);
    expect(find<HTMLTextAreaElement>(document, "textarea")).toBeNull();
  });

  it.each([
    { sensitive: false, expectedType: "text" },
    { sensitive: true, expectedType: "password" },
  ])(
    "labels a $expectedType input and associates validation errors until recovery",
    ({ sensitive, expectedType }) => {
      const container = document.body.appendChild(document.createElement("div"));
      const renderStep = (validationError: string | null) =>
        renderSetup(
          wizardProps(
            {
              id: "access-value",
              type: "text",
              message: "Provider access value",
              sensitive,
              placeholder: "Enter value",
            },
            "initial value",
            validationError,
          ),
          container,
        );
      renderStep(null);
      const input = find<HTMLInputElement>(container, "#model-setup-wizard-text-input");
      const label = find<HTMLLabelElement>(container, 'label[for="model-setup-wizard-text-input"]');
      expect(label?.textContent).toBe("Provider access value");
      expect(input?.type).toBe(expectedType);
      expect(input?.labels).toContain(label);
      renderStep("That access value is not valid.");
      const errorId = input?.getAttribute("aria-describedby");
      expect(input?.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(errorId ?? "")?.textContent).toContain(
        "That access value is not valid.",
      );
      renderStep(null);
      expect(input?.hasAttribute("aria-invalid")).toBe(false);
      expect(input?.hasAttribute("aria-describedby")).toBe(false);
    },
  );

  it.each([{ canAdmin: false }, { gatewayTooOld: true }])(
    "keeps activation feedback behind setup access: %j",
    (access) => {
      const container = mount(
        props({
          ...access,
          activation: {
            phase: "failure",
            targetId: "manual:openai",
            status: "auth",
            error: "Credential rejected",
          },
        }),
      );
      expect(find(container, ".settings-section")).toBeNull();
      expect(find(container, '[role="alert"]')).toBeNull();
      expect(text(container)).not.toContain("Credential rejected");
    },
  );

  it.each([
    { entry: "discovered", targetId: activationTargetId("codex-cli", "openai/gpt-5") },
    { entry: "manual", targetId: "manual:openai" },
  ])(
    "keeps one activation status and failure visible for $entry targets",
    ({ entry, targetId }) => {
      const viewProps = props({
        activation: { phase: "testing", targetId },
        actionsDisabled: true,
        manualApiKey: "test-only-secret",
      });
      const container = mount(viewProps);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(text(find(container, '[role="status"]')!)).toContain("Testing");
      expect(text(container)).not.toContain("test-only-secret");
      const button = find<HTMLButtonElement>(
        container,
        entry === "discovered"
          ? '[data-candidate-kind="codex-cli"] button'
          : ".model-setup__manual .btn.primary",
      )!;
      expect(button.disabled).toBe(true);
      expect(text(button)).toBe("Testing…");

      viewProps.activation = {
        phase: "failure",
        targetId,
        status: "timeout",
        error: "No reply received",
      };
      viewProps.actionsDisabled = false;
      renderSetup(viewProps, container);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(text(find(container, '[role="alert"]')!)).toContain("No reply received");
      expect(text(find(container, '[role="alert"]')!)).toContain(
        "Warm it or choose a faster model, then retry.",
      );
      expect(button.disabled).toBe(false);
      if (entry === "discovered") {
        expect(text(button)).toBe("Retry test");
        button.click();
        expect(viewProps.onActivateCandidate).toHaveBeenCalledWith(detected.candidates[0]);
      } else {
        expect(text(button)).toBe("Connect & verify");
        button.click();
        expect(viewProps.onManualConnect).toHaveBeenCalledOnce();
      }

      viewProps.page = { phase: "ready", result: { ...detected, candidates: [] } };
      viewProps.manualProviderId = "gemini-api-key";
      renderSetup(viewProps, container);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(text(find(container, '[role="alert"]')!)).toContain("No reply received");
      viewProps.page = { phase: "loading" };
      renderSetup(viewProps, container);
      expect(text(find(container, '[role="alert"]')!)).toContain("No reply received");
      viewProps.page = { phase: "ready", result: { ...detected, candidates: [] } };
      viewProps.activation = { phase: "testing", targetId };
      renderSetup(viewProps, container);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "filters credential choices while retaining setup-only methods: %s",
    (setupOnly) => {
      const onStartAuth = vi.fn();
      const onManualConnect = vi.fn();
      const install = {
        id: "install-provider",
        label: "Installable provider",
        kind: "install" as const,
        featured: false,
      };
      const custom = {
        id: "custom-endpoint",
        label: "Compatible endpoint",
        kind: "custom" as const,
        featured: false,
      };
      const container = mountDetected(
        {
          configuredModel: "openai/gpt-5.6-luna",
          authOptions: [...(detected.authOptions ?? []), install, custom],
          manualProviders: setupOnly
            ? [{ id: "special-token", brandId: "openai", label: "Special account token" }]
            : detected.manualProviders,
        },
        {
          embedded: true,
          agentLabel: "Writer",
          credentialChoices: ["openai-oauth", "other-device", "openai", "gemini-api-key"],
          manualProviderId: "special-token",
          manualApiKey: "synthetic-token",
          onStartAuth,
          onManualConnect,
        },
      );
      expect(find(container, ".content-header")).toBeNull();
      expect(find(container, ".model-setup__current")).toBeNull();
      expect(text(container)).toContain("for Writer");
      expect(text(container)).toContain("not the global defaults");
      expect(find(container, '[data-auth-choice="openai-oauth"]')).toBeNull();
      expect(find(container, '[data-prepare-choice="ollama"]')).not.toBeNull();
      for (const option of [install, custom]) {
        find<HTMLButtonElement>(container, `[data-auth-choice="${option.id}"] button`)!.click();
        expect(onStartAuth).toHaveBeenLastCalledWith(option);
      }
      if (setupOnly) {
        expect(find(container, '[data-manual-provider="special-token"]')).not.toBeNull();
        find<HTMLButtonElement>(container, ".model-setup__manual button.primary")!.click();
        expect(onManualConnect).toHaveBeenCalledOnce();
      } else {
        expect(find(container, ".model-setup__manual")).toBeNull();
      }
    },
  );

  it("notifies the discovery owner only when its own modal is shown", () => {
    const onDiscoveryShown = vi.fn();
    const container = mount(props({ embedded: true, onDiscoveryShown }));
    const modal = find(container, "openclaw-modal-dialog")!;
    const content = find(modal, ".model-setup-discovery")!;

    content.dispatchEvent(new CustomEvent("overlay-after-show", { bubbles: true }));
    expect(onDiscoveryShown).not.toHaveBeenCalled();
    modal.dispatchEvent(new CustomEvent("overlay-after-show", { bubbles: true }));
    expect(onDiscoveryShown).toHaveBeenCalledOnce();
  });

  it.each(["wizard", "primary", "utility"] as const)(
    "leaves the %s dialog in control of its action",
    (mode) => {
      const onWizardCancel = vi.fn();
      const onClose = vi.fn();
      const onOpenChat = vi.fn();
      const onOpenSetupAssistant = vi.fn();
      const container = mount(
        props({
          embedded: true,
          onClose,
          onWizardCancel,
          onOpenChat,
          onOpenSetupAssistant,
          ...(mode === "wizard"
            ? {
                wizard: {
                  phase: "step",
                  authChoice: "local",
                  busy: false,
                  validationError: null,
                  step: { id: "choice", type: "confirm", message: "Prepare local model?" },
                },
              }
            : {
                activation: {
                  phase: "success",
                  modelRef: mode === "utility" ? "local/setup" : "openai/gpt-5.6-luna",
                  ...(mode === "utility" ? { modelTarget: "utility" } : {}),
                },
              }),
        }),
      );
      const dialogs = container.querySelectorAll("openclaw-modal-dialog");
      expect(dialogs).toHaveLength(1);
      if (mode === "wizard") {
        expect(find(container, ".model-setup__intro")).toBeNull();
        dialogs[0]!.dispatchEvent(
          new CustomEvent("modal-cancel", { bubbles: true, cancelable: true }),
        );
        expect(onWizardCancel).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
      } else {
        const success = find(container, ".model-setup-success")!;
        const done = find<HTMLButtonElement>(success, "button.primary")!;
        if (mode === "utility") {
          expect(text(success)).toContain("Setup & utility model ready");
          expect(text(success)).not.toContain("Active model");
          expect(text(success)).not.toContain("Return to Models");
          done.click();
          expect(onOpenSetupAssistant).toHaveBeenCalledOnce();
          expect(onOpenChat).not.toHaveBeenCalled();
        } else {
          expect(done.textContent).toContain("Return to Models");
          done.click();
          expect(onOpenChat).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("keeps utility actions distinct from agent primary selection during rescans", () => {
    const utility = {
      kind: "provider-auto:local" as const,
      label: "Local utility",
      detail: "Available on this Gateway",
      modelRef: "local/setup",
      recommended: false,
      modelTarget: "utility" as const,
    };
    const onActivateCandidate = vi.fn();
    const page = {
      phase: "ready" as const,
      result: {
        ...detected,
        configuredModel: "cloud/primary",
        candidates: [...detected.candidates, utility],
      },
    };
    const container = mount(props({ embedded: true, page, onActivateCandidate }));
    const utilityButton = find<HTMLButtonElement>(
      container,
      '[data-candidate-kind="provider-auto:local"] button',
    )!;
    expect(utilityButton.textContent).toContain("Use as utility");
    expect(find(container, '[data-candidate-kind="codex-cli"] button')?.textContent).toContain(
      "Test & use for this agent",
    );
    utilityButton.click();
    expect(onActivateCandidate).toHaveBeenCalledExactlyOnceWith(utility);
    const scanning = mount(props({ embedded: true, detecting: true, page }));
    const buttons = scanning.querySelectorAll<HTMLButtonElement>("[data-candidate-kind] button");
    expect(buttons).toHaveLength(2);
    expect([...buttons].every((button) => button.disabled)).toBe(true);
  });

  it("keeps durable continuation without duplicating a fresh success action", () => {
    const onOpenChat = vi.fn();
    const container = mount({ ...firstRunProps(), onOpenChat });

    const continueButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue setup",
    );
    expect(continueButton).toBeDefined();
    continueButton?.click();
    expect(onOpenChat).toHaveBeenCalledOnce();

    const freshSuccess = mount({
      ...firstRunProps(),
      activation: { phase: "success", modelRef: "openai/gpt-5" },
    });
    expect(
      [...freshSuccess.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Continue setup",
      ),
    ).toHaveLength(1);
    expect(freshSuccess.textContent).not.toContain("Open Chat");
  });
});
