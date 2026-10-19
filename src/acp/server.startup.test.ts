import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";

type GatewayClientCallbacks = {
  onEvent?: (evt: { event: string; payload?: unknown }) => void;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
};

type ResolveGatewayClientBootstrap = typeof resolveGatewayClientBootstrap;
type GatewayClientOptions = GatewayClientCallbacks & { tlsFingerprint?: string };
type MockAcpStream = {
  writable: WritableStream<unknown>;
  readable: ReadableStream<unknown>;
};

const request = (id: number, method: string, params: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const initialize = (protocolVersion: string | number) =>
  request(1, "initialize", { protocolVersion, clientCapabilities: {} });
const update = (sessionId: string, payload: unknown) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: payload },
});
const messageChunk = (sessionId: string, text: string) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const mockState = vi.hoisted(() => ({
  acpProtocolVersion: 1,
  acpInputMessages: [] as unknown[],
  rawInputChunks: [] as Uint8Array[],
  acpOutputMessages: [] as unknown[],
  acpOutputSinkError: null as Error | null,
  gateways: [] as MockGatewayClient[],
  gatewayOptions: [] as GatewayClientOptions[],
  agentSideConnectionCtor:
    vi.fn<(factory: (conn: unknown) => unknown, stream: MockAcpStream) => void>(),
  agentHandleGatewayEvent: vi.fn(async (_evt: unknown) => {}),
  agentShutdown: vi.fn(),
  routeLogsToStderr: vi.fn(),
  closeOpenClawStateDatabaseAsync: vi.fn<() => Promise<void>>(async () => {}),
  gatewayStopDeferred: null as ReturnType<typeof createDeferred<void>> | null,
  resolveGatewayClientBootstrap: vi.fn<ResolveGatewayClientBootstrap>(),
}));

vi.mock("node:stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:stream")>();
  vi.spyOn(actual.Readable, "toWeb").mockImplementation(
    () =>
      new NodeReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of mockState.rawInputChunks) {
            controller.enqueue(chunk);
          }
        },
      }),
  );
  vi.spyOn(actual.Writable, "toWeb").mockImplementation(() => new WritableStream());
  return actual;
});

class MockGatewayClient {
  constructor(private callbacks: GatewayClientOptions) {
    mockState.gatewayOptions.push(callbacks);
    mockState.gateways.push(this);
  }

  start(): void {}

  stop(): void {
    this.callbacks.onClose?.(1000, "gateway stopped");
  }

  async stopAndWait(): Promise<void> {
    if (mockState.gatewayStopDeferred) {
      await mockState.gatewayStopDeferred.promise;
    }
    this.stop();
  }

  emitHello(): void {
    this.callbacks.onHelloOk?.();
  }

  emitConnectError(message: string): void {
    this.callbacks.onConnectError?.(new Error(message));
  }
  emitEvent(event: { event: string; payload?: unknown }): void {
    this.callbacks.onEvent?.(event);
  }
}

vi.mock("@agentclientprotocol/sdk", () => ({
  AGENT_METHODS: {
    initialize: "initialize",
  },
  AgentSideConnection: function AgentSideConnection(
    factory: (conn: unknown) => unknown,
    stream: MockAcpStream,
  ) {
    const [input, monitor] = stream.readable.tee();
    const closed = new Promise<void>((resolve) => {
      // Match the SDK: both EOF and reader failure close the connection.
      void monitor.pipeTo(new WritableStream()).then(
        () => resolve(),
        () => resolve(),
      );
    });
    mockState.agentSideConnectionCtor(factory, { ...stream, readable: input });
    factory({});
    return { closed };
  },
  PROTOCOL_VERSION: mockState.acpProtocolVersion,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream({
      write(message) {
        if (mockState.acpOutputSinkError) {
          throw mockState.acpOutputSinkError;
        }
        mockState.acpOutputMessages.push(message);
      },
    }),
    readable: new ReadableStream({
      start(controller) {
        for (const message of mockState.acpInputMessages) {
          controller.enqueue(message);
        }
      },
    }),
  })),
}));

vi.mock("../config/config.js", () => {
  const loadConfig = () => ({ gateway: { mode: "local" } });
  return {
    getRuntimeConfig: loadConfig,
    loadConfig,
    resolveGatewayPort: vi.fn(() => 18_789),
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
  buildGatewayConnectionDetails: ({ url }: { url?: string }) => {
    const explicitUrl = typeof url === "string" ? url.trim() : "";
    const target = explicitUrl || "ws://127.0.0.1:18789";
    return {
      url: target,
      urlSource: explicitUrl ? "cli --url" : "local loopback",
      message: `Gateway target: ${target}`,
    };
  },
}));

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: mockState.resolveGatewayClientBootstrap,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: MockGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: MockGatewayClient) => {
    client.start();
    return {
      ready: true,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 2,
      aborted: false,
    };
  }),
}));

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: () => mockState.routeLogsToStderr(),
  };
});

vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseAsync: () => mockState.closeOpenClawStateDatabaseAsync(),
}));

vi.mock("./event-ledger.js", () => ({
  createSqliteAcpEventLedger: vi.fn(() => ({ kind: "sqlite-acp-event-ledger" })),
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: async (_config: unknown) => null,
  stopProxy: async (_handle: unknown) => {},
}));

vi.mock("./translator.js", () => ({
  AcpGatewayAgent: class {
    start(): void {}

    shutdown(): void {
      mockState.agentShutdown();
    }

    handleGatewayReconnect(): void {}

    handleGatewayDisconnect(): void {}

    async handleGatewayEvent(event: unknown): Promise<void> {
      await mockState.agentHandleGatewayEvent(event);
    }
  },
}));

describe("serveAcpGateway startup", () => {
  let serveAcpGateway: typeof import("./server.js").serveAcpGateway;
  let signalHandlers: ReturnType<typeof captureProcessSignalHandlers>["signalHandlers"];
  let onSpy: ReturnType<typeof captureProcessSignalHandlers>["onSpy"];

  function createGatewayBootstrap(
    url = "ws://127.0.0.1:18789",
  ): Awaited<ReturnType<ResolveGatewayClientBootstrap>> {
    const urlSource = "local loopback";
    return {
      url,
      urlSource,
      connectionDetails: { url, urlSource, message: `Gateway target: ${url}` },
      auth: { token: undefined, password: undefined },
    };
  }

  function getMockGateway() {
    const gateway = mockState.gateways[0];
    if (!gateway) {
      throw new Error("Expected mocked gateway instance");
    }
    return gateway;
  }

  function captureProcessSignalHandlers() {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const spy = vi.spyOn(process, "on").mockImplementation(((
      signal: NodeJS.Signals,
      handler: () => void,
    ) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    return { signalHandlers: handlers, onSpy: spy };
  }

  async function emitHelloAndWaitForAgentSideConnection() {
    await vi.waitFor(() => expect(mockState.gateways).toHaveLength(1));
    getMockGateway().emitHello();
    await vi.waitFor(() => expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1));
  }

  function getCapturedAcpStream(): MockAcpStream {
    const stream = mockState.agentSideConnectionCtor.mock.calls[0]?.[1];
    if (!stream) {
      throw new Error("Expected AgentSideConnection stream");
    }
    return stream;
  }

  async function readCapturedAcpMessages(): Promise<unknown[]> {
    const reader = getCapturedAcpStream().readable.getReader();
    const messages: unknown[] = [];
    try {
      while (messages.length < mockState.acpInputMessages.length) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        messages.push(value);
      }
      return messages;
    } finally {
      reader.releaseLock();
    }
  }

  async function stopServeWithSigint(servePromise: Promise<void>) {
    signalHandlers.get("SIGINT")?.();
    await servePromise;
  }

  async function withRunningGateway<T>(
    run: (servePromise: Promise<void>) => Promise<T>,
    opts: Parameters<typeof serveAcpGateway>[0] = {},
  ) {
    const servePromise = serveAcpGateway(opts);
    try {
      await emitHelloAndWaitForAgentSideConnection();
      return await run(servePromise);
    } finally {
      signalHandlers.get("SIGINT")?.();
      await servePromise;
    }
  }

  beforeAll(async () => {
    // Vitest workers have closed stdin; model the open ACP transport used by
    // these startup tests. Closed-stdin behavior has process-level coverage.
    Object.defineProperties(process.stdin, {
      readableEnded: { configurable: true, value: false },
      readableLength: { configurable: true, value: 1 },
    });
    ({ serveAcpGateway } = await import("./server.js"));
  });

  afterAll(() => {
    Reflect.deleteProperty(process.stdin, "readableEnded");
    Reflect.deleteProperty(process.stdin, "readableLength");
  });

  beforeEach(async () => {
    mockState.acpInputMessages.length = 0;
    mockState.rawInputChunks.length = 0;
    mockState.acpOutputMessages.length = 0;
    mockState.gateways.length = 0;
    mockState.gatewayOptions.length = 0;
    mockState.acpOutputSinkError = null;
    mockState.agentSideConnectionCtor.mockReset();
    mockState.agentHandleGatewayEvent.mockReset();
    mockState.agentShutdown.mockReset();
    mockState.routeLogsToStderr.mockReset();
    mockState.closeOpenClawStateDatabaseAsync.mockReset();
    mockState.gatewayStopDeferred = null;
    mockState.resolveGatewayClientBootstrap.mockReset();
    mockState.resolveGatewayClientBootstrap.mockResolvedValue(createGatewayBootstrap());
    ({ signalHandlers, onSpy } = captureProcessSignalHandlers());
  });
  afterEach(() => onSpy.mockRestore());

  async function captureAcpMessagesAfterStartup(inputMessages: unknown[]): Promise<unknown[]> {
    mockState.acpInputMessages.push(...inputMessages);
    return withRunningGateway(readCapturedAcpMessages);
  }

  it("waits for gateway hello before creating AgentSideConnection", async () => {
    const servePromise = serveAcpGateway({});
    await Promise.resolve();

    expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
    await emitHelloAndWaitForAgentSideConnection();
    await stopServeWithSigint(servePromise);
  });

  it("passes the resolved TLS fingerprint into the ACP gateway client", async () => {
    mockState.resolveGatewayClientBootstrap.mockResolvedValue({
      ...createGatewayBootstrap("wss://127.0.0.1:18789"),
      tlsFingerprint: "sha256:local",
    });

    await withRunningGateway(async () => {
      expect(mockState.gatewayOptions[0]?.tlsFingerprint).toBe("sha256:local");
    });
  });

  it("contains rejected gateway event handling with verbose logging", async () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    mockState.agentHandleGatewayEvent.mockRejectedValueOnce(new Error("handler boom"));

    try {
      await withRunningGateway(
        async () => {
          getMockGateway().emitEvent({ event: "chat" });
          await vi.waitFor(() =>
            expect(writes).toEqual([
              "openclaw acp: gateway event chat failed\n",
              "openclaw acp: gateway event chat error: handler boom\n",
            ]),
          );
        },
        { verbose: true },
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("routes logs to stderr before loading gateway config", async () => {
    const servePromise = serveAcpGateway({});
    await Promise.resolve();

    expect(mockState.routeLogsToStderr).toHaveBeenCalledTimes(1);
    expect(mockState.routeLogsToStderr.mock.invocationCallOrder[0]).toBeLessThan(
      mockState.resolveGatewayClientBootstrap.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );

    await emitHelloAndWaitForAgentSideConnection();
    await stopServeWithSigint(servePromise);
  });

  it("rejects startup when gateway connect fails before hello", async () => {
    const servePromise = serveAcpGateway({});
    await Promise.resolve();

    const gateway = getMockGateway();
    gateway.emitConnectError("connect failed");
    await expect(servePromise).rejects.toThrow("connect failed");
    expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
  });

  it("shuts down when buffered pre-hello ACP input exceeds its limit", async () => {
    mockState.rawInputChunks.push(new Uint8Array(1024 * 1024 + 1));

    await serveAcpGateway({});
    expect(mockState.agentSideConnectionCtor).not.toHaveBeenCalled();
    expect(mockState.closeOpenClawStateDatabaseAsync).toHaveBeenCalledOnce();
  });

  it("waits for Gateway transport teardown before closing the shared state database", async () => {
    const stop = createDeferred();
    mockState.gatewayStopDeferred = stop;

    const servePromise = serveAcpGateway({});
    await emitHelloAndWaitForAgentSideConnection();
    const input = getCapturedAcpStream().readable.getReader();
    const inputClosed = expect(input.read()).rejects.toMatchObject({ name: "AbortError" });
    signalHandlers.get("SIGTERM")?.();
    await inputClosed;
    input.releaseLock();
    await vi.waitFor(() => expect(mockState.agentShutdown).toHaveBeenCalledOnce());
    expect(mockState.closeOpenClawStateDatabaseAsync).not.toHaveBeenCalled();

    stop.resolve();
    await servePromise;
    expect(mockState.closeOpenClawStateDatabaseAsync).toHaveBeenCalledOnce();
  });

  it("closes a real node:sqlite DatabaseSync handle through serveAcpGateway shutdown", async () => {
    const actualStateDb = await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
      "../state/openclaw-state-db.js",
    );

    const realDb = actualStateDb.openOpenClawStateDatabase();
    expect(realDb.db.isOpen).toBe(true);
    expect(actualStateDb.isOpenClawStateDatabaseOpen()).toBe(true);

    mockState.closeOpenClawStateDatabaseAsync.mockImplementation(() =>
      actualStateDb.closeOpenClawStateDatabaseAsync(),
    );
    try {
      await withRunningGateway(async () => {});

      expect(realDb.db.isOpen).toBe(false);
      expect(actualStateDb.isOpenClawStateDatabaseOpen()).toBe(false);
    } finally {
      await actualStateDb.closeOpenClawStateDatabaseAsync();
    }
  });

  it.each(["2025-11-25", 1.5])("coerces initialize protocol version %s", async (version) => {
    await expect(captureAcpMessagesAfterStartup([initialize(version)])).resolves.toEqual([
      initialize(mockState.acpProtocolVersion),
    ]);
  });

  it("passes uint16 numeric initialize protocol versions through unchanged", async () => {
    const initializeRequest = initialize(42);

    const [message] = await captureAcpMessagesAfterStartup([initializeRequest]);
    expect(message).toBe(initializeRequest);
  });
  it("orders new-session updates at the ACP stdio boundary without delaying loaded sessions", async () => {
    mockState.acpInputMessages.push(
      request(3, "session/load", { sessionId: "existing-session", cwd: "/tmp/openclaw" }),
      request(2, "session/new", { cwd: "/tmp/openclaw" }),
    );
    await withRunningGateway(async () => {
      await readCapturedAcpMessages();
      const writer = getCapturedAcpStream().writable.getWriter();
      const info = { sessionUpdate: "session_info_update", title: "Proof" };
      const existingUpdate = update("existing-session", info);
      const newUpdate = update("new-session", info);
      const newResult = { jsonrpc: "2.0", id: 2, result: { sessionId: "new-session" } };

      await writer.write(existingUpdate);
      await vi.waitFor(() => expect(mockState.acpOutputMessages).toEqual([existingUpdate]));
      await writer.write(newUpdate);
      expect(mockState.acpOutputMessages).toEqual([existingUpdate]);
      await writer.write(newResult);
      await vi.waitFor(() =>
        expect(mockState.acpOutputMessages).toEqual([existingUpdate, newResult, newUpdate]),
      );
      writer.releaseLock();
    });
  });

  it("writes a session's text to the wire before the prompt response that completes it", async () => {
    mockState.acpInputMessages.push(
      request(1, "session/new", { cwd: "/tmp/openclaw" }),
      request(2, "session/new", { cwd: "/tmp/openclaw" }),
      request(3, "session/prompt", {
        sessionId: "chatty-session",
        prompt: [{ type: "text", text: "hi" }],
      }),
    );
    await withRunningGateway(async () => {
      await readCapturedAcpMessages();
      const writer = getCapturedAcpStream().writable.getWriter();
      const slowChunk = messageChunk("slow-session", "slow");
      const chattyChunk = messageChunk("chatty-session", "answer");
      const chattyCreated = { jsonrpc: "2.0", id: 2, result: { sessionId: "chatty-session" } };
      const endTurn = { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } };
      const slowCreated = { jsonrpc: "2.0", id: 1, result: { sessionId: "slow-session" } };

      // Neither session is introduced yet, so both updates are held.
      await writer.write(slowChunk);
      await writer.write(chattyChunk);
      expect(mockState.acpOutputMessages).toEqual([]);

      // The chatty session releases independently of the blocked queue head.
      await writer.write(chattyCreated);
      await writer.write(endTurn);
      await writer.write(slowCreated);

      await vi.waitFor(() => expect(mockState.acpOutputMessages).toHaveLength(5));
      expect(mockState.acpOutputMessages).toEqual([
        chattyCreated,
        chattyChunk,
        endTurn,
        slowCreated,
        slowChunk,
      ]);
      writer.releaseLock();
    });
  });

  it("tears down the agent, Gateway, and state database when the outbound sink fails", async () => {
    await withRunningGateway(async (servePromise) => {
      await readCapturedAcpMessages();
      const stopAndWait = vi.spyOn(getMockGateway(), "stopAndWait");
      expect(mockState.closeOpenClawStateDatabaseAsync).not.toHaveBeenCalled();

      // Buffered write failure surfaces through pipeTo, not writer.write.
      mockState.acpOutputSinkError = new Error("stdout sink failed");
      const writer = getCapturedAcpStream().writable.getWriter();
      await writer.write({ jsonrpc: "2.0", id: 9, result: {} }).catch(() => {});
      writer.releaseLock();

      await servePromise;

      expect(stopAndWait).toHaveBeenCalledOnce();
      expect(mockState.agentShutdown).toHaveBeenCalledOnce();
      expect(mockState.closeOpenClawStateDatabaseAsync).toHaveBeenCalledOnce();
    });
  });
});
