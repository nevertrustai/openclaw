import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HealthCheck, HealthRepairContext } from "openclaw/plugin-sdk/health";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as managedBinary from "./crabbox-managed-binary.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import {
  warmImage,
  warmRecord,
  warmStore,
  captureOperation,
  expectText,
} from "./crabbox-warm-scenarios.test-support.js";
import {
  CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  registerCrabboxWorkerProviderDoctorChecks,
  type CrabboxDoctorRegistrationHost,
} from "./doctor.js";

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const CRABBOX_SETUP_SECRETS_CHECK_ID = "crabbox/setup-secrets";
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";
const runtime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });
const protectedSecret = (id: string, provider = "default") => ({ source: "store", provider, id });
const listPluginStateEntries: CrabboxDoctorRegistrationHost["listPluginStateEntries"] = <T>(
  options: OpenKeyedStoreOptions,
) => crabboxState.openKeyedStoreV2<T>(options).entries();

function captureCrabboxDoctorCheck(
  id = CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  inspectSetupSecrets: CrabboxDoctorRegistrationHost["inspectSetupSecrets"] = async (names) =>
    names.map((name) => ({ name, status: "missing" })),
): HealthCheck {
  const checks = new Map<string, HealthCheck>();
  registerCrabboxWorkerProviderDoctorChecks({
    openclawRoot: OPENCLAW_ROOT,
    inspectSetupSecrets,
    listPluginStateEntries,
    getHealthCheck: (key) => checks.get(key),
    registerHealthCheck(value) {
      checks.set(value.id, value);
    },
  });
  const check = checks.get(id);
  if (!check) {
    throw new Error("Crabbox doctor check was not registered");
  }
  return check;
}

describe("Crabbox worker doctor", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());
  const context = (target = "linux"): HealthRepairContext => ({
    mode: "fix",
    runtime: runtime(),
    cfg: {
      cloudWorkers: {
        profiles: {
          worker: { provider: "crabbox", settings: { binary: process.execPath, target } },
        },
      },
    },
  });

  it.each(["unconfigured", "supported", "sandbox", "wsl2", "indeterminate"] as const)(
    "detects %s without installing or mutating config",
    async (kind) => {
      const probe = vi.spyOn(managedBinary, "probeCrabboxVersion");
      const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
      if (kind !== "unconfigured") {
        probe.mockResolvedValue(
          kind === "supported"
            ? { status: "supported", version: managedBinary.CRABBOX_MIN_VERSION }
            : kind === "indeterminate"
              ? { status: "indeterminate", reason: "version command could not start" }
              : { status: "outdated", version: kind === "sandbox" ? "0.76.0" : "0.51.0" },
        );
      }
      const ctx = context(kind === "wsl2" ? "windows/wsl2" : "linux");
      if (kind === "unconfigured") {
        ctx.cfg = {};
      }
      if (kind === "sandbox") {
        ctx.cfg = {
          plugins: {
            entries: {
              crabbox: {
                config: {
                  sandbox: { binary: process.execPath },
                },
              },
            },
          },
        };
        ctx.env = { OPENCLAW_STATE_DIR: tempDirs.make("crabbox-doctor-sandbox-"), PATH: "" };
      }
      const before = structuredClone(ctx.cfg);
      const expected =
        kind === "sandbox"
          ? {
              target: "sandbox",
              ocPath: "plugins.entries.crabbox.config.sandbox.binary",
              message: expect.stringContaining("Crabbox sandbox uses outdated Crabbox 0.76.0"),
              requirement: "Crabbox 0.77.0 or newer",
            }
          : kind === "wsl2"
            ? {
                severity: "warning",
                target: "worker",
                requirement: `Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer`,
                fixHint: expect.stringContaining("openclaw doctor --fix"),
              }
            : {
                severity: "warning",
                message: expect.stringContaining("could not determine its Crabbox version"),
              };
      await expect(captureCrabboxDoctorCheck().detect(ctx)).resolves.toEqual(
        kind === "unconfigured" || kind === "supported" ? [] : [expect.objectContaining(expected)],
      );
      expect(ctx.cfg).toEqual(before);
      expect(probe).toHaveBeenCalledTimes(kind === "unconfigured" ? 0 : 1);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it.each(["0.56.0", managedBinary.CRABBOX_MIN_VERSION])(
    "detects managed-only %s without downloading",
    async (version) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("crabbox-doctor-managed-"), PATH: "" };
      const target = path.basename(
        path.dirname(managedBinary.resolveManagedCrabboxBinaryPath(env)),
      );
      const binary = path.join(
        env.OPENCLAW_STATE_DIR,
        "tools",
        "crabbox",
        version,
        target,
        process.platform === "win32" ? "crabbox.exe" : "crabbox",
      );
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, version);
      const command = vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
        stdout: version,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
      const install = vi.spyOn(managedBinary, "ensureManagedCrabboxBinary");
      const ctx: HealthRepairContext = { ...context(), env };
      ctx.cfg.cloudWorkers!.profiles!.worker!.settings = { binary: "/nonexistent/crabbox" };
      const check = captureCrabboxDoctorCheck();
      const findings = await check.detect(ctx);
      if (version === managedBinary.CRABBOX_MIN_VERSION) {
        expect(findings).toEqual([]);
        await expect(check.repair!(ctx, findings)).resolves.toMatchObject({ status: "skipped" });
        await expect(check.detect(ctx)).resolves.toEqual([]);
        expect(command).toHaveBeenCalledWith([binary, "--version"], expect.anything());
      } else {
        expect(findings).toEqual([
          expect.objectContaining({
            severity: "warning",
            requirement: `Crabbox ${managedBinary.CRABBOX_MIN_VERSION} or newer`,
            fixHint: expect.stringContaining("openclaw doctor --fix"),
          }),
        ]);
        expect(command).not.toHaveBeenCalled();
      }
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("repairs through the managed owner, preserving config", async () => {
    vi.spyOn(managedBinary, "resolveManagedCrabboxBinaryPath").mockReturnValue("/managed/crabbox");
    const install = vi
      .spyOn(managedBinary, "ensureManagedCrabboxBinary")
      .mockImplementation(async (options = {}) => {
        const { binary } = options;
        return { binary: binary ?? "crabbox", version: managedBinary.CRABBOX_MIN_VERSION };
      });
    const check = captureCrabboxDoctorCheck();
    const findings = [{ checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID }] as never;
    const ctx = context();
    await expect(check.repair!({ ...ctx, dryRun: true }, findings)).resolves.toMatchObject({
      status: "skipped",
    });
    expect(install).not.toHaveBeenCalled();
    const before = structuredClone(ctx.cfg);
    await expect(check.repair!(ctx, findings)).resolves.toMatchObject({
      status: "repaired",
      changes: ["Installed managed Crabbox at /managed/crabbox"],
    });
    expect(ctx.cfg).toEqual(before);
    install.mockRejectedValueOnce(new Error("checksum mismatch"));
    await expect(check.repair!(ctx, findings)).resolves.toMatchObject({
      status: "failed",
      warnings: ["checksum mismatch"],
    });
  });
});

describe("Crabbox warm-image doctor", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "fresh capture", operation: "capture", severity: "info" },
    { name: "long-running scrub", operation: "stale-scrub", severity: "warning" },
    { name: "failed capture", operation: "uncertain", severity: "warning" },
    { name: "pending retirement", operation: "retire", severity: "warning" },
    { name: "unsupported native capture", operation: "unsupported", severity: "info" },
  ] as const)(
    "reports $name without mutation or provider probes",
    async ({ operation, severity }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-crabbox-warm-doctor-") };
      const store = warmStore(env);
      const now = Date.now();
      const record = warmRecord({
        profileId: "linux-development",
        backend: "aws",
        machineClass: "standard",
        os: "linux",
        projectLabel: "github.com/example/project",
        image: warmImage("chk_last_good", { createdAtMs: now, lastDemandAtMs: now }),
      });
      if (operation === "unsupported") {
        record.captureUnsupported = {
          atMs: now,
          provider: "aws",
          message: "Native capture is unsupported by this coordinator.",
        };
      } else {
        record.operation =
          operation === "retire"
            ? { type: "retire", checkpointId: "chk_predecessor" }
            : captureOperation("capture-selector", {
                leaseId: "cbx_capture",
                provider: "aws",
                startedAtMs: now - (operation === "stale-scrub" ? 1_200_000 : 0),
                phase:
                  operation === "uncertain"
                    ? "uncertain"
                    : operation === "stale-scrub"
                      ? "scrubbing"
                      : "creating",
              });
      }
      store.register("profile", record);
      const probe = vi.spyOn(managedBinary, "probeCrabboxVersion");
      const command = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockRejectedValue(new Error("Provider commands are forbidden in this Doctor proof"));
      const check = captureCrabboxDoctorCheck(CRABBOX_WARM_IMAGES_CHECK_ID);
      const context: HealthRepairContext = {
        cfg: {},
        env,
        mode: "fix",
        runtime: runtime(),
      };

      const findings = await check.detect(context);

      expect(findings).toEqual([
        expect.objectContaining({
          checkId: CRABBOX_WARM_IMAGES_CHECK_ID,
          target: "profile",
          severity,
          message: expect.stringContaining(
            "linux-development · aws · standard · linux · github.com/example/project",
          ),
          fixHint: expect.stringContaining(
            operation === "unsupported"
              ? "settings.warmImage: false"
              : "openclaw crabbox warm-images",
          ),
        }),
      ]);
      if (operation === "unsupported") {
        expect(findings[0]?.message).toContain(record.captureUnsupported!.message);
        expectText(findings[0]?.fixHint, [
          "otherwise provision cold",
          "capture attempts are skipped until `warmImages.refreshAfter`",
          "supports native checkpoints",
        ]);
      } else if (operation === "uncertain") {
        expect(findings[0]?.fixHint).toContain(
          "--recover capture-selector --acknowledge-provider-cleanup",
        );
      } else if (operation === "stale-scrub") {
        expectText(
          findings[0]?.fixHint,
          ["may still be"],
          ["--recover", "Stop the owning Gateway"],
        );
        expect(findings[0]?.message).not.toContain("paused");
      }
      await check.repair?.(context, findings);
      expect(store.lookup("profile")).toEqual(record);
      expect(command).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    },
  );
});

describe("Crabbox setup secret migration", () => {
  const context = (settings: Record<string, unknown>): HealthRepairContext => ({
    cfg: { cloudWorkers: { profiles: { worker: { provider: "crabbox", settings } } } },
    mode: "fix",
    runtime: runtime(),
  });
  const ready: CrabboxDoctorRegistrationHost["inspectSetupSecrets"] = async (names) =>
    names.map((name) => ({ name, status: "ready" }));

  it("skips inspection and commands without legacy names", async () => {
    const inspect = vi.fn(ready);
    const spawn = vi.spyOn(processRuntime, "runCommandWithTimeout");
    try {
      const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, inspect);
      const base = context({});
      for (const cfg of [
        {},
        base.cfg,
        context({
          setupSecrets: { TOKEN: protectedSecret("TOKEN") },
        }).cfg,
        context({ setupEnv: [] }).cfg,
      ]) {
        const ctx = { ...base, cfg };
        await check.detect(ctx);
        await check.repair!(ctx, []);
      }
      expect(inspect).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  it("migrates idempotently without mutating audit input", async () => {
    const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, ready);
    const ctx = context({ setup: "install", setupEnv: ["TOKEN", "PASSWORD"], class: "standard" });
    const before = structuredClone(ctx.cfg);
    expect(await check.detect(ctx)).toHaveLength(1);
    expect(ctx.cfg).toEqual(before);
    expect(await check.repair!({ ...ctx, dryRun: true }, [])).toMatchObject({
      status: "skipped",
      changes: [],
    });
    expect(ctx.cfg).toEqual(before);
    const result = await check.repair!(ctx, []);
    expect(result).toMatchObject({ status: "repaired", warnings: [] });
    expect(result.config?.cloudWorkers?.profiles?.worker?.settings).toEqual({
      setup: "install",
      class: "standard",
      setupSecrets: {
        TOKEN: protectedSecret("TOKEN"),
        PASSWORD: protectedSecret("PASSWORD"),
      },
    });
    expect(ctx.cfg).toEqual(before);
    const repeated = { ...ctx, cfg: result.config! };
    expect(await check.detect(repeated)).toEqual([]);
    expect(await check.repair!(repeated, [])).toMatchObject({ status: "skipped", changes: [] });
  });

  it.each(["missing", "missing-bindings", "conflicting-value", "unavailable"] as const)(
    "preserves profiles with a %s secret",
    async (problem) => {
      const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, async (names) =>
        names.map((name) => ({ name, status: name === "TOKEN" ? problem : "ready" })),
      );
      const ctx = context({ setupEnv: ["TOKEN", "PASSWORD"] });
      const result = await check.repair!(ctx, []);
      expect(result).toMatchObject({ status: "skipped", config: ctx.cfg, changes: [] });
      expect(result.warnings?.join(" ")).toContain(problem);
      expect(result.warnings?.join(" ")).toContain("allowed hosts");
    },
  );

  it("preserves conflicts while migrating other profiles", async () => {
    const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, ready);
    const ctx = context({
      setupEnv: ["TOKEN"],
      setupSecrets: { TOKEN: protectedSecret("OTHER") },
    });
    ctx.cfg.cloudWorkers!.profiles!.other = { provider: "crabbox", settings: { setupEnv: [] } };
    const result = await check.repair!(ctx, []);
    expect(result.status).toBe("repaired");
    expect(result.config?.cloudWorkers?.profiles?.worker).toEqual(
      ctx.cfg.cloudWorkers?.profiles?.worker,
    );
    expect(result.config?.cloudWorkers?.profiles?.other?.settings).toEqual({ setupSecrets: {} });
    expect(result.warnings?.join(" ")).toContain("conflicts");
  });

  it("uses the default store and retains compatible mappings", async () => {
    const check = captureCrabboxDoctorCheck(CRABBOX_SETUP_SECRETS_CHECK_ID, ready);
    const ctx = context({
      setupEnv: ["TOKEN"],
      setupSecrets: { TOKEN: protectedSecret("TOKEN", "protected") },
    });
    ctx.cfg.secrets = { defaults: { store: "protected" } };
    const result = await check.repair!(ctx, []);
    expect(result.config?.cloudWorkers?.profiles?.worker?.settings).toEqual({
      setupSecrets: { TOKEN: protectedSecret("TOKEN", "protected") },
    });
  });
});
