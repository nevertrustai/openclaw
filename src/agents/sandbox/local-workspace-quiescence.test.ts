import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  current: vi.fn(),
  read: vi.fn(),
  browsers: vi.fn(),
  browserCurrent: vi.fn(),
}));
vi.mock("./registry.js", () => ({
  readRegistry: mocks.read,
  readBrowserRegistry: mocks.browsers,
  assertSandboxRegistryEntryCurrent: mocks.current,
  assertSandboxBrowserRegistryEntryCurrent: mocks.browserCurrent,
}));
vi.mock("./docker.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker" },
  bindPodmanSandboxEngine: () => ({ id: "podman" }),
  execContainer: mocks.command,
  validateSandboxContainerEngineTarget: async () => {},
}));
import { quiesceLocalWorkspace } from "./local-workspace-quiescence.js";
const id = "a".repeat(64);
const entry = {
  containerName: "owned",
  backendId: "docker",
  sessionKey: "owner",
  workspaceDir: "/owned/projection",
};
const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const commands = (action: string) =>
  mocks.command.mock.calls.filter(([, args]) => args[0] === action).map(([, args]) => args[1]);
function quiesce(overrides: Partial<Parameters<typeof quiesceLocalWorkspace>[0]> = {}) {
  return quiesceLocalWorkspace({
    workspaceDir: entry.workspaceDir,
    retained: [],
    persist: () => {},
    assertCurrent: () => {},
    ...overrides,
  });
}
beforeEach(() => {
  mocks.command.mockReset();
  mocks.current.mockReset();
  mocks.read.mockReset().mockResolvedValue({ entries: [entry] });
  mocks.browsers.mockReset().mockResolvedValue({ entries: [] });
  mocks.browserCurrent.mockReset();
});

it.each(["true", "false"])(
  "recovers its recorded paused generation (Running=%s) but never adopts a foreign pause",
  async (running) => {
    mocks.command.mockImplementation(async (_engine, args: string[]) =>
      success(args.includes("{{.State.Paused}}") ? "true" : id + ` ${running} true`),
    );
    await expect(quiesce()).rejects.toThrow("another owner");
    const { resume } = await quiesce({ retained: [{ name: "owned", id }] });
    await resume();
    expect(commands("pause")).toHaveLength(0);
    expect(commands("unpause").length).toBeGreaterThan(0);
  },
);

it.each([
  { failure: "retired", error: "retired" },
  { failure: "engine", error: "could not be inspected" },
])("rejects $failure inspection before pausing", async ({ failure, error }) => {
  mocks.command.mockImplementation(async () => {
    if (failure === "engine") {
      return { code: 125, stdout: "", stderr: "connection refused" };
    }
    mocks.current.mockImplementation(() => {
      throw new Error("retired");
    });
    return success(id + " true false");
  });
  await expect(quiesce()).rejects.toThrow(error);
  expect(mocks.command).toHaveBeenCalledOnce();
});

it("persists exact container and browser custody before pausing and resumes only those IDs", async () => {
  const browserId = "b".repeat(64);
  const retained = [
    { name: "owned", id },
    { name: "browser-owned", id: browserId },
  ];
  const persist = vi.fn();
  mocks.browsers.mockResolvedValue({
    entries: [
      { ...entry, containerName: "browser-owned" },
      { ...entry, containerName: "foreign", workspaceDir: "/other" },
    ],
  });
  mocks.command.mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "pause") {
      expect(persist).toHaveBeenLastCalledWith(args[1] === id ? retained.slice(0, 1) : retained);
    }
    return success(
      args.includes("{{.State.Paused}}")
        ? "true"
        : args[0] === "inspect"
          ? `${args.at(-1) === "browser-owned" ? browserId : id} true false`
          : "",
    );
  });
  const { resume } = await quiesce({ persist });
  expect(persist).toHaveBeenLastCalledWith(retained);
  expect(mocks.browserCurrent).toHaveBeenCalledTimes(3);
  await resume();
  expect(commands("unpause")).toEqual([browserId, id]);
  expect(mocks.command.mock.calls.map((call) => call[1][0])).toEqual([
    "inspect",
    "pause",
    "inspect",
    "pause",
    "inspect",
    "unpause",
    "inspect",
    "unpause",
  ]);
  expect(mocks.command.mock.calls[7]?.[1]).toEqual(["unpause", id]);
  expect(persist).toHaveBeenLastCalledWith([]);
});

it("records each released generation before a later resume failure and re-fences running recovery", async () => {
  const otherId = "b".repeat(64);
  const pausedIds = new Set<string>();
  let retained: Array<{ name: string; id: string }> = [];
  let failFirst = true;
  mocks.read.mockResolvedValue({ entries: [entry, { ...entry, containerName: "other" }] });
  mocks.command.mockImplementation(async (_engine, args: string[]) => {
    const runtimeId = args.at(-1) === "other" || args.at(-1) === otherId ? otherId : id;
    if (args.includes("{{.State.Paused}}")) {
      return success(String(pausedIds.has(runtimeId)));
    }
    if (args[0] === "inspect") {
      return success(runtimeId + " true " + pausedIds.has(runtimeId));
    }
    if (args[0] === "pause") {
      pausedIds.add(args[1]!);
    }
    if (args[0] === "unpause") {
      if (args[1] === id && failFirst) {
        return { code: 1, stdout: "", stderr: "temporary engine fault" };
      }
      if (!pausedIds.delete(args[1]!)) {
        return { code: 1, stdout: "", stderr: "container is not paused" };
      }
    }
    return success();
  });
  const input = {
    persist: (rows: typeof retained) => {
      retained = [...rows];
    },
  };
  const { resume } = await quiesce({ ...input, retained });
  await expect(resume()).rejects.toThrow("resume failed");
  expect(retained).toEqual([{ name: "owned", id }]);
  failFirst = false;
  const { resume: recovered } = await quiesce({ ...input, retained });
  expect(pausedIds).toEqual(new Set([id, otherId]));
  await recovered();
  expect(retained).toEqual([]);
  expect(pausedIds.size).toBe(0);
});

it.each(["inspect", "pause", "resume-inspect", "unpause"])(
  "bounds a hung %s, joins command cleanup, and preserves uncertain custody for recovery",
  async (phase) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const entered = createDeferred();
    const cleanup = createDeferred();
    const abortedCommand = Object.assign(new Error("Aborted"), { name: "AbortError" });
    let paused = false;
    let retained: Array<{ name: string; id: string }> = [];
    let fail = true;
    let aborted = false;
    let settled = false;
    mocks.command.mockImplementation(
      async (_engine, args: string[], options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        signal?.throwIfAborted();
        const action = args.includes("{{.State.Paused}}") ? "resume-inspect" : args[0];
        if (action === "pause" || action === "unpause") {
          // The engine may accept a mutation before its client stops responding.
          paused = action === "pause";
        }
        if (fail && action === phase) {
          fail = false;
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                void cleanup.promise.then(() => reject(abortedCommand));
              },
              { once: true },
            );
          });
        }
        return success(action === "resume-inspect" ? String(paused) : `${id} true ${paused}`);
      },
    );
    const input = {
      persist: (rows: typeof retained) => {
        retained = [...rows];
      },
    };
    const operation = (async () => {
      const control = await quiesce({ ...input, retained });
      await control.resume();
    })().then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      expect(settled).toBe(false);
      cleanup.resolve();
      expect(await operation).toBe(abortedCommand);
      expect(retained).toEqual(phase === "inspect" ? [] : [{ name: "owned", id }]);
      const recovery = await quiesce({ ...input, retained });
      await recovery.resume();
      expect(retained).toEqual([]);
      expect(paused).toBe(false);
    } finally {
      cleanup.resolve();
      timeout.mockRestore();
      vi.useRealTimers();
    }
  },
);

it.each([
  { owner: "workspace", removed: false, error: "revoked" },
  { owner: "registry", removed: false, error: "runtime retired" },
  { owner: "registry", removed: true, error: "runtime retired" },
])(
  "does not unpause a retired $owner owner (engine removed=$removed)",
  async ({ owner, removed, error }) => {
    let retiring = false;
    mocks.command.mockImplementation(async (_engine, args: string[]) => {
      if (args.includes("{{.State.Paused}}")) {
        return removed ? { code: 1, stdout: "", stderr: "no such container" } : success("true");
      }
      return success(args[0] === "inspect" ? id + " true false" : "");
    });
    mocks.current.mockImplementation(() => {
      if (retiring && owner === "registry") {
        throw new Error("runtime retired");
      }
    });
    const persist = vi.fn();
    const { resume } = await quiesce({
      persist,
      assertCurrent: () => {
        if (retiring && owner === "workspace") {
          throw new Error("revoked");
        }
      },
    });
    retiring = true;
    if (removed) {
      await resume();
      expect(persist).toHaveBeenLastCalledWith([]);
    } else {
      await expect(resume()).rejects.toThrow(error);
      expect(persist).toHaveBeenLastCalledWith([{ name: "owned", id }]);
    }
    expect(commands("unpause")).toHaveLength(0);
  },
);
