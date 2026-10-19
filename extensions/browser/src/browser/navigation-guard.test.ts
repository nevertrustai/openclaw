// Browser tests cover navigation guard plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SsrFBlockedError, type LookupFn } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
} from "./navigation-guard.js";

function createLookupFn(address: string): LookupFn {
  const family = address.includes(":") ? 6 : 4;
  return vi.fn(async () => [{ address, family }]) as unknown as LookupFn;
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

function strictPolicy(allowedHostnames: string[]) {
  return { dangerouslyAllowPrivateNetwork: false, allowedHostnames };
}

type Request = Parameters<typeof assertBrowserNavigationRedirectChainAllowed>[0]["request"];
function redirectChain(...urls: string[]): Request {
  return urls.reduce<Request>(
    (previous, url) => ({ url: () => url, redirectedFrom: () => previous ?? null }),
    null,
  );
}

describe("browser navigation guard", () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks private loopback URLs by default", async () => {
    await expect(
      assertBrowserNavigationAllowed({ url: "http://127.0.0.1:8080" }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows about:blank", async () => {
    await expect(assertBrowserNavigationAllowed({ url: "about:blank" })).resolves.toBeUndefined();
  });

  it.each(["file:///etc/passwd", "about:srcdoc"])(
    "blocks unsupported navigation URL %s",
    async (url) => {
      await expect(assertBrowserNavigationAllowed({ url })).rejects.toBeInstanceOf(
        InvalidBrowserNavigationUrlError,
      );
    },
  );

  it("blocks hostnames that resolve to private addresses by default", async () => {
    const lookupFn = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({ url: "https://example.com", lookupFn }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it.each([
    { name: "requested navigation", check: assertBrowserNavigationAllowed },
    { name: "final URL", check: assertBrowserNavigationResultAllowed },
    {
      name: "redirect chain",
      check: (options: Parameters<typeof assertBrowserNavigationAllowed>[0]) =>
        assertBrowserNavigationRedirectChainAllowed({
          ...options,
          request: redirectChain("https://example.com/start", options.url),
        }),
    },
  ])("cancels a stalled $name DNS check without waiting for lookup", async ({ check }) => {
    const lookup = createDeferred<Awaited<ReturnType<LookupFn>>>();
    const lookupFn = vi.fn<LookupFn>(() => lookup.promise);
    const controller = new AbortController();
    const reason = new Error("browser action deadline expired");
    const rejected = vi.fn();
    const options = {
      url: "https://example.com/final",
      lookupFn,
      signal: controller.signal,
    };
    const completion = check(options).catch((error: unknown) => {
      rejected(error);
      return error;
    });
    try {
      expect(lookupFn).toHaveBeenCalledOnce();

      controller.abort(reason);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(rejected).toHaveBeenCalledWith(reason);
      expect(await completion).toBe(reason);
    } finally {
      lookup.resolve([{ address: "93.184.216.34", family: 4 }]);
      await completion;
    }
  });

  it("allows explicitly allowed hostnames in strict mode", async () => {
    const lookupFn = createLookupFn("10.0.0.1");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://agent.internal",
        lookupFn,
        ssrfPolicy: strictPolicy(["agent.internal"]),
      }),
    ).resolves.toBeUndefined();
  });

  it("allows wildcard-allowlisted hostnames in strict mode", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://sub.example.com",
        lookupFn,
        ssrfPolicy: strictPolicy(["*.example.com"]),
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["example.com", "evil-example.com"])(
    "does not match %s against a wildcard allowlist entry",
    async (hostname) => {
      const lookupFn = createLookupFn("93.184.216.34");
      await expect(
        assertBrowserNavigationAllowed({
          url: `https://${hostname}`,
          lookupFn,
          ssrfPolicy: strictPolicy(["*.example.com"]),
        }),
      ).rejects.toThrow(/dns rebinding protections are unavailable/i);
      expect(lookupFn).not.toHaveBeenCalled();
    },
  );

  it("allows public navigation when only Gateway env proxy is configured", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({ url: "https://example.com", lookupFn }),
    ).resolves.toBeUndefined();
    expect(lookupFn).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("blocks explicit browser proxy routing in strict SSRF mode", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        browserProxyMode: "explicit-browser-proxy",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("allows explicit browser proxy routing when private-network mode is enabled", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationAllowed({
        url: "https://example.com",
        lookupFn,
        browserProxyMode: "explicit-browser-proxy",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(assertBrowserNavigationAllowed({ url: "not a url" })).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
  });

  it("blocks network URLs with embedded credentials before lookup", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    const result = assertBrowserNavigationAllowed({
      url: "https://user:secret@example.com/private",
      lookupFn,
    });
    await expect(result).rejects.toThrow("URL-embedded credentials are not supported");
    await expect(result).rejects.toThrow("openclaw browser set credentials");
    await expect(result).rejects.not.toThrow("secret");
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it("redacts malformed credential-bearing URLs from diagnostics", async () => {
    const result = assertBrowserNavigationAllowed({ url: "https://user:secret@" });
    await expect(result).rejects.toThrow("Invalid URL: [redacted credential-bearing URL]");
    await expect(result).rejects.not.toThrow("secret");
  });

  it("ignores non-network browser-internal final URLs", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({ url: "chrome-error://chromewebdata/" }),
    ).resolves.toBeUndefined();
  });

  it("blocks final hostname URLs in strict mode after navigation", async () => {
    await expect(
      assertBrowserNavigationResultAllowed({
        url: "https://example.com/final",
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: false },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
  });

  it("blocks private intermediate redirect hops", async () => {
    const publicLookup = createLookupFn("93.184.216.34");
    const privateLookup = createLookupFn("127.0.0.1");
    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: redirectChain(
          "https://public.example/start",
          "http://private.example/internal",
          "https://public.example/final",
        ),
        lookupFn: vi.fn(async (hostname: string) =>
          hostname === "private.example"
            ? privateLookup(hostname, { all: true })
            : publicLookup(hostname, { all: true }),
        ) as unknown as LookupFn,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows redirect chains when every hop is public", async () => {
    const lookupFn = createLookupFn("93.184.216.34");
    await expect(
      assertBrowserNavigationRedirectChainAllowed({
        request: redirectChain(
          "https://public.example/start",
          "https://public.example/middle",
          "https://public.example/final",
        ),
        lookupFn,
      }),
    ).resolves.toBeUndefined();
  });
});
