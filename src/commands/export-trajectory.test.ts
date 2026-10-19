import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../cli/failure-output.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  exportTrajectoryForCommand: vi.fn(),
  formatTrajectoryCommandExportSummary: vi.fn(),
  getRuntimeConfig: vi.fn(),
  loadSessionEntryReadOnly: vi.fn(),
  resolveExplicitStorePath: vi.fn(),
  resolveSessionTranscriptReadTarget: vi.fn(),
  resolveStorePath: vi.fn(),
}));

// mock-isolation: Trajectory export fixtures select synthetic stores without reading operator config.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  loadConfig: mocks.getRuntimeConfig,
  captureRuntimeConfigAsyncReader:
    (...args: Parameters<typeof mocks.getRuntimeConfig>) =>
    async () =>
      mocks.getRuntimeConfig(...args),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  mocks.resolveSessionTranscriptReadTarget.mockImplementation(
    actual.resolveSessionTranscriptReadTarget,
  );
  return {
    ...actual,
    loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
    resolveSessionTranscriptReadTarget: mocks.resolveSessionTranscriptReadTarget,
  };
});

vi.mock("../trajectory/command-export.js", () => ({
  exportTrajectoryForCommand: mocks.exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary: mocks.formatTrajectoryCommandExportSummary,
}));

vi.mock("../config/sessions/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/paths.js")>();
  return {
    ...actual,
    resolveSessionStorePathCore: mocks.resolveStorePath,
  };
});

vi.mock("./session-store-targets.js", () => ({
  resolveExplicitSessionStorePath: mocks.resolveExplicitStorePath,
}));

let runtime: ReturnType<typeof createTestRuntime>;
const sessionKey = "agent:main:telegram:direct:123";
type Options = Parameters<typeof exportTrajectoryCommand>[0];
const encode = (request: unknown) =>
  Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
const run = (options: Options = {}) => exportTrajectoryCommand({ sessionKey, ...options }, runtime);
async function expectTrajectoryFailure(options: Options, message: string) {
  const execution = run(options);
  await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
  await expect(execution).rejects.toMatchObject({
    message,
    humanOutput: message,
    machineOutput: message,
  });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(runtime.log).not.toHaveBeenCalled();
}
function expectNoSessionLookup() {
  expect(mocks.resolveStorePath).not.toHaveBeenCalled();
  expectNoReadOrExport();
}
function expectNoReadOrExport() {
  expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
  expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
}

describe("exportTrajectoryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createTestRuntime();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/sessions.json");
    mocks.resolveExplicitStorePath.mockImplementation(
      (params: { storePath: string }) => params.storePath,
    );
    mocks.loadSessionEntryReadOnly.mockReturnValue({ sessionId: "session-1", updatedAt: 1 });
    mocks.exportTrajectoryForCommand.mockResolvedValue({
      outputDir: "/tmp/workspace/.openclaw/trajectory-exports/export",
      displayPath: ".openclaw/trajectory-exports/export",
      sessionId: "session-1",
      eventCount: 2,
      runtimeEventCount: 0,
      transcriptEventCount: 2,
      files: ["manifest.json", "events.jsonl", "session-branch.json"],
    });
    mocks.formatTrajectoryCommandExportSummary.mockReturnValue("trajectory exported");
  });

  it("points missing session key users at the sessions command", async () => {
    await expectTrajectoryFailure(
      { sessionKey: undefined },
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expectNoSessionLookup();
  });

  it.each([
    ["malformed JSON", Buffer.from("not json", "utf8").toString("base64url"), "is invalid JSON"],
    ["a non-object JSON value", encode([]), "must be a JSON object"],
    ["nonzero padding bits", `${encode({ sessionKey: "xy" }).slice(0, -1)}R`, "is invalid"],
    ["surrounding whitespace", ` ${encode({ sessionKey: "xyz" })} `, "is invalid"],
  ])(
    "rejects an encoded request containing %s before looking up its session",
    async (_name, encoded, detail) => {
      await expectTrajectoryFailure(
        { requestJsonBase64: encoded },
        `Failed to decode trajectory export request: Encoded trajectory export request ${detail}`,
      );
      expectNoSessionLookup();
    },
  );

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
  ])("rejects an %s explicit agent before reading a session", async (_label, agent, message) => {
    const runtime = createTestRuntime();
    mocks.getRuntimeConfig.mockReturnValue({ agents: { entries: { main: {} } } });

    await expectTrajectoryFailure(
      exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123", agent }, runtime),
      runtime,
      message,
    );
    expect(mocks.resolveStorePath).not.toHaveBeenCalled();
    expect(mocks.loadSessionEntryReadOnly).not.toHaveBeenCalled();
    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["whitespace-only", "agent", "   ", "--agent must not be blank"],
    ["whitespace-only", "store", "   ", "--store must not be blank"],
  ])("rejects an %s encoded %s before reading a session", async (_label, field, value, message) => {
    await expectTrajectoryFailure(
      { requestJsonBase64: encode({ sessionKey, [field]: value }) },
      message,
    );
    expectNoSessionLookup();
  });

  it("honours a non-blank encoded store and agent", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ agents: { entries: { main: {}, work: {} } } });
    mocks.resolveStorePath.mockReturnValue("/tmp/encoded-store.json");
    await run({
      requestJsonBase64: encode({ sessionKey, store: "/tmp/encoded-store.json", agent: "work" }),
    });

    expect(mocks.resolveStorePath).toHaveBeenCalledWith("/tmp/encoded-store.json", {
      agentId: "work",
    });
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey,
      storePath: "/tmp/encoded-store.json",
    });
  });

  it("routes invalid explicit stores through the command failure owner", async () => {
    mocks.resolveStorePath.mockReturnValue("/tmp/missing.sqlite");
    mocks.resolveExplicitStorePath.mockImplementationOnce(() => {
      throw new Error("Session store target does not exist: /tmp/missing.sqlite");
    });

    await expectTrajectoryFailure(
      { store: "/tmp/missing.sqlite", json: true },
      "Session store target does not exist: /tmp/missing.sqlite",
    );

    expectNoReadOrExport();
  });

  it("requires an explicit owner for an ambiguous alias before reading or exporting", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { ownership: "explicit", entries: { main: {}, work: {} } },
    });

    await expect(run({ sessionKey: "global" })).rejects.toThrow("--agent <id>");

    expectNoReadOrExport();
  });

  it("uses configured session.store when no explicit store is provided", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      session: { store: "/tmp/openclaw/agents/{agentId}/sessions/sessions.json" },
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/openclaw/agents/work/sessions/sessions.json");

    await run({ sessionKey: "agent:work:telegram:direct:123" });

    expect(mocks.resolveStorePath).toHaveBeenCalledWith(
      "/tmp/openclaw/agents/{agentId}/sessions/sessions.json",
      { agentId: "work" },
    );
    expect(mocks.loadSessionEntryReadOnly).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey: "agent:work:telegram:direct:123",
      storePath: "/tmp/openclaw/agents/work/sessions/sessions.json",
    });
  });

  it("reports a missing session without resolving its transcript or exporting", async () => {
    mocks.loadSessionEntryReadOnly.mockReturnValue(undefined);

    await expectTrajectoryFailure(
      {},
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );

    expect(mocks.resolveSessionTranscriptReadTarget).not.toHaveBeenCalled();
    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it("reports transcript target resolution failures without invoking the exporter", async () => {
    mocks.resolveSessionTranscriptReadTarget.mockImplementationOnce(() => {
      throw new Error("transcript target is unavailable");
    });

    await expectTrajectoryFailure(
      {},
      "Failed to resolve session file: transcript target is unavailable",
    );

    expect(mocks.exportTrajectoryForCommand).not.toHaveBeenCalled();
  });

  it("reports exporter failures without formatting a successful result", async () => {
    mocks.exportTrajectoryForCommand.mockRejectedValueOnce(new Error("workspace is unavailable"));

    await expectTrajectoryFailure({}, "Failed to export trajectory: workspace is unavailable");

    expect(mocks.formatTrajectoryCommandExportSummary).not.toHaveBeenCalled();
  });

  it("preserves successful JSON output", async () => {
    await run({ json: true });

    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify(await mocks.exportTrajectoryForCommand.mock.results[0]?.value, null, 2),
    );
    expect(mocks.formatTrajectoryCommandExportSummary).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
