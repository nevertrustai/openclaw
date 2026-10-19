import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import {
  testing as sessionBindingTesting,
  createTestRegistry,
  registerSessionBindingAdapter,
  resolveAgentRoute,
  setActivePluginRegistry,
  type OpenClawConfig,
} from "../../test-support/monitor-route-test-support.js";
import { resolveMatrixInboundRouteAsync } from "./route.js";

const baseCfg = {
  session: { mainKey: "main" },
  agents: {
    entries: { main: {}, "sender-agent": {}, "room-agent": {}, "acp-agent": {} },
  },
} satisfies OpenClawConfig;

type RouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type RoutePeer = NonNullable<RouteBinding["match"]["peer"]>;

function matrixBinding(
  agentId: string,
  peer?: RoutePeer,
  type?: RouteBinding["type"],
): RouteBinding {
  return {
    ...(type ? { type } : {}),
    agentId,
    match: {
      channel: "matrix",
      accountId: "ops",
      ...(peer ? { peer } : {}),
    },
  } as RouteBinding;
}

function senderPeer(id = "@alice:example.org"): RoutePeer {
  return { kind: "direct", id };
}

function dmRoomPeer(id = "!dm:example.org"): RoutePeer {
  return { kind: "channel", id };
}

function config(...bindings: RouteBinding[]): OpenClawConfig {
  return { ...baseCfg, bindings };
}
type BindingAdapter = Parameters<typeof registerSessionBindingAdapter>[0];
function runtimeBinding(
  resolveByConversation: BindingAdapter["resolveByConversation"],
  touch?: BindingAdapter["touch"],
) {
  registerSessionBindingAdapter({
    channel: "matrix",
    accountId: "ops",
    listBySession: () => [],
    resolveByConversation,
    touch,
  });
}
function binding(
  targetSessionKey: string,
  conversation: Parameters<NonNullable<BindingAdapter["resolveByConversation"]>>[0],
  metadata?: NonNullable<
    ReturnType<NonNullable<BindingAdapter["resolveByConversation"]>>
  >["metadata"],
) {
  return {
    bindingId: "ops:!dm:example.org",
    targetSessionKey,
    targetKind: "session" as const,
    conversation,
    status: "active" as const,
    boundAt: Date.now(),
    metadata,
  };
}

function resolveDmRoute(
  cfg: OpenClawConfig,
  opts: {
    dmSessionScope?: "per-user" | "per-room";
  } = {},
) {
  return resolveMatrixInboundRouteAsync({
    cfg,
    accountId: "ops",
    roomId: "!dm:example.org",
    senderId: "@alice:example.org",
    isDirectMessage: true,
    dmSessionScope: opts.dmSessionScope,
    resolveAgentRoute,
  });
}

describe("resolveMatrixInboundRouteAsync", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: matrixPlugin }]),
    );
  });

  it("uses the DM room as a parent-peer fallback before account-level bindings", async () => {
    const cfg = config(matrixBinding("acp-agent"), matrixBinding("room-agent", dmRoomPeer()));
    const { route, configuredBinding } = await resolveDmRoute(cfg);
    expect(configuredBinding).toBeNull();
    expect(route).toMatchObject({
      agentId: "room-agent",
      matchedBy: "binding.peer.parent",
      sessionKey: "agent:room-agent:main",
    });
  });

  it("keeps configured ACP room bindings ahead of per-room DM session scope", async () => {
    const cfg = config(
      matrixBinding("room-agent", dmRoomPeer()),
      matrixBinding("acp-agent", dmRoomPeer(), "acp"),
    );
    const { route, configuredBinding } = await resolveDmRoute(cfg, { dmSessionScope: "per-room" });
    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route).toMatchObject({ agentId: "acp-agent", matchedBy: "binding.channel" });
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
    expect(route.sessionKey).not.toBe("agent:acp-agent:matrix:channel:!dm:example.org");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("lets a global runtime binding override sender and room routes", async () => {
    const targetSessionKey = "global";
    const touch = vi.fn();
    runtimeBinding(
      (ref) =>
        ref.conversationId === "!dm:example.org"
          ? binding(targetSessionKey, ref, { boundBy: "user-1", agentId: "bound" })
          : null,
      touch,
    );
    const cfg = config(
      matrixBinding("sender-agent", senderPeer()),
      matrixBinding("room-agent", dmRoomPeer()),
    );
    const { route, configuredBinding, runtimeBindingId } = await resolveDmRoute(cfg);
    expect(configuredBinding).toBeNull();
    expect(runtimeBindingId).toBe("ops:!dm:example.org");
    expect(route).toMatchObject({
      agentId: "bound",
      matchedBy: "binding.channel",
      sessionKey: targetSessionKey,
      lastRoutePolicy: "session",
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "isolated cron run",
      targetSessionKey: "agent:bound:cron:job:run:run-1",
      metadata: undefined,
      expectedBindingId: null,
    },
    {
      name: "opaque plugin target",
      targetSessionKey: "plugin-thread-1",
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/tmp/demo-plugin",
      },
      expectedBindingId: "ops:!dm:example.org",
    },
  ])(
    "keeps the core DM route for $name",
    async ({ targetSessionKey, metadata, expectedBindingId }) => {
      runtimeBinding((conversation) => binding(targetSessionKey, conversation, metadata));
      const cfg = config(matrixBinding("sender-agent", senderPeer()));
      const { route, runtimeBindingId } = await resolveDmRoute(cfg, { dmSessionScope: "per-room" });
      expect(route.sessionKey).toBe("agent:sender-agent:matrix:channel:!dm:example.org");
      expect(route.agentId).toBe("sender-agent");
      expect(runtimeBindingId).toBe(expectedBindingId);
    },
  );
  it("resolves session keys for a thread", async () => {
    const { route } = await resolveMatrixInboundRouteAsync({
      cfg: config(matrixBinding("main")),
      accountId: "ops",
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      isDirectMessage: false,
      threadId: "$thread-root",
      resolveAgentRoute,
    });
    expect(route.sessionKey).toBe(
      "agent:main:matrix:channel:!room:example.org:thread:$thread-root",
    );
    expect(route.mainSessionKey).not.toContain(":thread:");
    expect(route.lastRoutePolicy).toBe("session");
  });
});
