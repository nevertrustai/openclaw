import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const callGatewayFromCli = vi.fn();

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");
const { readCronPayloadScript, readCronTriggerScript, readCronScratchContent } =
  await import("./trigger-options.js");

async function run(operation: "add" | "edit", options: Record<string, string | true>) {
  const program = new Command().exitOverride();
  if (operation === "add") {
    registerCronAddCommand(program);
  } else {
    registerCronEditCommand(program);
  }
  const prefix = operation === "add" ? ["add"] : ["edit", "job-1"];
  const values = operation === "add" ? { name: "watcher", every: "30s", ...options } : options;
  const args = Object.entries(values).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
  await program.parseAsync([...prefix, ...args], { from: "user" });
}

async function rejectAdd(options: Record<string, string | true>, message: string) {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  try {
    await expect(run("add", options)).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
}

describe("cron trigger CLI options", () => {
  it.each([
    ["Trigger script", readCronTriggerScript],
    ["Script payload", readCronPayloadScript],
    ["Cron scratch", readCronScratchContent],
  ] as const)("rejects malformed UTF-8 for %s from files and stdin", async (label, read) => {
    const file = path.join(fixtureRoot, "invalid.txt");
    const bytes = Buffer.from([0x78, 0xff, 0x79]);
    await fs.writeFile(file, bytes);
    await expect(read(file)).rejects.toThrow(`${label} must be valid UTF-8`);
    const stdin = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(() => Readable.from([bytes])[Symbol.asyncIterator]());
    try {
      await expect(read("-")).rejects.toThrow(`${label} must be valid UTF-8`);
    } finally {
      stdin.mockRestore();
    }
  });

  it("preserves exact scratch BOM, Unicode and CRLF while scripts retain trimming", async () => {
    const file = path.join(fixtureRoot, "valid.txt");
    const text = "\uFEFF 中文 😀 \uFFFD\r\n";
    await fs.writeFile(file, text, "utf8");
    await expect(readCronScratchContent(file)).resolves.toBe(text);
    await expect(readCronTriggerScript(file)).resolves.toBe("中文 😀 \uFFFD");
    await expect(readCronPayloadScript(file)).resolves.toBe("中文 😀 \uFFFD");
  });

  let fixtureRoot = "";

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-trigger-cli-"));
    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reads the exact trigger path on add", async () => {
    const scriptPath = path.join(fixtureRoot, "watch.js ");
    await fs.writeFile(path.join(fixtureRoot, "watch.js"), "json({ fire: false })", "utf8");
    await fs.writeFile(scriptPath, "  json({ fire: true })  \n", "utf8");
    await run("add", {
      "trigger-script": scriptPath,
      "trigger-once": true,
      "system-event": "changed",
      session: "main",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ triggerScript: scriptPath, triggerOnce: true }),
      expect.objectContaining({
        trigger: { script: "json({ fire: true })", once: true },
      }),
    );
  });

  it("rejects an explicitly blank trigger script before adding a job", async () => {
    await rejectAdd(
      { "trigger-script": "   ", "system-event": "changed", session: "main" },
      "--trigger-script must not be blank",
    );
  });

  it("reads the exact payload path and budgets on add", async () => {
    const scriptPath = path.join(fixtureRoot, "job.js ");
    await fs.writeFile(path.join(fixtureRoot, "job.js"), "return { notify: 'wrong file' }", "utf8");
    await fs.writeFile(scriptPath, "  return { notify: 'done' }  \n", "utf8");
    await run("add", {
      name: "script job",
      script: scriptPath,
      "script-timeout-seconds": "450",
      "script-tool-budget": "75",
      session: "isolated",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        script: scriptPath,
        scriptTimeoutSeconds: "450",
        scriptToolBudget: "75",
      }),
      expect.objectContaining({
        sessionTarget: "isolated",
        payload: {
          kind: "script",
          script: "return { notify: 'done' }",
          timeoutSeconds: 450,
          toolBudget: 75,
        },
      }),
    );
  });

  it("rejects script creation with a generic timeout", async () => {
    const scriptPath = path.join(fixtureRoot, "job.js");
    await fs.writeFile(scriptPath, "return { notify: 'done' }", "utf8");
    await rejectAdd(
      { name: "script job", script: scriptPath, "timeout-seconds": "30" },
      "Use --script-timeout-seconds for script jobs, not --timeout-seconds.",
    );
  });

  it("reads the exact payload path on edit", async () => {
    const scriptPath = path.join(fixtureRoot, "edit-job.js ");
    await fs.writeFile(
      path.join(fixtureRoot, "edit-job.js"),
      "return { state: { ok: false } }",
      "utf8",
    );
    await fs.writeFile(scriptPath, "return { state: { ok: true } }\n", "utf8");
    await run("edit", {
      script: scriptPath,
      "script-timeout-seconds": "600",
      "script-tool-budget": "100",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ script: scriptPath }),
      {
        id: "job-1",
        patch: {
          payload: {
            kind: "script",
            script: "return { state: { ok: true } }",
            timeoutSeconds: 600,
            toolBudget: 100,
          },
        },
      },
    );
  });

  it("sends pacing bounds on add", async () => {
    await run("add", {
      name: "paced",
      every: "30m",
      "pacing-min": "15m",
      "pacing-max": "4h",
      "system-event": "check",
      session: "main",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ pacing: { min: "15m", max: "4h" } }),
    );
  });

  it("maps --clear-trigger to a nullable edit patch", async () => {
    await run("edit", { "clear-trigger": true });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearTrigger: true }),
      { id: "job-1", patch: { trigger: null } },
    );
  });

  it("maps --clear-pacing to a nullable edit patch", async () => {
    await run("edit", { "clear-pacing": true });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({ clearPacing: true }),
      { id: "job-1", patch: { pacing: null } },
    );
  });
});
