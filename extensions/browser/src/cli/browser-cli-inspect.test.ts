import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import type { SnapshotResult } from "../browser/client.js";
import * as browserCliSharedModule from "./browser-cli-shared.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  captureRuntimeConfigAsyncReader: () => async () => configMocks.getRuntimeConfig(),
}));

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (
      _opts: unknown,
      params: Parameters<typeof browserCliSharedModule.callBrowserRequest>[1],
    ): Promise<SnapshotResult> => {
      const base = { ok: true as const, targetId: "t1", url: "https://example.com" };
      return params.query?.format === "aria"
        ? { ...base, format: "aria", nodes: [] }
        : { ...base, format: "ai", snapshot: "ok" };
    },
  ),
}));
let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

function installInspectSpies() {
  vi.restoreAllMocks();
  vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(
    sharedMocks.callBrowserRequest,
  );
  vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(runtime.writeJson);
  vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
}

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command().enablePositionalOptions();
    const browser = program
      .command("browser")
      .option("--json", "JSON output", false)
      .option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserInspectCommands(browser, (cmd) => cmd.parent?.opts() ?? {});
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    return sharedMocks.callBrowserRequest.mock.calls.at(-1)?.[1];
  };

  const runSnapshot = async (args: string[]) => await runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    installInspectSpies();
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  beforeEach(installInspectSpies);

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    resetRuntimeCapture();
    configMocks.getRuntimeConfig.mockReturnValue({ browser: {} });
  });

  it.each(["plain", "file"] as const)(
    "preserves the returned ARIA ref in %s output",
    async (output) => {
      const ref = "ax42";
      const result: SnapshotResult = {
        ok: true,
        format: "aria",
        targetId: "t1",
        url: "https://example.com",
        nodes: [{ ref, role: "textbox", name: "Entry", value: "Ready", depth: 2 }],
      };
      sharedMocks.callBrowserRequest.mockResolvedValueOnce(result);
      const outputPath =
        output === "file"
          ? path.join(tempDirs.make("openclaw-aria-output-"), "snapshot.json")
          : undefined;
      await runBrowserInspect([
        "snapshot",
        "--format",
        "aria",
        ...(outputPath ? ["--out", outputPath] : []),
      ]);

      if (outputPath) {
        expect(JSON.parse(await fs.readFile(outputPath, "utf8"))).toEqual(result);
        expect(runtime.log).toHaveBeenCalledExactlyOnceWith(outputPath);
      } else {
        expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
          `    - textbox "Entry" = "Ready" [ref=${ref}]`,
        );
      }
      expect(runtime.writeJson).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each(["screenshot", "snapshot"])(
    "keeps the gateway and %s owner on the explicit 90000 ms timeout",
    async (command) => {
      const request = await runBrowserInspect(
        ["--timeout", "60000", command, "--timeout", "90000"],
        true,
      );

      expect(sharedMocks.callBrowserRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: "90000" }),
        expect.objectContaining({ path: `/${command}` }),
      );
      expect(command === "snapshot" ? request?.query : request?.body).toMatchObject({
        timeoutMs: 90000,
      });
    },
  );

  it("uses config snapshot defaults when mode is not provided", async () => {
    configMocks.getRuntimeConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

    const params = await runSnapshot([]);
    expect(params).toMatchObject({ path: "/snapshot", query: { format: "ai", mode: "efficient" } });
  });

  it("applies explicit efficient mode without config defaults", async () => {
    const params = await runSnapshot(["--efficient"]);
    expect(params?.query).toMatchObject({ format: "ai", mode: "efficient" });
  });

  it("passes URL expansion for snapshots", async () => {
    const params = await runSnapshot(["--urls"]);
    expect(params?.query).toMatchObject({ format: "ai", urls: true });
  });

  it("rejects non-integer snapshot numeric options before dispatch", async () => {
    await expect(runSnapshot(["--limit", "1e3"])).rejects.toThrow("__exit__:1");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "Invalid --limit: must be an integer >= 1",
    );

    resetRuntimeCapture();
    await expect(runSnapshot(["--depth", "-1"])).rejects.toThrow("__exit__:1");
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "Invalid --depth: must be an integer >= 0",
    );

    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("accepts signed decimal snapshot numeric options", async () => {
    const params = await runSnapshot(["--limit", "+10", "--depth", "+0"]);
    expect(params?.query).toMatchObject({ limit: 10, depth: 0 });
  });

  it("rejects unsupported snapshot mode before dispatch", async () => {
    await expect(runBrowserInspect(["snapshot", "--mode", "full"])).rejects.toThrow("__exit__:1");

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("Invalid --mode: expected efficient");
    expect(sharedMocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("sends screenshot request with trimmed target id and jpeg type", async () => {
    const params = await runBrowserInspect(["screenshot", " tab-1 ", "--type", "jpeg"], true);
    expect(params).toMatchObject({
      path: "/screenshot",
      body: { targetId: "tab-1", type: "jpeg", fullPage: false },
    });
  });

  it("keeps an existing AI snapshot when publication fails", async () => {
    const tempDir = tempDirs.make("openclaw-browser-snapshot-");
    const outputPath = path.join(tempDir, "snapshot.txt");
    fsSync.writeFileSync(outputPath, "previous snapshot\n");
    const priorBytes = fsSync.readFileSync(outputPath);

    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      fsSync.writeFileSync(file as string, "partial replacement");
      throw new Error("injected snapshot write failure");
    });
    try {
      await expect(runSnapshot(["--out", outputPath])).rejects.toThrow("__exit__:1");
    } finally {
      writeSpy.mockRestore();
    }

    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain("injected snapshot write failure");
    expect(fsSync.readFileSync(outputPath)).toEqual(priorBytes);
    expect(fsSync.readdirSync(tempDir)).toEqual(["snapshot.txt"]);
  });
});
