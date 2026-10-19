// Doctor web fetch proxy tests cover explicit opt-in diagnostics without exposing proxy values.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { noteWebFetchProxyDiagnostic } from "./doctor-web-fetch-proxy.js";

vi.mock("../infra/net/runtime-fetch.js", () => ({ fetchWithRuntimeDispatcher: vi.fn() }));

afterEach(() => {
  vi.mocked(fetchWithRuntimeDispatcher).mockReset();
});

function serviceWithEnv(environment?: Record<string, string>) {
  return {
    readCommand: vi.fn(async () =>
      environment ? { programArguments: ["openclaw", "gateway"], environment } : null,
    ),
  };
}

type DiagnosticOptions = Parameters<typeof noteWebFetchProxyDiagnostic>[0];
const webFetchDisabled = { web: { fetch: { enabled: false } } };
async function diagnose(params: DiagnosticOptions) {
  const noteFn = vi.fn();
  await noteWebFetchProxyDiagnostic({ ...params, noteFn });
  return noteFn;
}
async function collectDiagnostic(params: DiagnosticOptions) {
  const noteFn = await diagnose(params);
  expect(noteFn.mock.calls.length).toBeLessThanOrEqual(1);
  return noteFn.mock.calls[0]?.[0] ?? null;
}
function expectContains(message: unknown, ...parts: string[]) {
  for (const part of parts) {
    expect(message).toContain(part);
  }
}

describe("web_fetch proxy doctor diagnostic", () => {
  const proxyUrl = "http://private-proxy.example:8080/proxy-value-marker";
  type ProxyCase = [
    string,
    NodeJS.ProcessEnv,
    Record<string, string> | undefined,
    "reachable" | "unreachable",
    string[],
  ];
  it.each<ProxyCase>([
    [
      "service",
      {},
      { HTTPS_PROXY: proxyUrl },
      "unreachable",
      ["installed Gateway service: HTTPS_PROXY"],
    ],
    ["process", { http_proxy: proxyUrl }, undefined, "reachable", ["doctor process: http_proxy"]],
    [
      "Kubernetes",
      {
        HTTPS_PROXY: proxyUrl,
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        KUBERNETES_SERVICE_PORT: "443",
      },
      { HTTPS_PROXY: proxyUrl },
      "reachable",
      ["doctor process: HTTPS_PROXY"],
    ],
    [
      "both",
      { HTTP_PROXY: proxyUrl },
      { HTTPS_PROXY: proxyUrl },
      "reachable",
      ["doctor process: HTTP_PROXY", "installed Gateway service: HTTPS_PROXY"],
    ],
  ])(
    "reports %s proxy routing without exposing values",
    async (source, env, serviceEnv, connectivity, sources) => {
      const service = serviceWithEnv(serviceEnv);
      const noteFn = await diagnose({
        cfg: {},
        env,
        service,
        probeDirectConnectivity: vi.fn(async () => connectivity),
      });
      expect(noteFn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("web_fetch"),
        "Web fetch proxy",
      );
      const diagnostic = noteFn.mock.calls[0]?.[0];
      for (const expected of sources) {
        expect(diagnostic).toContain(`HTTP(S) proxy environment detected in the ${expected}`);
      }
      expectContains(
        diagnostic,
        "web_fetch still uses direct connections",
        "tools.web.fetch.useTrustedEnvProxy is not enabled",
        `Direct TLS connectivity to docs.openclaw.ai:443 ${connectivity === "reachable" ? "succeeded" : "failed"}`,
        "openclaw config set tools.web.fetch.useTrustedEnvProxy true",
      );
      expect(diagnostic).not.toContain(proxyUrl);
      expect(diagnostic).not.toContain("proxy-value-marker");
      if (source === "Kubernetes") {
        expect(diagnostic).not.toContain("installed Gateway service");
        expect(service.readCommand).not.toHaveBeenCalled();
      }
    },
  );

  it.each<[string, OpenClawConfig, boolean]>([
    ["no HTTP(S) proxy is effective", {}, false],
    [
      "trusted proxy opt-in is enabled",
      { tools: { web: { fetch: { useTrustedEnvProxy: true } } } },
      true,
    ],
    ["web_fetch is disabled", { tools: webFetchDisabled }, true],
    ["Gateway mode is remote", { gateway: { mode: "remote" } }, true],
  ])("does nothing when %s", async (_name, cfg, proxy) => {
    const service = serviceWithEnv(proxy ? { HTTPS_PROXY: proxyUrl } : undefined);
    const probe = vi.fn(async () => "unreachable" as const);
    await expect(
      collectDiagnostic({
        cfg,
        env: proxy ? {} : { ALL_PROXY: "socks5://proxy.example:1080" },
        service,
        probeDirectConnectivity: probe,
      }),
    ).resolves.toBeNull();
    if (proxy) {
      expect(service.readCommand).not.toHaveBeenCalled();
    }
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("managed proxy loopback doctor diagnostic", () => {
  const proxyUrl = "http://proxy.example.test:8080";

  it.each([
    { name: "a proxy HTTP error", response: new Response("private-value", { status: 502 }) },
    { name: "a response from another listener", response: new Response(null, { status: 204 }) },
    { name: "a transport error", response: undefined },
  ])("reports $name with actionable recovery before web_fetch gating", async ({ response }) => {
    if (response) {
      vi.mocked(fetchWithRuntimeDispatcher).mockResolvedValue(response);
    } else {
      vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(new Error(proxyUrl));
    }
    const noteFn = await diagnose({
      cfg: { tools: webFetchDisabled },
      env: { OPENCLAW_PROXY_URL: proxyUrl },
    });

    expect(noteFn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("proxy.enabled"),
      "Managed proxy loopback",
    );
    const message = String(noteFn.mock.calls[0]?.[0]);
    expectContains(
      message,
      "openclaw config get proxy",
      "openclaw config set proxy.enabled false",
      "openclaw gateway restart",
    );
    expect(message).not.toContain("private-value");
    expect(message).not.toContain("proxy.example");
  });

  it("stays silent when the runtime reaches its own loopback listener", async () => {
    vi.mocked(fetchWithRuntimeDispatcher).mockImplementation((input, init) => fetch(input, init));
    const noteFn = await diagnose({
      cfg: { proxy: { enabled: true, proxyUrl }, tools: webFetchDisabled },
      env: {},
    });

    expect(fetchWithRuntimeDispatcher).toHaveBeenCalledOnce();
    expect(noteFn).not.toHaveBeenCalled();
  });

  it.each(["proxy", "block"] as const)(
    "explains how to restore local routing with explicit %s mode",
    async (loopbackMode) => {
      vi.mocked(fetchWithRuntimeDispatcher).mockRejectedValue(new Error("connect failed"));
      const diagnostic = await collectDiagnostic({
        cfg: { proxy: { proxyUrl, loopbackMode }, tools: webFetchDisabled },
        env: {},
      });

      expect(diagnostic).toContain(`proxy.loopbackMode=${loopbackMode}`);
      expect(diagnostic).toContain("openclaw config set proxy.loopbackMode gateway-only");
      expect(diagnostic).not.toContain("openclaw config set proxy.enabled false");
    },
  );

  it.each([
    { proxy: { enabled: false, proxyUrl } },
    { proxy: { proxyUrl }, gateway: { mode: "remote" as const } },
  ])("does not probe disabled managed routing or a remote Gateway", async (cfg) => {
    const diagnostic = await collectDiagnostic({
      cfg: { ...cfg, tools: webFetchDisabled },
      env: { OPENCLAW_PROXY_URL: proxyUrl },
    });

    expect(fetchWithRuntimeDispatcher).not.toHaveBeenCalled();
    expect(diagnostic).toBeNull();
  });
});
