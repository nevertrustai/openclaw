import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveCommandConversationResolution,
  resolveInboundConversationResolution,
} from "./conversation-resolution.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

const testConfig: OpenClawConfig = {};

function registerChannelPlugin(plugin: ChannelPlugin): void {
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
}

function command(channel: string, originatingTo: string, accountId = "default", threadId?: number) {
  return resolveCommandConversationResolution({
    cfg: testConfig,
    channel,
    originatingTo,
    accountId,
    threadId,
  });
}

function inbound(channel: string, to: string, threadId: string | number) {
  return resolveInboundConversationResolution({ cfg: testConfig, channel, to, threadId });
}

const bindingDefaults = {
  compileConfiguredBinding: () => null,
  matchInboundConversation: () => null,
};

describe("conversation resolution", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses the runtime command resolver and plugin default account", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        config: { defaultAccountId: () => "work" },
      }),
      bindings: {
        ...bindingDefaults,
        resolveCommandConversation: ({ originatingTo }) => {
          const conversationId = originatingTo?.trim().replace(/^discord:/i, "");
          return conversationId ? { conversationId } : null;
        },
      },
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "discord",
        originatingTo: "discord:channel:123",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "work",
      conversationId: "channel:123",
    });
  });

  it("applies provider-owned self-parent defaults in one core path", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "line", label: "LINE" }),
      bindings: {
        ...bindingDefaults,
        selfParentConversationByDefault: true,
        resolveCommandConversation: () => ({
          conversationId: "user:U1234567890abcdef1234567890abcdef",
        }),
      },
    });

    expect(command("line", "line:user:U1234567890abcdef1234567890abcdef")).toEqual({
      channel: "line",
      accountId: "default",
      conversationId: "user:U1234567890abcdef1234567890abcdef",
      parentConversationId: "user:U1234567890abcdef1234567890abcdef",
    });
  });

  it("normalizes conversation ids returned by the threading resolver", () => {
    const conversation = {
      conversationId: "  user:U1234567890abcdef1234567890abcdef  ",
      parentConversationId: "  room:R1234567890abcdef1234567890abcd  ",
    };
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "line", label: "LINE" }),
      threading: {
        resolveFocusedBinding: () => ({
          ...conversation,
          placement: "current" as const,
          labelNoun: "conversation",
        }),
      },
    });

    expect(command("line", "ignored", " default ")).toEqual({
      channel: "line",
      accountId: "default",
      conversationId: "user:U1234567890abcdef1234567890abcdef",
      parentConversationId: "room:R1234567890abcdef1234567890abcd",
    });
  });

  it("normalizes alias-prefixed topic routes before fallback resolution", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      messaging: {
        targetPrefixes: ["tg"],
        normalizeTarget: () => "telegram:group:-1001234567890:topic:77",
      },
    });

    expect(command("telegram", "tg:group:-1001234567890:topic:77")).toEqual({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });
  });

  it("uses undeclared raw shorthand metadata in fallback resolution", () => {
    const channel = "plainchat";
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: channel, label: channel }),
      messaging: {
        normalizeTarget: () => `${channel}:-1001234567890:77`,
      },
    });

    expect(command(channel, "-1001234567890:77")).toEqual({
      channel,
      accountId: "default",
      conversationId: "-1001234567890:77",
    });
  });

  it("normalizes numeric command thread ids through the shared route contract", () => {
    registerChannelPlugin(createChannelTestPluginBase({ id: "test-chat", label: "Test chat" }));

    expect(command("test-chat", "test-chat:channel:parent-room", "default", 42.9)).toEqual({
      channel: "test-chat",
      accountId: "default",
      conversationId: "42",
      parentConversationId: "parent-room",
      threadId: "42",
    });
  });

  it("keeps Matrix room casing when the channel resolver returns a child thread", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
      messaging: {
        resolveInboundConversation: ({ threadId, to }) => {
          const parent = to?.trim().replace(/^(?:matrix:)?(?:channel:|room:)/iu, "");
          return threadId && parent
            ? { conversationId: String(threadId), parentConversationId: parent }
            : null;
        },
      },
    });

    expect(inbound("matrix", "room:!Room:Example.org", "$thread-root")).toEqual({
      channel: "matrix",
      accountId: "default",
      conversationId: "$thread-root",
      parentConversationId: "!Room:Example.org",
      threadId: "$thread-root",
    });
  });

  it("normalizes numeric inbound thread ids through the shared route contract", () => {
    registerChannelPlugin(createChannelTestPluginBase({ id: "test-chat", label: "Test chat" }));

    expect(inbound("test-chat", "test-chat:channel:parent-room", 42.9)).toEqual({
      channel: "test-chat",
      accountId: "default",
      conversationId: "42",
      parentConversationId: "parent-room",
      threadId: "42",
    });
  });
});
