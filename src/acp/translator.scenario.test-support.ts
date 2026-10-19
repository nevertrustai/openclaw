import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expect, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

type ScenarioOptions = Pick<
  NonNullable<Parameters<typeof createAcpGatewayAgent>[2]>,
  "eventLedger" | "sessionCreateRateLimit" | "provenanceMode"
> & {
  sessions?: string[];
  sessionKey?: string;
  requestPermission?: ReturnType<typeof vi.fn>;
};

export function createTranslatorScenario(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  {
    sessions = ["session-1"],
    sessionKey = "agent:main:main",
    requestPermission,
    ...options
  }: ScenarioOptions = {},
) {
  const sessionStore = createInMemorySessionStore();
  for (const sessionId of sessions) {
    sessionStore.createSession({ sessionId, sessionKey, cwd: "/tmp" });
  }
  const connection = createAcpConnection({ requestPermission });
  const sessionUpdate = vi.mocked(connection.sessionUpdate);
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    {
      ...options,
      sessionStore,
    },
  );
  return { agent, sessionStore, sessionUpdate };
}

export function expectSingleCall(
  source: { mock: { calls: unknown[][] } },
  fields: Record<string, unknown>,
) {
  expect(source.mock.calls).toMatchObject([[fields]]);
}
