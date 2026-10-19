import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { OutboundReplyPayload, PluginRuntime } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  createAccount as createFixtureAccount,
  createMessage,
  requireFirstMockArg,
} from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const {
  createChannelPairingControllerMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime(params?: {
  buildMentionRegexes?: () => RegExp[];
  hasControlCommand?: (body: string) => boolean;
  matchesMentionPatterns?: (body: string, regexes: RegExp[]) => boolean;
  shouldHandleTextCommands?: () => boolean;
}) {
  const runtime = {
    channel: {
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        dispatchReply: vi.fn(async () => undefined),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      commands: {
        shouldHandleTextCommands: params?.shouldHandleTextCommands ?? vi.fn(() => false),
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: params?.buildMentionRegexes ?? vi.fn(() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? vi.fn(() => false),
      },
    },
  };
  setNextcloudTalkRuntime(runtime as unknown as PluginRuntime);
  return runtime;
}

function createAccount(
  config: ResolvedNextcloudTalkAccount["config"] = {},
): ResolvedNextcloudTalkAccount {
  return createFixtureAccount({ config: { ...createFixtureAccount().config, ...config } });
}

function installPairingController(readStoreForDmPolicy = vi.fn(), issueChallenge = vi.fn()) {
  createChannelPairingControllerMock.mockReturnValue({ readStoreForDmPolicy, issueChallenge });
}

const defaultConfig = { channels: { "nextcloud-talk": {} } } as CoreConfig;
function inbound(overrides: Partial<Parameters<typeof handleNextcloudTalkInbound>[0]> = {}) {
  return handleNextcloudTalkInbound({
    message: createMessage(),
    account: createAccount(),
    config: defaultConfig,
    runtime: createRuntimeSpies(),
    ...overrides,
  });
}
function installAllowedRuntime() {
  const runtime = createPluginRuntimeMock();
  setNextcloudTalkRuntime(runtime);
  installPairingController(vi.fn(async () => []));
  return runtime;
}
const allowedAccount = () => createAccount({ dmPolicy: "allowlist", allowFrom: ["user-1"] });
function dispatched(runtime: ReturnType<typeof createPluginRuntimeMock>) {
  return expectDefined(
    vi.mocked(runtime.channel.inbound.dispatchReply).mock.calls[0]?.[0],
    "Nextcloud Talk assembled request",
  );
}

describe("nextcloud-talk inbound behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
  });

  it("logs the drop when an inbound message has an empty body", async () => {
    const runtime = createRuntimeSpies();
    await inbound({
      message: createMessage({ text: "", mediaType: "application/pdf" }),
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: drop empty message body (mediaType=application/pdf) target=user-1",
    );
    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
  });

  it("issues a DM pairing challenge and sends the challenge text", async () => {
    const issueChallenge = vi.fn(
      async (params: { sendPairingReply: (text: string) => Promise<void> }) => {
        await params.sendPairingReply("Pair with code 123456");
      },
    );
    installPairingController(vi.fn(), issueChallenge);
    sendMessageNextcloudTalkMock.mockResolvedValue(undefined);

    const statusSink = vi.fn();
    await inbound({
      message: createMessage({ timestamp: 1_736_380_800_000 }),
      statusSink,
    });

    expect(requireFirstMockArg(issueChallenge, "Nextcloud Talk pairing challenge")).toMatchObject({
      senderId: "user-1",
      senderIdLine: "Your Nextcloud user id: user-1",
      meta: { name: "Alice" },
    });
    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledExactlyOnceWith(
      "room-1",
      "Pair with code 123456",
      { cfg: defaultConfig, accountId: "default" },
    );
    expect(statusSink).toHaveBeenCalledWith({ lastInboundAt: 1_736_380_800_000 });
    const outboundStatus = statusSink.mock.calls
      .map(([status]) => status as { lastOutboundAt?: unknown })
      .find((status) => status.lastOutboundAt !== undefined);
    expect(typeof outboundStatus?.lastOutboundAt).toBe("number");
    expect(outboundStatus?.lastOutboundAt).toBeGreaterThanOrEqual(1_736_380_800_000);
  });

  it("drops unmentioned group traffic before dispatch", async () => {
    installRuntime({
      buildMentionRegexes: vi.fn(() => [/@openclaw/i]),
      matchesMentionPatterns: vi.fn(() => false),
    });
    installPairingController();
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    const runtime = createRuntimeSpies();

    await inbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
      }),
      account: createAccount({ groupAllowFrom: ["user-1"] }),
      runtime,
    });

    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
  });

  it.each([
    ["plain", "/help"],
    ["structured", JSON.stringify({ message: "/help", parameters: {} })],
  ])(
    "blocks %s group commands when room access allows chat but command access does not",
    async (_label, text) => {
      const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
      const coreRuntime = createPluginRuntimeMock({
        channel: {
          text: { hasControlCommand: vi.fn((body?: string) => body === "/help") },
          commands: { shouldHandleTextCommands: vi.fn(() => true) },
          mentions: { buildMentionRegexes },
        },
      });
      setNextcloudTalkRuntime(coreRuntime);
      installPairingController();
      resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
      const runtime = createRuntimeSpies();

      await inbound({
        message: createMessage({
          roomToken: "room-group",
          roomName: "Ops",
          isGroupChat: true,
          text,
        }),
        account: createAccount({
          rooms: { "room-group": { allowFrom: ["user-1"], requireMention: false } },
        }),
        runtime,
      });

      expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
      expect(buildMentionRegexes).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(
        "nextcloud-talk: drop control command (unauthorized) target=user-1",
      );
    },
  );

  it("keeps command and raw projections separate for structured group commands without mention", async () => {
    const text = '{"message":"/help","parameters":{}}';
    const command = "/help";
    const hasControlCommand = vi.fn((body?: string) => body?.startsWith("/") ?? false);
    const coreRuntime = createPluginRuntimeMock({
      channel: {
        text: { hasControlCommand },
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
        mentions: {
          buildMentionRegexes: vi.fn(() => [/@openclaw/i]),
          matchesMentionPatterns: vi.fn(() => false),
        },
      },
    });
    setNextcloudTalkRuntime(coreRuntime);
    installPairingController(vi.fn(async () => []));
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    const account = createAccount({
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupAllowFrom: ["user-1"],
      rooms: { "room-1": { requireMention: true } },
    });
    const config = { channels: { "nextcloud-talk": account.config } } as CoreConfig;

    await inbound({
      message: createMessage({ text, isGroupChat: true }),
      account,
      config,
    });

    expect(hasControlCommand).toHaveBeenCalledWith(command, config);
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const assembledRequest = dispatched(coreRuntime);
    expect(assembledRequest.replyPipeline).toEqual({});
    expect(assembledRequest.ctxPayload).toEqual(
      expect.objectContaining({
        CommandBody: command,
        BodyForCommands: command,
        RawBody: text.trim(),
        BodyForAgent: text.trim(),
        CommandAuthorized: true,
        WasMentioned: false,
      }),
    );
  });

  it("binds durable ingress adoption into reply options", async () => {
    const coreRuntime = installAllowedRuntime();
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };

    await inbound({
      account: allowedAccount(),
      turnAdoptionLifecycle: lifecycle,
    });

    const request = dispatched(coreRuntime);
    expect(request.replyOptions?.turnAdoptionLifecycle).toEqual(
      expect.objectContaining({ admission: "exclusive", onAdopted: lifecycle.onAdopted }),
    );
  });

  it("sanitizes inbound replies before local delivery while preserving transport fields", async () => {
    const coreRuntime = installAllowedRuntime();
    sendMessageNextcloudTalkMock.mockResolvedValue(undefined);

    await inbound({ account: allowedAccount() });

    const assembledRequest = dispatched(coreRuntime) as {
      delivery?: {
        preparePayload?: (payload: OutboundReplyPayload) => OutboundReplyPayload;
        deliver?: (payload: OutboundReplyPayload) => Promise<{ visibleReplySent: boolean }>;
      };
    };
    const preparePayload = assembledRequest.delivery?.preparePayload;
    const deliver = assembledRequest.delivery?.deliver;
    if (!preparePayload || !deliver) {
      throw new Error("expected Nextcloud Talk reply delivery hooks");
    }

    const mediaOnlyPayload = { mediaUrl: "https://example.com/a.png" };
    expect(preparePayload(mediaOnlyPayload)).toBe(mediaOnlyPayload);

    const preparedPayload = preparePayload({
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      mediaUrls: ["https://example.com/a.png"],
      replyToId: "reply-1",
    });
    expect(preparedPayload).toEqual({
      text: "Done.",
      mediaUrls: ["https://example.com/a.png"],
      replyToId: "reply-1",
    });
    await expect(deliver(preparedPayload)).resolves.toEqual({ visibleReplySent: true });
    await expect(
      deliver(preparePayload({ text: "⚠️ 🛠️ `search repos (agent)` failed" })),
    ).resolves.toEqual({ visibleReplySent: false });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledExactlyOnceWith(
      "room-1",
      "Done.\n\nAttachment: https://example.com/a.png",
      {
        cfg: defaultConfig,
        accountId: "default",
        replyTo: "reply-1",
      },
    );
  });
});
