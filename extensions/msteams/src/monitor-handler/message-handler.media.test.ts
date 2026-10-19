import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../../runtime-api.js";
import type {
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
} from "../attachments.js";
import { resolveMSTeamsRequestTimeoutMs } from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";

const { media, graphMedia, botFrameworkMedia } = vi.hoisted(() => ({
  media: vi.fn<typeof downloadMSTeamsAttachments>(),
  graphMedia: vi.fn<typeof downloadMSTeamsGraphMedia>(),
  botFrameworkMedia: vi.fn<typeof downloadMSTeamsBotFrameworkAttachments>(),
}));
vi.mock("../attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../attachments.js")>()),
  downloadMSTeamsAttachments: media,
  downloadMSTeamsGraphMedia: graphMedia,
  downloadMSTeamsBotFrameworkAttachments: botFrameworkMedia,
}));
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  createMessageHandlerDeps,
  createTurnContext,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const html = (content: string) => [{ contentType: "text/html", content }];
const dmConfig: MSTeamsConfig = { dmPolicy: "open", allowFrom: ["*"] };
const dmConversation = { id: "a:bot-framework-dm", conversationType: "personal" };
const document = (path: string) => ({
  path,
  contentType: "application/pdf",
  kind: "document" as const,
});
const teamData = (id: string) => ({ team: { id }, channel: { id: "19:channel@thread.tacv2" } });
function setup(
  config: MSTeamsConfig = {},
  getTeamDetails: NonNullable<MSTeamsTurnContext["getTeamDetails"]> = vi.fn<
    NonNullable<MSTeamsTurnContext["getTeamDetails"]>
  >(async () => ({ aadGroupId: "team-aad-group" })),
) {
  const msteams: MSTeamsConfig = {
    groupPolicy: "open",
    requireMention: false,
    graphMediaFallback: true,
    ...config,
  };
  const fixture = createMessageHandlerDeps({ channels: { msteams } });
  const handler = createMSTeamsMessageHandler(fixture.deps);
  return {
    ...fixture,
    getTeamDetails,
    handle: (overrides: Partial<MSTeamsTurnContext["activity"]> = {}) =>
      handler({
        ...createTurnContext(
          buildChannelActivity({
            text: "<at>Bot</at>",
            attachments: html("<div><at>Bot</at></div>"),
            channelData: {
              team: { id: "19:team@thread.skype", aadGroupId: "team-aad" },
              channel: { id: "19:channel@thread.tacv2" },
            },
            ...overrides,
          }),
        ),
        getTeamDetails,
      }),
  };
}
function context() {
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0]![0].ctx;
}

describe("Teams inbound media recovery", () => {
  beforeEach(() => {
    media.mockReset().mockResolvedValue([]);
    graphMedia.mockReset().mockResolvedValue({ media: [] });
    botFrameworkMedia.mockReset().mockResolvedValue({ media: [] });
    dispatch.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("dispatches recovered tagless files without logging instruction text", async () => {
    graphMedia.mockResolvedValue({ media: [document("/tmp/from-graph.pdf")] });
    const { handle, getTeamDetails, deps } = setup();
    const privateText = "Private launch note: describe the attached image file";
    vi.spyOn(getMSTeamsRuntime().logging, "shouldLogVerbose").mockReturnValue(true);
    await handle({
      text: `<at>Bot</at> ${privateText}`,
      channelData: teamData("19:raw-team@thread.skype"),
    });
    expect(graphMedia).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messageUrl:
          "https://graph.microsoft.com/v1.0/teams/team-aad-group/channels/19%3Achannel%40thread.tacv2/messages/msg-1",
      }),
    );
    expect(getTeamDetails).toHaveBeenCalledExactlyOnceWith("19:raw-team@thread.skype");
    expect(context()).toMatchObject({
      BodyForAgent: privateText,
      NativeChannelId: "team-aad-group/19:channel@thread.tacv2",
      media: [expect.objectContaining(document("/tmp/from-graph.pdf"))],
    });
    expect(JSON.stringify(context())).not.toContain("19:raw-team@thread.skype/");
    const logs = JSON.stringify([
      vi.mocked(deps.log.info).mock.calls,
      vi.mocked(deps.log.debug!).mock.calls,
      vi.mocked(deps.log.error).mock.calls,
      vi.mocked(deps.runtime.error).mock.calls,
    ]);
    expect(logs).not.toContain("Private launch note");
  });
  it("recovers explicit personal attachments without opting into Graph fallback or rewriting the Bot Framework ID", async () => {
    botFrameworkMedia.mockResolvedValue({ media: [document("/tmp/explicit.pdf")] });
    const { handle } = setup({ ...dmConfig, graphMediaFallback: undefined, replyStyle: "thread" });
    await handle({
      conversation: dmConversation,
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      channelData: {},
      replyToId: "dm-parent",
      attachments: html('<div><attachment id="attachment-1"></attachment></div>'),
      entities: [],
    });
    expect(botFrameworkMedia).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        attachmentIds: ["attachment-1"],
      }),
    );
    expect(graphMedia).not.toHaveBeenCalled();
    expect(context()).toMatchObject({
      BodyForAgent: "",
      To: "user:user-aad",
      OriginatingTo: "conversation:a:bot-framework-dm",
      media: [expect.objectContaining(document("/tmp/explicit.pdf"))],
    });
    expect(context().MessageThreadId).toBeUndefined();
  });
  it("does not emit a ghost event when Graph recovery is empty", async () => {
    const { handle, getTeamDetails, enqueueSystemEvent } = setup();
    await handle();
    expect(media).toHaveBeenCalledTimes(1);
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
  it("reports a Graph-discovered unavailable attachment", async () => {
    graphMedia.mockResolvedValue({ media: [{ kind: "document" }] });
    await setup().handle();
    expect(context()).toMatchObject({
      BodyForAgent: "[msteams attachment unavailable]",
      media: [expect.objectContaining({ kind: "document" })],
    });
  });
  it("preserves ordinary reply text when the Teams API cannot resolve a Graph team ID", async () => {
    const getTeamDetails = vi.fn(async () => {
      throw new Error("Teams API unavailable");
    });
    const { handle } = setup({}, getTeamDetails);
    await handle({
      text: "<at>Bot</at> keep this text",
      replyToId: "unresolved-parent",
      channelData: teamData("19:team-unresolved@thread.skype"),
    });
    expect(getTeamDetails).toHaveBeenCalledWith("19:team-unresolved@thread.skype");
    expect(graphMedia).not.toHaveBeenCalled();
    expect(context()).toMatchObject({ BodyForAgent: "keep this text", NativeChannelId: undefined });
  });
  it.each([
    {
      name: "DM download",
      config: dmConfig,
      input: {
        conversation: dmConversation,
        channelData: {},
        text: "what is this?",
        entities: [],
        attachments: [
          {
            contentType: "image/*",
            contentUrl: "https://smba.trafficmanager.net/au/tenant/v3/attachments/a/views/original",
          },
        ],
      },
      expected: { BodyForAgent: "what is this?" },
      team: undefined,
    },
    {
      name: "team identity after download",
      config: {},
      input: {
        text: "<at>Bot</at> see image",
        channelData: teamData("19:slow-media-team@thread.skype"),
      },
      expected: { NativeChannelId: "team-aad-group/19:channel@thread.tacv2" },
      team: "19:slow-media-team@thread.skype",
    },
  ])("preserves the budget for $name", async ({ config, input, expected, team }) => {
    const transferMs = 45_000;
    vi.useFakeTimers();
    // Mirror a guarded fetch: the per-request timeout comes from the deadline it was handed.
    media.mockImplementation(async ({ deadline }) => {
      if (resolveMSTeamsRequestTimeoutMs(deadline) < transferMs) {
        throw new Error("request timed out");
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, transferMs);
      });
      return [{ path: "/tmp/pasted.png", contentType: "image/png", kind: "image" }];
    });
    const { handle, getTeamDetails } = setup(config);
    const run = handle(input);
    await vi.advanceTimersByTimeAsync(transferMs);
    await run;
    expect(context()).toMatchObject({
      ...expected,
      media: [expect.objectContaining({ path: "/tmp/pasted.png", kind: "image" })],
    });
    if (team) {
      expect(getTeamDetails).toHaveBeenCalledExactlyOnceWith(team);
    }
  });
  it("drops unmentioned empty HTML before media recovery", async () => {
    const { handle, getTeamDetails, enqueueSystemEvent } = setup({ requireMention: true });
    await handle({
      text: "",
      entities: [],
      attachments: html("<div></div>"),
    });
    expect(getTeamDetails).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
