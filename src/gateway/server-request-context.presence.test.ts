import { expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { listSystemPresence } from "../infra/system-presence.js";
import {
  getUserProfileDisplay,
  prepareUserProfileCatalog,
  readResidentUserProfileId,
} from "../state/user-profile-list.js";
import { linkCanonicalUserProfileEmail } from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { sessionSuggestionHandlers } from "./server-methods/sessions-suggestions.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams, makeGatewayClient } from "./server-request-context.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { getHealthVersion, incrementPresenceVersion } from "./server/health-state.js";
import { createPresencePublisher } from "./server/presence-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";

vi.mock("./server/health-state.js", () => ({
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 1),
}));

function makePresenceContext(clients: GatewayClientRegistry) {
  const presenceClock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(presenceClock.clock);
  const params = makeContextParams({ clients });
  const publisher = createPresencePublisher({
    scheduler,
    broadcast: params.runtime.broadcast,
    incrementPresenceVersion,
    getHealthVersion,
    prepare: () => undefined,
  });
  params.runtime.publishPresence = publisher.publish;
  onTestFinished(async () => {
    publisher.stop();
    await scheduler.stop();
  });
  return {
    context: createGatewayRequestContext(params),
    broadcast: params.runtime.broadcast,
    advance: () => presenceClock.advanceBy(200),
  };
}

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;
const delivery = { dropIfSlow: true, stateVersion: { presence: 1, health: 1 } };
const profileDisplay = (profile: ReturnType<typeof ensureProfileForEmail>) => ({
  profileId: profile.id,
  displayName: profile.displayName,
  avatarRevision: String(profile.updatedAt),
  hasAvatar: false,
  updatedAt: profile.updatedAt,
});

function makeProfileClient(
  connId: string,
  email: string | undefined,
  profile: Partial<NonNullable<GatewayWsClient["authenticatedUserProfile"]>> = {},
  connection: Partial<
    Omit<GatewayWsClient, "authenticatedUserProfile" | "authenticatedUserId">
  > = {},
) {
  return {
    ...makeGatewayClient({ connId, clientId: GATEWAY_CLIENT_IDS.CONTROL_UI }),
    authenticatedUserId: email,
    authenticatedUserProfile: {
      profileId: "profile-ada",
      displayName: "Ada",
      avatarRevision: "avatar-old-png",
      hasAvatar: true,
      updatedAt: 1,
      ...profile,
    },
    presenceKey: `profile-refresh-${connId}`,
    ...connection,
  };
}

it.each(["email", "owner", "tailscale"] as const)(
  "refreshes every live profile connection with %s identity",
  async (identity) => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    onTestFinished(() => clock.mockRestore());
    const profileId = `profile-${identity}`;
    const emails = {
      email: ["ada@example.test", "ada@work.test"],
      owner: [undefined, undefined],
      tailscale: ["ada@github"],
    }[identity];
    const clients = emails.map((email, index) => ({
      ...makeProfileClient(`${identity}-${index}`, email, { profileId }),
      ...(identity === "owner" ? { personPresence: { onlineSince: 1_000 } } : {}),
      ...(identity === "tailscale" ? { authenticatedUserIsTailscaleProvider: true } : {}),
    }));
    const unrelated = makeProfileClient("grace", "grace@example.test", {
      profileId: "profile-grace",
      displayName: "Grace",
    });
    const { context, broadcast, advance } = makePresenceContext(
      new Set([...clients, unrelated]) as never,
    );
    const first = clients[0]!;
    const capturedProfile = first.authenticatedUserProfile;
    const revisions = {
      email: ["avatar-new-png", "avatar-newer-png"],
      owner: ["2"],
      tailscale: ["avatar-tailscale-new-png"],
    }[identity];
    const expectedUser = (email: string | undefined, avatarRevision: string) => ({
      id: profileId,
      identity: { type: "profile", id: profileId },
      ...(identity === "email" ? { email } : {}),
      name: "Augusta Ada",
      avatarUrl: `/api/users/${profileId}/avatar?v=${avatarRevision}`,
    });
    for (const [index, avatarRevision] of revisions.entries()) {
      context.refreshConnectedUserProfile?.({
        id: profileId,
        displayName: "Augusta Ada",
        avatarRevision,
        hasAvatar: identity !== "owner" && index === 0,
        updatedAt: 2,
      });
      await advance();
      expect(broadcast).toHaveBeenNthCalledWith(
        index + 1,
        "presence",
        {
          presence: expect.arrayContaining(
            emails.map((email) =>
              expect.objectContaining({ user: expectedUser(email, avatarRevision) }),
            ),
          ),
        },
        delivery,
      );
    }
    expect(broadcast).toHaveBeenCalledTimes(revisions.length);
    expect(first.authenticatedUserProfile).toBe(capturedProfile);
    expect(capturedProfile.displayName).toBe("Augusta Ada");
    for (const client of clients) {
      expect(client.authenticatedUserProfile).toEqual({
        profileId,
        displayName: "Augusta Ada",
        avatarRevision: revisions.at(-1),
        hasAvatar: identity === "tailscale",
        updatedAt: 2,
      });
    }
    expect(unrelated.authenticatedUserProfile.displayName).toBe("Grace");
    const rows = listSystemPresence().filter((entry) => entry.user?.id === profileId);
    expect(rows).toHaveLength(clients.length);
    expect(rows.map((row) => row.user)).toEqual(
      emails.toReversed().map((email) => expectedUser(email, revisions.at(-1)!)),
    );
    if (identity === "email") {
      expect(rows[0]!.ts).toBeGreaterThan(rows[1]!.ts);
    }
    if (identity === "owner") {
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        "presence",
        { presence: expect.arrayContaining(rows) },
        delivery,
      );
    }
  },
);

it("canonicalizes a connected profile after its durable identity is merged", async () => {
  await withOpenClawTestState(profileState, async () => {
    const source = ensureProfileForEmail("merge-source@example.test");
    const target = ensureProfileForEmail("merge-target@example.test");
    const unrelatedProfile = ensureProfileForEmail("merge-unrelated@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const sourceClient = makeProfileClient(
      "merge-source",
      "merge-source@example.test",
      profileDisplay(source),
      { personPresence: { onlineSince: 1_000, lastActivityAt: 2_000 } },
    );
    const targetClient = makeProfileClient(
      "merge-target",
      "merge-target@example.test",
      { ...sourceClient.authenticatedUserProfile, profileId: target.id },
      { personPresence: { onlineSince: 1_500, lastActivityAt: 3_000 } },
    );
    const unrelatedClient = makeProfileClient(
      "merge-unrelated",
      "merge-unrelated@example.test",
      profileDisplay(unrelatedProfile),
    );
    const capturedProfile = sourceClient.authenticatedUserProfile;
    const { context, broadcast, advance } = makePresenceContext(
      new Set([sourceClient, targetClient, unrelatedClient]) as never,
    );

    const { profile: linked } = await linkCanonicalUserProfileEmail(
      "merge-source@example.test",
      target.id,
    );
    expect(readResidentUserProfileId(source.id)).toBe(target.id);
    const display = getUserProfileDisplay(linked.id);
    context.refreshConnectedUserProfile?.({ ...display, updatedAt: linked.updatedAt });
    await advance();

    expect(sourceClient.authenticatedUserProfile).toBe(capturedProfile);
    expect(sourceClient.authenticatedUserProfile).toEqual({
      profileId: target.id,
      displayName: target.displayName,
      avatarRevision: display.avatarRevision,
      hasAvatar: false,
      updatedAt: linked.updatedAt,
    });
    expect(unrelatedClient.authenticatedUserProfile.profileId).toBe(unrelatedProfile.id);
    for (const email of ["merge-source@example.test", "merge-target@example.test"]) {
      expect(listSystemPresence().find((entry) => entry.user?.email === email)).toMatchObject({
        user: { id: target.id, identity: { type: "profile", id: target.id } },
        onlineSince: 1_000,
        lastActivityAt: 3_000,
      });
    }
    const presence = vi.mocked(broadcast).mock.calls[0]?.[1] as {
      presence?: Array<{ user?: { id?: string; email?: string; avatarUrl?: string } }>;
    };
    const published = presence.presence ?? [];
    expect(
      published.find((entry) => entry.user?.email === "merge-source@example.test")?.user,
    ).toEqual({
      id: target.id,
      identity: { type: "profile", id: target.id },
      email: "merge-source@example.test",
      name: target.displayName,
      avatarUrl: `/api/users/${target.id}/avatar?v=${display.avatarRevision}`,
    });
    expect(published.some((entry) => entry.user?.id === unrelatedProfile.id)).toBe(false);
  });
});

it("coalesces typing activity across a person's tabs and publishes explicit changes after the coalescing window", async () => {
  await withOpenClawTestState(profileState, async () => {
    await captureRuntimeConfigAsyncReader()();
    const started = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const increment = vi.mocked(incrementPresenceVersion);
    const health = vi.mocked(getHealthVersion);
    const previousIncrement = increment.getMockImplementation()!;
    const previousHealth = health.getMockImplementation()!;
    let presenceVersion = 0;
    increment.mockImplementation(() => ++presenceVersion);
    health.mockReturnValue(11);
    onTestFinished(() => {
      clock.mockRestore();
      increment.mockImplementation(previousIncrement);
      health.mockImplementation(previousHealth);
    });
    const profile = ensureProfileForEmail("typing-presence@example.test");
    const sessionKey = "agent:main:typing-presence-coalescing";
    const sessionId = "typing-presence-coalescing";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId,
        updatedAt: started,
        createdActor: { type: "human", source: "profile", id: profile.id },
        visibility: "shared",
      },
    );
    const typingProfile = {
      profileId: profile.id,
      displayName: "Typing Person",
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: started,
    };
    const tabs = ["first", "second"].map((tab, index): GatewayWsClient =>
      Object.assign(
        makeProfileClient(`typing-presence-${tab}`, "typing-presence@example.test", typingProfile, {
          connect: makeGatewayClient({
            connId: tab,
            clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            scopes: ["operator.read", "operator.write"],
          }).connect,
          usesSharedGatewayAuth: false,
          presenceKey: `typing-presence-${tab}`,
          personPresence: { onlineSince: started - 2_000 + index * 1_000 },
        }),
        { socket: { readyState: 1 } as GatewayWsClient["socket"] },
      ),
    );
    const { context, broadcast, advance } = makePresenceContext(new GatewayClientRegistry(tabs));
    await initializeSessionReadContext(context);
    const events = () => vi.mocked(broadcast).mock.calls.filter(([event]) => event === "presence");
    const rows = () =>
      listSystemPresence().filter((entry) => entry.user?.identity?.id === profile.id);
    const renameAt = async (offset: number, displayName: string, count: number) => {
      clock.mockReturnValue(started + offset);
      context.refreshConnectedUserProfile?.({
        ...typingProfile,
        id: profile.id,
        displayName,
        updatedAt: started + offset,
      });
      await advance();
      expect(events()).toHaveLength(count);
    };
    const typeAt = async (offset: number, tab = tabs[0]!, count?: number) => {
      clock.mockReturnValue(started + offset);
      const requestParams = { sessionKey, sessionId, typing: true };
      const respond = vi.fn();
      await sessionSuggestionHandlers["session.typing"]!({
        req: {
          type: "req",
          id: `typing-${offset}`,
          method: "session.typing",
          params: requestParams,
        },
        params: requestParams,
        client: tab,
        context,
        isWebchatConnect: () => true,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true, broadcast: false });
      await advance();
      if (count !== undefined) {
        expect(events()).toHaveLength(count);
      }
    };

    for (let second = 0; second < 30; second++) {
      await typeAt(second * 1_000, tabs[second % tabs.length]!);
    }
    expect(events()).toHaveLength(1);
    expect(rows()).toHaveLength(2);
    for (const row of rows()) {
      expect(row).toMatchObject({
        onlineSince: started - 2_000,
        lastActivityAt: started + 29_000,
      });
    }
    await typeAt(30_000, tabs[0], 2);

    await renameAt(31_000, "Renamed Person", 3);
    expect(rows().every((row) => row.user?.name === "Renamed Person")).toBe(true);
    health.mockReturnValue(12);
    context.publishPresence();
    await advance();
    expect(events()).toHaveLength(4);
    await typeAt(32_000, tabs[1], 4);

    await renameAt(179_000, "Renamed Again", 5);
    await typeAt(180_000, tabs[1], 6);
    expect(events().map((call) => call[2]?.stateVersion)).toEqual(
      [11, 11, 11, 12, 12, 12].map((healthVersion, index) => ({
        presence: index + 1,
        health: healthVersion,
      })),
    );
    expect(presenceVersion).toBe(6);
    expect(events().at(-1)?.[1]).toMatchObject({
      presence: expect.arrayContaining([
        expect.objectContaining({
          onlineSince: started - 2_000,
          lastActivityAt: started + 180_000,
        }),
      ]),
    });
  });
});

it.each(["invalidated", "closing"] as const)(
  "does not refresh a %s profile connection or resurrect its presence",
  async (state) => {
    const client: GatewayWsClient = {
      ...makeProfileClient(`profile-${state}`, `${state}@profile.test`, {
        profileId: `inactive-${state}`,
        displayName: "Before",
      }),
      socket: { readyState: state === "closing" ? 2 : 1 } as GatewayWsClient["socket"],
      usesSharedGatewayAuth: false,
      invalidated: state === "invalidated",
    };
    const { context, broadcast, advance } = makePresenceContext(
      new GatewayClientRegistry([client]),
    );
    context.refreshConnectedUserProfile?.({
      id: `inactive-${state}`,
      displayName: "After",
      avatarRevision: "2",
      hasAvatar: false,
      updatedAt: 2,
    });
    await advance();
    expect(client.authenticatedUserProfile?.displayName).toBe("Before");
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      listSystemPresence().some((entry) => entry.user?.email === `${state}@profile.test`),
    ).toBe(false);
  },
);
