import http from "node:http";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";
import { createNextcloudTalkWebhookSpool } from "./webhook-spool.js";

type NextcloudTalkIngressQueue = NonNullable<
  Parameters<typeof createNextcloudTalkWebhookSpool>[0]["queue"]
>;
type NextcloudTalkIngressPayload = Parameters<NextcloudTalkIngressQueue["enqueue"]>[1];

type ProofServer = Awaited<ReturnType<typeof startRoomInfoServer>>;
const servers: ProofServer[] = [];

async function startRoomInfoServer() {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (requests.length === 1) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("temporary outage");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ocs: { data: { type: 1 } } }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback listener address");
  }
  const proofServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
  servers.push(proofServer);
  return proofServer;
}

function createRuntime() {
  const dispatches = { count: 0 };
  const logs: string[] = [];
  setNextcloudTalkRuntime({
    channel: {
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: (payload: unknown) => payload,
        dispatch: async () => {
          dispatches.count += 1;
        },
      },
      pairing: {
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({ code: "123456", created: true }),
      },
      commands: { shouldHandleTextCommands: () => false },
      text: { hasControlCommand: () => false },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
    },
  } as never);
  const runtime: RuntimeEnv = {
    error: (messageValue: unknown) => logs.push(String(messageValue)),
    exit: () => {},
    log: (messageValue: unknown) => logs.push(String(messageValue)),
  };
  return { dispatches, logs, runtime };
}

function createAccount(baseUrl: string, allowPrivateNetwork = true): ResolvedNextcloudTalkAccount {
  return {
    accountId: "proof",
    enabled: true,
    baseUrl,
    secret: "bot-secret",
    secretSource: "config",
    config: {
      apiUser: "bot",
      apiPassword: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      network: { dangerouslyAllowPrivateNetwork: allowPrivateNetwork },
    },
  };
}

function createRawWebhookEvent(params?: { roomToken?: string }): string {
  return JSON.stringify({
    type: "Create",
    actor: { type: "Person", id: "user-1", name: "Alice" },
    object: {
      type: "Note",
      id: "msg-proof",
      name: "hello",
      content: "hello",
      mediaType: "text/plain",
    },
    target: { type: "Collection", id: params?.roomToken ?? "room-direct", name: "Direct room" },
  });
}

async function withSpool(
  params: {
    serverBaseUrl: string;
    allowPrivateNetwork?: boolean;
    config?: CoreConfig;
  },
  run: (
    fixture: ReturnType<typeof createRuntime> & {
      queue: NextcloudTalkIngressQueue;
      spool: ReturnType<typeof createNextcloudTalkWebhookSpool>;
    },
  ) => Promise<void>,
) {
  const fixture = createRuntime();
  await withTempDir("openclaw-nextcloud-talk-room-info-", async (stateDir) => {
    const queue = createChannelIngressQueueForTests<NextcloudTalkIngressPayload>({
      channelId: "nextcloud-talk",
      accountId: "proof",
      stateDir,
      now: () => Date.now(),
    });
    const spool = createNextcloudTalkWebhookSpool({
      accountId: "proof",
      queue,
      runtime: fixture.runtime,
      deliver: async (message, lifecycle) =>
        handleNextcloudTalkInbound({
          message,
          account: createAccount(params.serverBaseUrl, params.allowPrivateNetwork ?? true),
          config: params.config ?? { channels: { "nextcloud-talk": {} } },
          runtime: fixture.runtime,
          turnAdoptionLifecycle: lifecycle,
        }),
      pollIntervalMs: 10,
      adoptionStallTimeoutMs: 5_000,
      legacyReplayStore: null,
    });
    try {
      await run({ ...fixture, queue, spool });
    } finally {
      await spool.stop();
    }
  });
  return fixture;
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.stop()));
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("nextcloud-talk inbound room-kind lookup retry", () => {
  it("retries a failed room lookup in the same running spool and dispatches once", async () => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // Advance the spool poll independently of the durable retry clock; HTTP stays real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const server = await startRoomInfoServer();
    const { logs } = await withSpool(
      { serverBaseUrl: server.baseUrl },
      async ({ queue, spool, dispatches }) => {
        const completed = observeChannelIngressQueueWrite(queue, "complete", "msg-proof");
        await spool.receive(createRawWebhookEvent({ roomToken: "room-durable-direct" }));
        await spool.waitForIdle();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "msg-proof",
            attempts: 1,
            lastAttemptAt: clock,
            lastError: "Nextcloud Talk room lookup failed (503)",
          }),
        ]);
        expect(server.requests).toHaveLength(1);
        expect(dispatches.count).toBe(0);
        expect(await queue.listClaims()).toEqual([]);

        clock += 999;
        await vi.advanceTimersByTimeAsync(10);
        await spool.waitForIdle();
        expect(server.requests).toHaveLength(1);
        expect(dispatches.count).toBe(0);

        clock += 1;
        await vi.advanceTimersByTimeAsync(10);
        await expect(completed).resolves.toBe(true);
        await spool.waitForIdle();

        expect(dispatches.count).toBe(1);
        expect(server.requests).toHaveLength(2);
        expect(await queue.listClaims()).toEqual([]);
      },
    );

    expect(logs).toContain(
      "nextcloud-talk spooled update msg-proof failed; keeping for retry: Nextcloud Talk room lookup failed (503)",
    );
  });

  it("keeps guarded-fetch policy blocks on the fallback path instead of durable retry", async () => {
    const server = await startRoomInfoServer();
    await withSpool(
      { serverBaseUrl: server.baseUrl, allowPrivateNetwork: false },
      async ({ queue, spool, dispatches }) => {
        await spool.receive(createRawWebhookEvent({ roomToken: "room-policy-blocked" }));
        await spool.waitForIdle();

        expect(server.requests).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        expect(dispatches.count).toBe(0);
      },
    );
  });

  it("keeps invalid room lookup URLs on the fallback path instead of durable retry", async () => {
    const server = await startRoomInfoServer();
    await withSpool(
      {
        serverBaseUrl: "not-a-url",
        config: {
          channels: {
            "nextcloud-talk": { rooms: { "room-invalid-url": { requireMention: false } } },
          },
        } as CoreConfig,
      },
      async ({ queue, spool, dispatches }) => {
        await spool.receive(createRawWebhookEvent({ roomToken: "room-invalid-url" }));
        await spool.waitForIdle();

        expect(dispatches.count).toBe(1);
        expect(server.requests).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
      },
    );
  });
});
