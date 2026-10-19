import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../../runtime-api.js";
import { MSTeamsConfigSchema } from "../config-schema.js";
import { sendMSTeamsMessages } from "../messenger.js";
import { sendMSTeamsActivityWithReference } from "../sdk-proactive.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import type { MSTeamsApp } from "../sdk.js";
import { recordMSTeamsSentMessage } from "../sent-message-cache.js";
import * as sentMessages from "../sent-message-cache.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
let sequence = 0;

vi.mock("../graph-thread.js", () => ({
  fetchChannelMessage: vi.fn(async () => undefined),
  fetchThreadReplies: vi.fn(async () => []),
  fetchChatMessageText: vi.fn(async () => undefined),
  buildThreadContext: vi.fn(() => []),
  stripHtmlFromTeamsMessage: vi.fn((value: string) => value),
}));

vi.mock("../team-identity.js", () => ({
  resolveTeamGroupId: vi.fn(async () => "group-1"),
}));

async function sendChannelMessage(params: {
  messageId: string;
  botId?: string;
  conversationId?: string;
  threadActivityId?: string;
}) {
  const create = vi.fn(async () => ({ id: params.messageId }));
  const activities = vi.fn((_conversationId: string) => ({ create }));
  const serviceUrl = "https://smba.trafficmanager.net/amer/";
  await sendMSTeamsActivityWithReference(
    {
      api: {
        serviceUrl,
        fromServiceUrl() {
          return this;
        },
        conversations: { activities },
      },
    } as unknown as MSTeamsApp,
    {
      serviceUrl,
      agent: { id: params.botId ?? "bot-id" },
      conversation: {
        id: params.conversationId ?? channelConversationId,
        conversationType: "channel",
      },
    },
    { type: "message", text: "Synthetic bot message" },
    { threadActivityId: params.threadActivityId },
  );
  expect(create).toHaveBeenCalledTimes(1);
  return activities.mock.calls[0]?.[0];
}

function incoming(overrides: Partial<MSTeamsTurnContext["activity"]>): MSTeamsTurnContext {
  return {
    activity: buildChannelActivity({ id: `reply-${sequence}`, entities: [], ...overrides }),
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  };
}
function conversation(root: string) {
  return { id: `${channelConversationId};messageid=${root}`, conversationType: "channel" };
}
function setup(
  config: MSTeamsConfig = {},
  options: Parameters<typeof createMessageHandlerDeps>[1] = {},
) {
  const cfg: OpenClawConfig = {
    channels: {
      msteams: {
        groupPolicy: "open",
        requireMention: true,
        requireMentionInBotThreads: false,
        ...config,
      },
    },
  };
  const { deps } = createMessageHandlerDeps(cfg, options);
  return { cfg, deps, handler: createMSTeamsMessageHandler(deps) };
}

describe("Teams mention policy in bot-created channel threads", () => {
  beforeEach(() => {
    dispatch.mockClear();
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["proactive reply is not a root", true, "bot-id", channelConversationId],
    ["another bot's root", false, "other-bot", channelConversationId],
    ["another channel's root", false, "bot-id", "19:other@thread.tacv2"],
  ] as const)("%s", async (_name, threaded, botId, conversationId) => {
    const rootId = `bot-thread-root-${++sequence}`;
    const config: MSTeamsConfig = {
      groupPolicy: "open",
      requireMention: true,
      requireMentionInBotThreads: true,
      teams: {
        "team-1": {
          requireMentionInBotThreads: false,
          channels: {
            [channelConversationId]: {},
          },
        },
      },
    };
    MSTeamsConfigSchema.parse(config);
    const { handler } = setup(config);
    const destination = await sendChannelMessage({
      messageId: rootId,
      botId,
      conversationId: `${conversationId};messageid=stale-source-thread`,
      threadActivityId: threaded ? "human-thread-root" : undefined,
    });
    expect(destination).toBe(
      threaded ? `${conversationId};messageid=human-thread-root` : conversationId,
    );
    await handler(
      incoming({ conversation: conversation(rootId), replyToId: "human-nested-reply" }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("live thread replies retain reply-to-bot activation", async () => {
    const botReplyId = `bot-reply-in-human-thread-${++sequence}`;
    const { deps, handler } = setup();
    const sendActivity = vi.fn(async () => ({ id: botReplyId }));
    const sentIds = await sendMSTeamsMessages({
      replyStyle: "thread",
      app: deps.app,
      conversationRef: {
        agent: { id: "bot-id" },
        conversation: conversation("human-thread-root"),
        threadId: "human-thread-root",
      },
      context: { sendActivity },
      messages: [{ text: "Bot reply inside a human thread" }],
      onMessageSent: (messageId) => recordMSTeamsSentMessage(channelConversationId, messageId),
    });
    expect(sentIds).toEqual([botReplyId]);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    await handler(incoming({ replyToId: botReplyId }));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "sender revoked", change: { groupAllowFrom: ["other-user-aad"] } },
    { name: "group disabled", change: { groupPolicy: "disabled" as const } },
    { name: "mention required", change: { requireMentionInBotThreads: true } },
  ])("uses current admission policy after ownership lookup: $name", async ({ change }) => {
    const rootId = `bot-thread-reread-${++sequence}`;
    const { cfg, handler } = setup({ groupPolicy: "allowlist", groupAllowFrom: ["user-aad"] });
    setRuntimeConfigSnapshot(cfg);
    await sendChannelMessage({ messageId: rootId });
    const lookup = sentMessages.wasMSTeamsMessageSentWithPersistence;
    vi.spyOn(sentMessages, "wasMSTeamsMessageSentWithPersistence").mockImplementationOnce(
      async (params) => {
        const owned = await lookup(params);
        setRuntimeConfigSnapshot({
          channels: { msteams: { ...cfg.channels?.msteams, ...change } },
        });
        return owned;
      },
    );

    await handler(incoming({ conversation: conversation(rootId) }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not combine another thread's text into an unmentioned bot-thread turn", async () => {
    const queued = createDeferred<void>();
    const queuedKeys = new Set<string>();
    let queuedCount = 0;
    let flushAndDrain = async () => {};
    const createDebouncer: typeof createInboundDebouncer = (options) => {
      const debouncer = createInboundDebouncer(options);
      flushAndDrain = async () => {
        await Promise.all([...queuedKeys].map((key) => debouncer.flushKey(key)));
        await debouncer.drain();
      };
      return {
        ...debouncer,
        enqueue: async (entry) => {
          await debouncer.enqueue(entry);
          const key = options.buildKey(entry);
          if (key) {
            queuedKeys.add(key);
          }
          if (++queuedCount === 2) {
            queued.resolve();
          }
        },
      };
    };
    const { handler } = setup(
      {},
      { createInboundDebouncer: createDebouncer, resolveInboundDebounceMs: () => 100 },
    );
    const ownedRootId = `bot-thread-batch-${++sequence}`;
    await sendChannelMessage({ messageId: ownedRootId });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const messages: Array<[string, string]> = [
      ["human-thread-root", "Unaddressed message in another thread"],
      [ownedRootId, "Follow-up in the bot's thread"],
    ];
    const handlers = messages.map(([rootId, text]) =>
      handler(incoming({ id: `batch-${rootId}`, text, conversation: conversation(rootId) })),
    );
    await queued.promise;
    await flushAndDrain();
    await Promise.all(handlers);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].ctx.BodyForAgent).toBe("Follow-up in the bot's thread");
  });
});
