// Cron shared tests cover shared cron CLI parsing, display, and error helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
} from "../failure-output.js";
import { CronCliError } from "./cron-cli-error.js";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";
import {
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  getCronChannelOptions,
  handleCronCliError,
  parseAt,
  parseCronCommandEnv,
  parseCronStringList,
  parsePositiveCronDurationMs,
  printCronList,
  printCronShow,
} from "./shared.js";

describe("parseCronCommandEnv", () => {
  it("serializes prototype-named overrides with last-value precedence", () => {
    const env = parseCronCommandEnv([
      "__proto__=first",
      "NORMAL_KEY=control",
      "__proto__=kept=tail",
      "constructor=ordinary",
    ]);
    expect(JSON.stringify(env)).toBe(
      '{"__proto__":"kept=tail","NORMAL_KEY":"control","constructor":"ordinary"}',
    );
  });
});

const hoisted = vi.hoisted(() => ({
  listChannelPluginsMock: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: hoisted.listChannelPluginsMock,
}));

function createRuntimeLogCapture(): { logs: string[]; runtime: RuntimeEnv } {
  const logs: string[] = [];
  const runtime = {
    log: (msg: string) => logs.push(...msg.split("\n")),
    error: () => {},
    exit: () => {},
  } as RuntimeEnv;
  return { logs, runtime };
}

function expectLogsToInclude(logs: readonly string[], ...texts: string[]): void {
  for (const text of texts) {
    expect(logs.join("\n")).toContain(text);
  }
}

function renderJob(job: CronJob) {
  return { list: renderList(job), show: renderShow(job) };
}
function renderList(...jobs: CronJob[]) {
  const { logs, runtime } = createRuntimeLogCapture();
  printCronList(jobs, runtime);
  return logs;
}
function renderShow(job: CronJob) {
  const { logs, runtime } = createRuntimeLogCapture();
  printCronShow(job, runtime);
  return logs;
}

function captureError(error: unknown): unknown {
  try {
    handleCronCliError(error);
  } catch (caught) {
    return caught;
  }
}

function withJsonArgs(args: string[], check: () => void) {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), ...args, "--json"];
  try {
    check();
  } finally {
    process.argv = argv;
    vi.unstubAllEnvs();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function createBaseJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-id",
    agentId: "main",
    name: "Test Job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3600000).toISOString() },
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: { nextRunAtMs: now + 3600000 },
    ...overrides,
  } as CronJob;
}

describe("printCronList", () => {
  beforeEach(() => {
    hoisted.listChannelPluginsMock.mockReset();
    hoisted.listChannelPluginsMock.mockReturnValue([]);
  });

  it.each([
    { at: "+010000-01-15T12:34:56.789Z", expected: "+010000-01-15 12:34Z" },
    { at: "not-a-time", expected: "-" },
  ])("preserves one-shot ISO year in cron list for $at", ({ at, expected }) => {
    const logs = renderList(createBaseJob({ schedule: { kind: "at", at }, state: {} }));
    expectLogsToInclude(logs, `at ${expected}`);
  });

  it("truncates and aligns names by sanitized terminal display width", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const prefix19 = "x".repeat(19);
    const prefix20 = "x".repeat(20);
    const prefix21 = "x".repeat(21);
    const injectedMarker = "cron-table-injection";
    const injectedControl = `\u001B]0;${injectedMarker}\u0007`;
    const cases = [
      { name: `${prefix20}🚀tail`, expected: `${prefix20}...` },
      { name: `${prefix21}Atail`, expected: `${prefix21}...` },
      { name: `${prefix19}表tail`, expected: `${prefix19}表...` },
      { name: `${prefix20}e\u0301tail`, expected: `${prefix20}e\u0301...` },
      { name: `${prefix19}👨‍👩‍👧‍👦tail`, expected: `${prefix19}👨‍👩‍👧‍👦...` },
      { name: `${prefix20}👨‍👩‍👧‍👦`, expected: `${prefix20}👨‍👩‍👧‍👦` },
      { name: `${prefix20}${injectedControl}🚀tail`, expected: `${prefix20}...` },
    ];

    printCronList(
      cases.map(({ name }, index) => createBaseJob({ id: `unicode-name-${index}`, name })),
      runtime,
    );

    const header = logs[0] ?? "";
    const rows = logs.slice(1);
    const scheduleColumn = visibleWidth(header.slice(0, header.indexOf("Schedule")));
    expect(rows).toHaveLength(cases.length);
    for (const [index, row] of rows.entries()) {
      const scheduleIndex = row.indexOf("at ");
      expect(scheduleIndex).toBeGreaterThan(-1);
      expect(visibleWidth(row.slice(0, scheduleIndex))).toBe(scheduleColumn);
      expect(row).toContain(cases[index]?.expected);
    }
    const output = logs.join("\n");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(output).not.toContain("\uFFFD");
    expect(output).not.toContain(injectedMarker);
  });

  it("sanitizes and bounds named-session targets", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const injectedMarker = "cron-target-injection";
    const sessionTarget = `session:${"x".repeat(20)}\u001B]0;${injectedMarker}\u0007`;
    const job = createBaseJob({
      id: "target-job",
      sessionTarget: sessionTarget as CronJob["sessionTarget"],
    });

    printCronList([job], runtime, {
      deliveryPreviews: new Map([[job.id, { label: "target-delivery", detail: "destination" }]]),
    });

    const header = logs[0] ?? "";
    const row = logs[1] ?? "";
    const deliveryColumn = visibleWidth(header.slice(0, header.indexOf("Delivery")));
    const deliveryIndex = row.indexOf("target-delivery");
    expect(deliveryIndex).toBeGreaterThan(-1);
    expect(visibleWidth(row.slice(0, deliveryIndex))).toBe(deliveryColumn);
    expect(row).toContain("sessio...");
    expect(row).not.toContain(injectedMarker);
  });

  it("shows declaration metadata and existing run status", () => {
    const job = createBaseJob({
      declarationKey: "daily-report",
      displayName: "Daily summary",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      sessionTarget: "isolated",
      state: {
        nextRunAtMs: Date.now() + 60_000,
        lastRunAtMs: Date.now() - 60_000,
        lastRunStatus: "error",
        lastError: "boom",
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "offline",
      },
    });

    const { list, show } = renderJob(job);
    expectLogsToInclude([list[0] ?? ""], "Declaration", "Owner");
    expectLogsToInclude(list, "daily-report", "Daily summary", "agent:ops:main");
    expectLogsToInclude(
      show,
      "declaration: daily-report",
      "display name: Daily summary",
      "owner agent: ops",
      "last error: boom",
      "last delivery: not-delivered",
      "last delivery error: offline",
    );
  });

  it("sanitizes every stored cron show value at the terminal boundary", () => {
    const control = "\u001B]0;cron-show-injection\u0007";
    const injected = (value: string) => `${control}${value}\r\nforged-row\tfield`;
    const job = createBaseJob({
      id: injected("job-id"),
      declarationKey: injected("declaration"),
      name: injected("name 🦞"),
      displayName: injected("display"),
      owner: { agentId: injected("owner"), sessionKey: injected("owner-session") },
      agentId: injected("agent"),
      sessionTarget: injected("session") as CronJob["sessionTarget"],
      payload: { kind: "agentTurn", message: "test", model: injected("model") },
      state: {
        lastError: injected("last-error"),
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: injected("delivery-error"),
        lastDiagnosticSummary: injected("diagnostic"),
      },
    });
    const { logs, runtime } = createRuntimeLogCapture();

    printCronShow(job, runtime, {
      deliveryPreview: { label: injected("delivery"), detail: injected("detail") },
    });

    const output = logs.join("\n");
    expect(output).not.toContain("\u001B");
    expect(output).not.toContain("\nforged-row");
    expect(output).toContain("\\r\\nforged-row\\tfield");
    expect(output).toContain("name 🦞");
  });

  it("tolerates malformed rows in human-readable output", () => {
    const malformedJob = {
      id: "malformed-job",
      name: undefined,
      enabled: true,
      sessionTarget: undefined,
      payload: undefined,
      schedule: undefined,
      state: undefined,
    } as unknown as CronJob;

    expectLogsToInclude(renderList(malformedJob), "malformed-job");
  });

  it.each([
    {
      schedule: { kind: "cron", expr: "* * * * *", staggerMs: 1_001 },
      expected: "cron * * * * * (stagger 1s 1ms)",
    },
    {
      schedule: { kind: "cron", expr: "0 7 * * *", staggerMs: 0 },
      expected: "cron 0 7 * * * (exact)",
    },
    {
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: true })", once: true },
      state: {
        triggerEvalCount: 4,
        lastTriggerEvalAtMs: Date.now() - 30_000,
        lastTriggerFireAtMs: Date.now() - 60_000,
      },
      expected: "every 30s+trigger",
      triggerDetail: "trigger: once=yes; evals=4;",
    },
    {
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      trigger: { script: "json({ fire: true })" },
      expected: "stream node events.mjs+trigger",
    },
    {
      schedule: { kind: "on-exit", command: "pnpm build", cwd: "/repo" },
      expected: "on-exit pnpm build @ /repo",
    },
  ] satisfies Array<{
    schedule: CronJob["schedule"];
    expected: string;
    trigger?: CronJob["trigger"];
    state?: CronJob["state"];
    triggerDetail?: string;
  }>)("formats schedules in list and show: $expected", ({ schedule, expected, ...details }) => {
    const job = createBaseJob({ schedule, state: {}, ...details });
    const { list, show } = renderJob(job);
    expectLogsToInclude(list, expected);
    expectLogsToInclude(show, `schedule: ${expected}`);
    if (details.triggerDetail) {
      expectLogsToInclude(show, details.triggerDetail);
    }
  });

  it.each([false, true])("shows disabled stream sources with running=%s", (running) => {
    const job = createBaseJob({
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      state: {
        streamStatus: "disabled",
        streamError: "stream sources require cron.triggers.enabled=true",
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-delivered",
        deliverySuppressionReason: "silent",
        ...(running ? { runningAtMs: Date.now() } : {}),
      },
    });

    const { list, show } = renderJob(job);
    const row = list.find((line) => line.includes(job.id)) ?? "";
    expect(row).toContain(running ? "running" : "disabled");
    expect(row).not.toContain("idle");
    expect(row).not.toContain("ok (suppressed)");

    expect(show).toContain(`status: ${running ? "running" : "disabled"}`);
    expectLogsToInclude(
      show,
      "stream status: disabled",
      "stream error: stream sources require cron.triggers.enabled=true",
    );
    expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: running ? "running" : "ok" });
  });

  it("shows the consecutive failure count for chronically failing jobs", () => {
    const failing = createBaseJob({
      id: "failing-job",
      name: "Failing",
      state: { lastRunStatus: "error", consecutiveErrors: 12, lastError: "boom" },
    });
    const singleFailure = createBaseJob({
      id: "single-failure-job",
      name: "Failed Once",
      state: { lastRunStatus: "error", consecutiveErrors: 1, lastError: "boom" },
    });

    const logs = renderList(failing, singleFailure);

    expectLogsToInclude(logs, "error (12x)");
    // A single failure keeps the bare status token; the count only marks repeats.
    const singleLine = logs.find((line) => line.includes("single-failure-job")) ?? "";
    expect(singleLine).toContain("error");
    expect(singleLine).not.toContain("(1x)");
  });

  it.each([
    ["required", false, "not-delivered", "HTTP 503", "ok (not delivered)"],
    ["required", false, "unknown", "request timed out", "delivery unknown"],
  ] as const)(
    "shows %s delivery outcomes (best effort %s, status %s) without changing JSON status",
    (_policy, bestEffort, deliveryStatus, deliveryError, expectedStatus) => {
      const job = createBaseJob({
        id: "delivery-job",
        delivery: {
          mode: "webhook",
          to: "https://example.invalid/hook",
          bestEffort,
        },
        state: {
          lastRunStatus: "ok",
          lastDeliveryStatus: deliveryStatus,
          lastDeliveryError: deliveryError,
        },
      });

      const { list, show } = renderJob(job);
      expectLogsToInclude(list, expectedStatus);
      expectLogsToInclude(
        show,
        `status: ${expectedStatus}`,
        `last delivery error: ${deliveryError}`,
      );

      expect(enrichCronJsonWithStatus(job)).toMatchObject({
        status: "ok",
        state: { lastRunStatus: "ok", lastDeliveryStatus: deliveryStatus },
      });
      expect(enrichCronJsonWithStatus({ jobs: [job] })).toMatchObject({
        jobs: [{ status: "ok" }],
      });
    },
  );

  it("shows recorded silent suppression without changing JSON delivery status", () => {
    const deliverySuppressionReason = "silent";
    const job = createBaseJob({
      state: {
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-delivered",
        lastDelivered: false,
        deliverySuppressionReason,
      },
    });
    const { list, show } = renderJob(job);
    expectLogsToInclude(list, "ok (suppressed)");
    expect(list.join("\n")).not.toContain("ok (not delivered)");
    expectLogsToInclude(
      show,
      "status: ok (suppressed)",
      "last delivery: not-delivered",
      `last delivery suppression: ${deliverySuppressionReason}`,
    );
    expect(enrichCronJsonWithStatus(job)).toMatchObject({
      status: "ok",
      state: {
        lastDeliveryStatus: "not-delivered",
        lastDelivered: false,
        deliverySuppressionReason,
      },
    });
  });

  it("shows why the scheduler auto-disabled a job without changing JSON status", () => {
    const disabledJob = (reason: "consecutive-failures" | "schedule-errors", count: number) =>
      createBaseJob({
        enabled: false,
        state: {
          ...(reason === "schedule-errors"
            ? { scheduleErrorCount: count }
            : { consecutiveErrors: count }),
          autoDisabled: { reason, atMs: Date.now(), consecutiveErrors: count },
        },
      });
    const runFailures = disabledJob("consecutive-failures", 10);
    const scheduleErrors = disabledJob("schedule-errors", 3);

    expectLogsToInclude(
      renderList(runFailures, scheduleErrors),
      "disabled (10x)",
      "disabled (schedule)",
    );
    expectLogsToInclude(renderShow(runFailures), "status: disabled (10x)");

    expect(enrichCronJsonWithStatus(runFailures)).toMatchObject({
      status: "disabled",
      state: {
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
      },
    });
  });

  it("caps the failure count so the status column never overflows", () => {
    const logs = renderList(
      createBaseJob({
        id: "minute-cron-job",
        state: { lastRunStatus: "error", consecutiveErrors: 1440, lastError: "boom" },
      }),
    );
    expectLogsToInclude(logs, "error (99+x)");
    expect(logs.join("\n")).not.toContain("1440");
  });

  it("shows dash for unset agentId instead of default", () => {
    const job = createBaseJob({
      id: "no-agent-job",
      name: "No Agent",
      agentId: undefined,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello", model: "sonnet" },
    });

    const logs = renderList(job);
    expect(logs[0]).toContain("Agent ID");
    const dataLine = logs[1] ?? "";
    expect(dataLine).not.toContain("default");
  });
});

describe("parseAt", () => {
  it.each([
    ["2027-02-28t24:00:00.000", "America/New_York", "2027-03-01T05:00:00.000Z"],
    ["2027-02-28t24:00:00+05:45", "Europe/Oslo", "2027-02-28T18:15:00.000Z"],
    ["2027-09-04t24:00", "America/Santiago", null],
  ])("interprets offsetless one-shot %s in %s", (input, timezone, expected) => {
    expect(parseAt(input, timezone)).toBe(expected);
    if (expected !== null) {
      expect(resolveCronCreateScheduleFromArgs({ at: input, tz: timezone })).toEqual({
        kind: "at",
        at: expected,
      });
    }
  });

  it.each([
    { input: "+30m", now: "2026-05-25T00:00:00.000Z", expected: "2026-05-25T00:30:00.000Z" },
    { input: "30m", now: "2026-05-25T00:00:00.000Z", expected: "2026-05-25T00:30:00.000Z" },
    { input: String(Number.MAX_SAFE_INTEGER), now: "2026-05-25T00:00:00.000Z", expected: null },
    { input: "+999999999999999999d", now: "2026-05-25T00:00:00.000Z", expected: null },
    { input: "+1m", now: 8_640_000_000_000_000, expected: null },
  ])("parses relative/epoch time $input at $now", ({ input, now, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    expect(parseAt(input)).toBe(expected);
  });
});

describe("getCronChannelOptions", () => {
  it.each([
    { plugins: [], expected: "last|<channel-plugin-id>" },
    { plugins: [{ id: "quietchat" }, { id: "forum" }], expected: "last|quietchat|forum" },
  ])("lists channel options as $expected", ({ plugins, expected }) => {
    hoisted.listChannelPluginsMock.mockReturnValue(plugins);
    expect(getCronChannelOptions()).toBe(expected);
  });
});

describe("parseCronStringList", () => {
  it.each([
    { input: "exec,read,write", expected: ["exec", "read", "write"] },
    { input: ["exec", "read", "write"], expected: ["exec", "read", "write"] },
    { input: undefined, expected: undefined },
  ])("parses $input", ({ input, expected }) => {
    expect(parseCronStringList(input)).toEqual(expected);
  });
});

describe("coerceCronDeliveryPreviews", () => {
  it("keeps valid previews and drops malformed entries", () => {
    expect([
      ...coerceCronDeliveryPreviews({
        deliveryPreviews: {
          job1: { label: "announce -> telegram:123", detail: "explicit" },
          job2: { label: "announce -> telegram:456" },
        },
      }),
    ]).toEqual([["job1", { label: "announce -> telegram:123", detail: "explicit" }]]);
  });
});

describe("parsePositiveCronDurationMs", () => {
  it.each([
    ["500ms", 500],
    ["30s", 30_000],
    ["1.5h", 5_400_000],
    ["1h30m", 5_400_000],
    ["1d", 86_400_000],
    ["0s", null],
    ["0.5ms", 1],
    ["0.001ms", null],
    ["-5s", null],
    ["abc", null],
    ["", null],
    // A finite mantissa can overflow when multiplied by a unit factor (#83906).
    [`1${"0".repeat(302)}d`, null],
    ["8640000000000000ms", 8_640_000_000_000_000],
    ["8640000000000001ms", null],
  ] as const)("parses bounded positive duration %j as %j", (input, expected) => {
    expect(parsePositiveCronDurationMs(input)).toBe(expected);
  });
});

describe("handleCronCliError", () => {
  it("renders typed automation lookup misses with the cron list recovery command", () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
    const errorOutput = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(() => handleCronCliError(error)).toThrow("exit 1");
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
      ),
    );
    errorOutput.mockRestore();
    exit.mockRestore();
  });

  it("hands a typed lookup miss to the root renderer as an expected machine-output failure", () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
    const message =
      "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.";
    withJsonArgs(["cron", "show", "missing-job"], () => {
      const thrown = captureError(error);
      expect(thrown).toBeInstanceOf(ExpectedCliError);
      expect(formatCliJsonFailure(thrown)).toEqual({
        ok: false,
        error: { type: "cli_error", message },
      });
      const stderr = formatCliFailureLines({
        title: "Could not start the CLI.",
        error: thrown,
        argv: process.argv,
      }).join("\n");
      expect(stderr).toContain(message);
      expect(stderr).not.toContain("Could not start the CLI.");
      expect(stderr).not.toContain("openclaw doctor");
      expect(stderr).not.toContain("OPENCLAW_DEBUG");
    });
  });

  // A legacy gateway without cron.get makes `cron edit <id> --exact` wrap the
  // lookup miss; the renderer only reveals such causes on explicit debug intent.
  it.each([
    {
      label: "stays terse without debug intent",
      flags: [] as string[],
      debug: "",
      causeShown: false,
    },
    { label: "keeps causes for --debug", flags: ["--debug"], debug: "", causeShown: true },
  ])("machine output for a wrapped cron failure $label", ({ flags, debug, causeShown }) => {
    const wrapped = new CronCliError("unknown automation id: missing-job", {
      cause: new Error("unknown method: cron.get"),
    });
    withJsonArgs(["cron", "edit", "missing-job", "--exact", ...flags], () => {
      vi.stubEnv("OPENCLAW_DEBUG", debug);
      const thrown = captureError(wrapped);
      expect(thrown).toBeInstanceOf(ExpectedCliError);
      const machineMessage = formatCliJsonFailure(thrown).error.message;
      expect(machineMessage).toContain("unknown automation id: missing-job");
      expect(machineMessage.includes("unknown method: cron.get")).toBe(causeShown);
      const stderr = formatCliFailureLines({
        title: "The CLI command failed.",
        error: thrown,
      }).join("\n");
      expect(stderr).toContain("unknown automation id: missing-job");
      expect(stderr.includes("unknown method: cron.get")).toBe(causeShown);
    });
  });

  it.each([false, true])("preserves unexpected machine-mode errors with debug=%s", (debug) => {
    const error = new Error("Automation runtime failed", {
      cause: new Error("Runtime load failed"),
    });
    withJsonArgs(["automations", "status"], () => {
      vi.stubEnv("OPENCLAW_DEBUG", debug ? "1" : "");
      const thrown = captureError(error);
      expect(thrown).toBe(error);
      const stderr = formatCliFailureLines({
        title: "The CLI command failed.",
        error: thrown,
      }).join("\n");
      expect(stderr).toContain("The CLI command failed.");
      expect(stderr).toContain("openclaw doctor");
      expect(stderr.includes("Stack:")).toBe(debug);
      expect(formatCliJsonFailure(thrown).error.message.includes("Runtime load failed")).toBe(
        debug,
      );
    });
  });
});
