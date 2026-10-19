import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "../agents/workspace-alias-rebind.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  collectRepointedWorkspaceAliasFindings,
  createWorkspaceAliasMigrationRepair,
} from "./doctor-workspace-alias.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-workspace-alias-",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

function buildPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: {
      shouldRepair: true,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
    ...overrides,
  };
}

function buildAliasCfg(aliasPath: string, other?: string): OpenClawConfig {
  return {
    agents: {
      entries: {
        main: { workspace: aliasPath },
        ...(other ? { legacy: { workspace: other } } : {}),
      },
    },
  };
}

async function runWorkspaceRepair(cfg: OpenClawConfig, prompter: DoctorPrompter) {
  const repair = createWorkspaceAliasMigrationRepair(prompter, vi.fn());
  expect(repair).toBeTypeOf("function");
  await repair!(cfg);
}

function link(target: string, alias: string) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
async function expectState(directory: string, exists: boolean) {
  expect((await readWorkspaceStateSnapshot(directory)).setupExists).toBe(exists);
}
async function repointAlias(params: { seedAttestedFile?: boolean; name?: string } = {}) {
  const original = params.name ? testState!.path(params.name, "original") : testState!.workspaceDir;
  const localPath = (name: string) =>
    testState!.path(...(params.name ? [params.name, name] : [name]));
  const alias = localPath("workspace-link");
  const replacement = localPath("replacement-workspace");
  fs.mkdirSync(original, { recursive: true });
  link(original, alias);
  await mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
  if (params.seedAttestedFile) {
    const content = "seeded bootstrap content";
    fs.writeFileSync(path.join(original, "BOOTSTRAP.md"), content);
    await replaceWorkspaceAttestation({
      workspaceDir: alias,
      attestedAtMs: 1_000,
      generatedHashes: new Map([
        ["BOOTSTRAP.md", crypto.createHash("sha256").update(content).digest("hex")],
      ]),
      nowMs: 1_000,
    });
  }
  fs.renameSync(original, replacement);
  fs.unlinkSync(alias);
  link(replacement, alias);
  return { alias, original, replacement };
}

describe("doctor workspace alias repair", () => {
  it("leaves state intact when configuration changes during confirmation", async () => {
    const { alias, original, replacement } = await repointAlias({ seedAttestedFile: true });
    const cfg = buildAliasCfg(alias);
    await testState!.writeConfig(cfg);
    const prompter = buildPrompter({
      confirmRuntimeRepair: vi.fn(async () => {
        await testState!.writeConfig(buildAliasCfg(alias, original));
        return true;
      }),
    });
    await expect(runWorkspaceRepair(cfg, prompter)).rejects.toThrow();
    await expectState(original, true);
    await expectState(replacement, false);
  });

  it("does not adopt a target substituted during confirmation", async () => {
    const { alias, original } = await repointAlias({ seedAttestedFile: true });
    const changed = testState!.path("changed-target");
    fs.mkdirSync(changed);
    const prompter = buildPrompter({
      confirmRuntimeRepair: vi.fn(async () => {
        fs.unlinkSync(alias);
        link(changed, alias);
        return true;
      }),
    });
    await expect(runWorkspaceRepair(buildAliasCfg(alias), prompter)).rejects.toThrow();
    await expectState(original, true);
    await expectState(changed, false);
  });

  it("shares one private snapshot across alias findings and rereads committed repairs", async () => {
    const aliases = [];
    for (const name of ["first", "second", "third"]) {
      aliases.push(await repointAlias({ name }));
    }
    const cfg: OpenClawConfig = {
      agents: {
        entries: Object.fromEntries(
          aliases.map(({ alias }, index) => [`agent-${index}`, { workspace: alias }]),
        ),
      },
    };
    closeOpenClawStateDatabaseForTest();
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    const inspect = () =>
      withArtifactPreservingStateReads(() => collectRepointedWorkspaceAliasFindings(cfg));

    const findings = await inspect();
    expect(findings).toHaveLength(3);
    for (const [index, finding] of findings.entries()) {
      expect(finding).toMatchObject({
        checkId: "core/doctor/workspace-alias",
        severity: "warning",
        fixHint: expect.stringContaining("doctor --fix"),
        message: expect.stringContaining(aliases[index]!.alias),
      });
    }
    expect(prepare).toHaveBeenCalledOnce();
    const firstSnapshot = prepare.mock.results[0]?.value;
    expect(fs.existsSync(firstSnapshot.location)).toBe(false);

    const first = aliases[0]!;
    const facts = detectRepointedWorkspaceAlias(first.alias);
    expect(facts).toBeDefined();
    const outcome = await rebindRepointedWorkspaceAlias(
      first.alias,
      facts!,
      {},
      aliases.map(({ alias }) => alias),
    );
    expect(outcome).toBe("rebound");
    closeOpenClawStateDatabaseForTest();
    prepare.mockClear();

    const remaining = await inspect();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(({ message }) => message)).toEqual(
      aliases.slice(1).map(({ alias }) => expect.stringContaining(alias)),
    );
    expect(prepare).toHaveBeenCalledOnce();
    const nextSnapshot = prepare.mock.results[0]?.value;
    expect(nextSnapshot.location).not.toBe(firstSnapshot.location);
    expect(fs.existsSync(nextSnapshot.location)).toBe(false);
  });

  it("requires explicit confirmation even when generated hashes match", async () => {
    const { alias, original } = await repointAlias({ seedAttestedFile: true });
    const prompter = buildPrompter();

    await expect(runWorkspaceRepair(buildAliasCfg(alias), prompter)).rejects.toThrow();

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();
    await expectState(original, true);

    const approving = buildPrompter({ confirmRuntimeRepair: vi.fn(async () => true) });
    await runWorkspaceRepair(buildAliasCfg(alias), approving);
    const snapshot = await readWorkspaceStateSnapshot(alias);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup.bootstrapSeededAt).toBe("2026-07-16T01:00:00.000Z");

    const secondPrompter = buildPrompter();
    await runWorkspaceRepair(buildAliasCfg(alias), secondPrompter);
    expect(secondPrompter.confirmRuntimeRepair).not.toHaveBeenCalled();
  });

  it("refuses to merge when the current target already owns state", async () => {
    const { alias, original, replacement } = await repointAlias();
    await mergeWorkspaceSetupState(
      replacement,
      { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" },
      2_000,
    );
    const prompter = buildPrompter({ confirmRuntimeRepair: vi.fn(async () => true) });

    await expect(runWorkspaceRepair(buildAliasCfg(alias), prompter)).rejects.toThrow();

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    await expectState(original, true);
    await expectState(replacement, true);
  });

  it("does not move records from diagnostic mode", async () => {
    const { original } = await repointAlias({ seedAttestedFile: true });
    const prompter = buildPrompter({
      shouldRepair: false,
      confirmRuntimeRepair: vi.fn(async () => true),
      repairMode: {
        shouldRepair: false,
        shouldForce: false,
        nonInteractive: false,
        canPrompt: true,
        updateInProgress: false,
      },
    });

    expect(createWorkspaceAliasMigrationRepair(prompter, vi.fn())).toBeUndefined();

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    await expectState(original, true);
  });

  it("refuses to transfer state while another configured agent uses the stored target", async () => {
    const { alias, original } = await repointAlias();
    const prompter = buildPrompter({ confirmRuntimeRepair: vi.fn(async () => true) });
    await expect(runWorkspaceRepair(buildAliasCfg(alias, original), prompter)).rejects.toThrow();

    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    await expectState(original, true);
  });
});
