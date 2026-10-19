import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../../process/exec.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import {
  bindSandboxInputStager,
  createSandboxInputStager,
  getSandboxInputStager,
} from "./input-staging.js";
import { bindLocalSandboxWorkspace } from "./local-workspace.js";
import { createSandboxTestContext } from "./test-fixtures.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const execParams = { command: "true", env: {}, usePty: false };
function createLocalSandbox(
  root: string,
  overrides: Partial<SandboxBackendHandle> = {},
  afterShell: (params: Parameters<SandboxBackendHandle["runShellCommand"]>[0]) => void = () => {},
) {
  const backend: SandboxBackendHandle = {
    id: "local-test",
    runtimeId: "local-test",
    runtimeLabel: "local-test",
    workdir: root,
    buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async (params) => {
      const result = await runCommandBuffered(
        ["sh", "-c", params.script, "sandbox-test", ...(params.args ?? [])],
        { input: params.stdin, signal: params.signal, timeoutMs: 10000 },
      );
      afterShell(params);
      if (result.code !== 0 && !params.allowFailure) {
        throw new Error(result.stderr.toString());
      }
      return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    ...overrides,
  };
  const sandbox = createSandboxTestContext({
    overrides: { workspaceDir: root, agentWorkspaceDir: root, containerWorkdir: root, backend },
  });
  const bridge = createSandboxFsBridge({ sandbox });
  sandbox.fsBridge = bridge;
  return { sandbox, backend, bridge };
}

function bindWorkspace(
  sandbox: ReturnType<typeof createLocalSandbox>["sandbox"],
  assertCurrent: () => void,
  overrides: Partial<Parameters<typeof bindLocalSandboxWorkspace>[1]> = {},
) {
  bindLocalSandboxWorkspace(sandbox, {
    [Symbol.dispose]() {},
    workspaceDir: sandbox.workspaceDir,
    workspaceCwd: sandbox.workspaceDir,
    checkpoint: async () => {},
    retain: () => {
      assertCurrent();
      return () => {};
    },
    provision: async (run) => await run(),
    assertCurrent,
    ...overrides,
  });
}

it.runIf(process.platform !== "win32")(
  "keeps real bridge reads, path identity, and writes while checkpointing mutations",
  async () => {
    const root = dirs.make("openclaw-bound-local-bridge-");
    let revoked = false;
    let revokeDuringBuild = false;
    let waitForAdmission: Promise<void> | undefined;
    const checkpoint = vi.fn(async () => {});
    const finalized = vi.fn(async () => {});
    const { sandbox, backend, bridge } = createLocalSandbox(root, {
      buildExecSpec: async () => {
        if (revokeDuringBuild) {
          revoked = true;
        }
        return { argv: ["true"], env: {}, stdinMode: "pipe-closed", finalizeToken: "prepared" };
      },
      finalizeExec: finalized,
    });
    const assertCurrent = () => {
      if (revoked) {
        throw new Error("revoked");
      }
    };
    bindSandboxInputStager(bridge, createSandboxInputStager({ root, bridge, assertCurrent }));
    bindWorkspace(sandbox, assertCurrent, {
      checkpoint,
      provision: async (run) => {
        await waitForAdmission;
        return await run();
      },
    });
    await bridge.writeFile({ filePath: "note.txt", data: "bound write" });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(bridge.resolvePath({ filePath: "note.txt" }).hostPath).toBe(path.join(root, "note.txt"));
    expect((await bridge.readFile({ filePath: "note.txt" })).toString()).toBe("bound write");
    expect(bridge.pathMappings?.length).toBeGreaterThan(0);
    const spec = await backend.buildExecSpec(execParams);
    revoked = true;
    expect(() => spec.assertCurrent?.()).toThrow("revoked");
    await expect(bridge.writeFile({ filePath: "blocked.txt", data: "no" })).rejects.toThrow(
      "revoked",
    );
    await expect(fs.stat(path.join(root, "blocked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    revoked = false;
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: spec.finalizeToken,
    });
    expect(finalized).toHaveBeenCalledOnce();
    expect(finalized).toHaveBeenCalledWith({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: "prepared",
    });
    expect(checkpoint).toHaveBeenCalledTimes(2);
    revokeDuringBuild = true;
    await expect(backend.buildExecSpec(execParams)).rejects.toThrow("revoked");
    expect(finalized).toHaveBeenLastCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: "prepared",
    });
    expect(checkpoint).toHaveBeenCalledTimes(2);
    revokeDuringBuild = false;
    revoked = false;
    const admission = createDeferred();
    waitForAdmission = admission.promise;
    const shell = backend.runShellCommand({ script: `touch "${root}/blocked.txt"` });
    const exec = backend.buildExecSpec(execParams);
    revoked = true;
    admission.resolve();
    await expect(shell).rejects.toThrow("revoked");
    await expect(exec).rejects.toThrow("revoked");
    await expect(fs.stat(path.join(root, "blocked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    revoked = false;
    waitForAdmission = undefined;
    const stageInput = getSandboxInputStager(bridge)!;
    const checkpointsBeforeInput = checkpoint.mock.calls.length;
    const staged = await stageInput({
      prefix: "fetched-input",
      content: "trusted input",
      assertCurrent: () => {},
    });
    expect(await fs.readFile(staged, "utf8")).toBe("trusted input");
    expect(checkpoint).toHaveBeenCalledTimes(checkpointsBeforeInput + 1);
    const inputAdmission = createDeferred();
    waitForAdmission = inputAdmission.promise;
    const before = await fs.readdir(path.dirname(path.dirname(staged)));
    const pendingInput = stageInput({
      prefix: "late-input",
      content: "blocked",
      assertCurrent: () => {},
    });
    revoked = true;
    inputAdmission.resolve();
    await expect(pendingInput).rejects.toThrow("revoked");
    expect(await fs.readdir(path.dirname(path.dirname(staged)))).toEqual(before);
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a filesystem mutation when authority closes during path preparation",
  async () => {
    const root = dirs.make("openclaw-bound-revocation-");
    let current = true;
    let observedPreparation = false;
    const { sandbox, bridge } = createLocalSandbox(root, {}, (params) => {
      if (params.stdin === undefined) {
        observedPreparation = true;
        current = false;
      }
    });
    const assertCurrent = () => {
      if (!current) {
        throw new Error("revoked during preparation");
      }
    };
    bindWorkspace(sandbox, assertCurrent);
    await expect(
      bridge.writeFile({ filePath: "late.txt", data: "must not write" }),
    ).rejects.toThrow("revoked during preparation");
    expect(observedPreparation).toBe(true);
    await expect(fs.stat(path.join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
