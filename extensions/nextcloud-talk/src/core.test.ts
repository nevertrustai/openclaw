import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  looksLikeNextcloudTalkTargetId as looksLikeTargetId,
  normalizeNextcloudTalkMessagingTarget as normalizeTarget,
  stripNextcloudTalkTargetPrefix as stripPrefix,
} from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch as resolveAllowlistMatch } from "./policy.js";
import { resolveNextcloudTalkOutboundSessionRoute as resolveSessionRoute } from "./session-route.js";
import {
  extractNextcloudTalkHeaders as extractHeaders,
  generateNextcloudTalkSignature as generateSignature,
  verifyNextcloudTalkSignature as verifySignature,
} from "./signature.js";

describe("nextcloud talk core", () => {
  it("marks ambiguous room-token session routes as best-effort", () => {
    const route = resolveSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:nextcloud-talk:group:room-123",
      baseSessionKey: "agent:main:nextcloud-talk:group:room-123",
      recipientSessionExact: false,
      peer: {
        kind: "group",
        id: "room-123",
      },
      chatType: "group",
      from: "nextcloud-talk:room:room-123",
      to: "nextcloud-talk:room-123",
    });
  });

  it("returns null when the target cannot be normalized to a room id", () => {
    expect(
      resolveSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "",
      }),
    ).toBeNull();
  });

  it("normalizes and recognizes supported room target formats", () => {
    expect(stripPrefix(" room:abc123 ")).toBe("abc123");
    expect(stripPrefix("nextcloud-talk:room:AbC123")).toBe("AbC123");
    expect(stripPrefix("nc-talk:room:ops")).toBe("ops");
    expect(stripPrefix("nc:room:ops")).toBe("ops");
    expect(stripPrefix("NC-TALK:ROOM:Ops")).toBe("Ops");
    expect(stripPrefix("room:   ")).toBeUndefined();

    expect(normalizeTarget("room:AbC123")).toBe("nextcloud-talk:abc123");
    expect(normalizeTarget("nc-talk:room:Ops")).toBe("nextcloud-talk:ops");
    expect(normalizeTarget("NEXTCLOUD-TALK:ROOM:Ops")).toBe("nextcloud-talk:ops");

    expect(looksLikeTargetId("nextcloud-talk:room:abc12345")).toBe(true);
    expect(looksLikeTargetId("nc:opsroom1")).toBe(true);
    expect(looksLikeTargetId("room:opsroom1")).toBe(true);
    expect(looksLikeTargetId("abc12345")).toBe(true);
    expect(looksLikeTargetId("")).toBe(false);
  });

  it("verifies generated signatures and extracts normalized headers", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "secret-123";
    const generated = generateSignature({ body, secret });
    const signed = { ...generated, body, secret };

    expect(generated.random).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(signed)).toBe(true);
    expect(verifySignature({ ...signed, signature: "" })).toBe(false);
    expect(verifySignature({ ...signed, signature: "deadbeef" })).toBe(false);

    expect(
      extractHeaders({
        "x-nextcloud-talk-signature": ["sig", "ignored"],
        "x-nextcloud-talk-random": ["rand", "ignored"],
        "x-nextcloud-talk-backend": ["backend", "ignored"],
      }),
    ).toEqual({
      signature: "sig",
      random: "rand",
      backend: "backend",
    });
    expect(
      extractHeaders({
        "X-Nextcloud-Talk-Signature": "sig",
      }),
    ).toBeNull();
  });

  it("rejects tampered bodies, wrong secrets, and tampered signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "secret-123";
    const generated = generateSignature({ body, secret });
    const signed = { ...generated, body, secret };

    expect(
      verifySignature({
        ...signed,
        body: JSON.stringify({ hello: "tampered" }),
      }),
    ).toBe(false);
    expect(verifySignature({ ...signed, secret: "wrong-secret" })).toBe(false);
    expect(
      verifySignature({
        ...signed,
        signature: "a".repeat(generated.signature.length),
      }),
    ).toBe(false);
  });

  it("still runs timingSafeEqual when the supplied signature length mismatches", async () => {
    const timingSafeEqualMock =
      vi.fn<(left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => void>();

    vi.resetModules();
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return {
        ...actual,
        timingSafeEqual: vi.fn((left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
          timingSafeEqualMock(left, right);
          return actual.timingSafeEqual(left, right);
        }),
      };
    });

    try {
      const {
        generateNextcloudTalkSignature: generateNextcloudTalkSignatureLocal,
        verifyNextcloudTalkSignature: verifyNextcloudTalkSignatureLocal,
      } = await import("./signature.js");
      const body = JSON.stringify({ hello: "world" });
      const generated = generateNextcloudTalkSignatureLocal({
        body,
        secret: "secret-123",
      });
      const shortSignature = generated.signature.slice(0, 12);

      expect(
        verifyNextcloudTalkSignatureLocal({
          signature: shortSignature,
          random: generated.random,
          body,
          secret: "secret-123",
        }),
      ).toBe(false);

      expect(timingSafeEqualMock).toHaveBeenCalledOnce();
      const [leftBuffer, rightBuffer] = expectDefined(
        timingSafeEqualMock.mock.calls[0],
        "timingSafeEqual call",
      );
      expect(Buffer.isBuffer(leftBuffer)).toBe(true);
      expect(Buffer.isBuffer(rightBuffer)).toBe(true);
      if (!Buffer.isBuffer(leftBuffer) || !Buffer.isBuffer(rightBuffer)) {
        throw new TypeError("Expected timingSafeEqual to receive Buffer arguments");
      }
      expect(leftBuffer).toHaveLength(rightBuffer.length);
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });

  it("resolves allowlist matches", () => {
    const match = (allowFrom: string[], senderId = "user-id") =>
      resolveAllowlistMatch({ allowFrom, senderId });
    expect(match(["*"]).allowed).toBe(true);
    expect(match(["nc:User-Id"])).toEqual({
      allowed: true,
      matchKey: "user-id",
      matchSource: "id",
    });
    expect(match(["allowed"], "other").allowed).toBe(false);
  });
});
