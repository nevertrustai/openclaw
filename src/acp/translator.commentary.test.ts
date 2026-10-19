import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createSessionAgentHarness,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";

// mock-isolation: Command discovery loads unrelated plugin runtimes outside the text-stream contract.
vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

async function createHarness() {
  const sent = createDeferred<string>();
  const request = vi.fn().mockImplementation(async (method, params) => {
    if (method === "chat.send") {
      sent.resolve(params.idempotencyKey);
    }
    return {};
  });
  const harness = createSessionAgentHarness(request);
  const prompt = promptAgent(harness.agent);
  const runId = await sent.promise;
  let seq = 0;
  const send = (event: string, payload: Record<string, unknown>) => {
    seq = typeof payload.seq === "number" ? payload.seq : seq + 1;
    return harness.agent.handleGatewayEvent({
      type: "event",
      event,
      payload: { sessionKey: harness.sessionKey, runId, seq, ...payload },
    });
  };
  const chat = (text: string, options: Record<string, unknown> = {}) =>
    send("chat", { state: "delta", message: { content: [{ type: "text", text }] }, ...options });
  const preamble = (itemId: string, progressText: string, options: Record<string, unknown> = {}) =>
    send("agent", {
      stream: "item",
      data: { kind: "preamble", itemId, progressText, phase: "end" },
      preamble: { retainedText: "" },
      ...options,
    });
  const tool = (toolCallId: string, phase: "start" | "result") =>
    send("agent", { stream: "tool", data: { phase, name: "read", toolCallId } });
  const assistant = (itemId: string, text: string, fields: Record<string, unknown> = {}) =>
    send("agent", { stream: "assistant", data: { itemId, text, ...fields } });
  const round = async (id = "read") => {
    await tool(id, "start");
    await tool(id, "result");
  };
  const finish = async (text = "Done.") => {
    await chat(text, { state: "final" });
    await prompt;
  };
  const updates = () =>
    harness.sessionUpdate.mock.calls.flatMap(([{ update }]) => {
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          return [update.content.text];
        case "tool_call":
        case "tool_call_update":
          return [`${update.toolCallId}:${update.status}`];
        default:
          return [];
      }
    });
  return { ...harness, prompt, assistant, chat, preamble, tool, round, finish, updates };
}

describe("ACP commentary reclassification", () => {
  it("preserves narration and the answer when the replacement is deferred", async () => {
    const answer = "OK.";
    const h = await createHarness();
    const narration = "I will read the sample now.";
    await h.assistant("preview", narration, { delta: narration });
    await h.chat("I will");
    await h.preamble("commentary", narration);
    await h.preamble("commentary", narration);
    await h.round();
    // Transcript publication releases the replacement with a later sequence.
    await h.chat("", { replace: true });
    await h.assistant("answer", answer, { delta: answer });
    await h.chat(answer);
    await h.chat("", { replace: true });
    await h.finish(answer);
    expect(h.updates()).toEqual([
      "I will",
      " read the sample now.",
      "read:in_progress",
      "read:completed",
      answer,
    ]);
  });

  it("delivers the complete answer after two tool rounds", async () => {
    const answer = "Verified.";
    const h = await createHarness();
    const expected: string[] = [];
    for (let round = 0; round < 2; round++) {
      const narration = round === 0 ? "I will read the sample now." : "Checking again.";
      await h.chat(narration);
      const seq = 100 + round;
      await h.chat("", { replace: true, seq });
      await h.preamble(`commentary-${round}`, narration, { seq });
      // A completion echo must not retire another answer's baseline.
      await h.preamble(`commentary-${round}`, narration);
      await h.round(`read-${round}`);
      expected.push(narration, `read-${round}:in_progress`, `read-${round}:completed`);
    }
    await h.assistant("answer", answer);
    await h.chat(answer);
    // Ordinary final retirement also sends an empty replacement, without a preamble.
    await h.chat("", { replace: true });
    await h.chat(answer, { state: "final" });
    await expect(h.prompt).resolves.toEqual({ stopReason: "end_turn" });
    expect(h.updates()).toEqual([...expected, answer]);
  });

  it("streams preamble-only snapshots once per item before the tool", async () => {
    const h = await createHarness();
    const pending = [
      h.preamble("first", "Checking", {
        data: { kind: "preamble", itemId: "first", progressText: "Checking", phase: "update" },
      }),
      h.preamble("first", "Checking again."),
      h.preamble("first", "Checking again."),
      h.tool("read-1", "start"),
      h.tool("read-1", "result"),
      h.preamble("second", "Checking again."),
      h.tool("read-2", "start"),
      h.tool("read-2", "result"),
    ];
    await Promise.all(pending);
    await h.finish();
    expect(h.updates()).toEqual([
      "Checking",
      " again.",
      "read-1:in_progress",
      "read-1:completed",
      "Checking again.",
      "read-2:in_progress",
      "read-2:completed",
      "Done.",
    ]);
  });

  it("resumes commentary from the last emitted snapshot after a divergent snapshot", async () => {
    const h = await createHarness();
    await h.preamble("commentary", "Checking files");
    await h.preamble("commentary", "Reading files");
    await h.preamble("commentary", "Checking files now");
    await h.finish();
    expect(h.updates()).toEqual(["Checking files", " now", "Done."]);
  });

  it("advances an item's boundary within an already displayed multi-item preview", async () => {
    const h = await createHarness();
    await h.chat("Checking files.\nReading config.");
    await h.preamble("first", "Checking");
    await h.preamble("first", "Checking files.", { preamble: {} });
    await h.preamble("second", "Reading config.", { preamble: {} });
    await h.finish();
    expect(h.updates()).toEqual(["Checking files.\nReading config.", "Done."]);
  });

  it.each([
    { deferred: false, chatFirst: false },
    { deferred: true, chatFirst: false },
    { deferred: true, chatFirst: true },
  ])(
    "keeps an earlier answer prefix (deferred=$deferred, chatFirst=$chatFirst)",
    async ({ deferred, chatFirst }) => {
      const h = await createHarness();
      await h.assistant("earlier-answer", "First answer.", { phase: "final_answer" });
      await h.chat("First answer.");
      if (chatFirst) {
        await h.chat("First answer.\n\nChecking again.");
      }
      await h.assistant("preview", "First answer.\n\nChecking again.");
      if (!chatFirst) {
        await h.chat("First answer.\n\nChecking again.");
      }
      if (!deferred) {
        await h.chat("First answer.", { replace: true, seq: 100 });
      }
      await h.preamble("commentary", "Checking again.", {
        seq: 100,
        preamble: { retainedText: "First answer." },
      });
      if (deferred) {
        await h.chat("First answer.", { replace: true });
      }
      await h.round();
      await h.finish("First answer.\n\nDone.");
      expect(h.updates()).toEqual([
        "First answer.",
        "\n\nChecking again.",
        "read:in_progress",
        "read:completed",
        "\n\nDone.",
      ]);
    },
  );

  it("keeps a distinct preamble with identical text and ignores another run", async () => {
    const h = await createHarness();
    await h.chat("Answer.");
    await h.chat("", { replace: true, seq: 100 });
    await h.preamble("foreign", "Answer.", { seq: 100, runId: "other-run" });
    await h.preamble("unrelated", "Answer.", { seq: 101, preamble: {} });
    await h.finish("Answer.");
    expect(h.updates()).toEqual(["Answer.", "Answer."]);
  });
  it("delivers a retained answer that was held before a reclassified item", async () => {
    const h = await createHarness();
    await h.preamble("commentary", "Checking again.", {
      preamble: { retainedText: "First answer." },
    });
    await h.round();
    await h.finish("First answer.\n\nDone.");
    expect(h.updates()).toEqual([
      "First answer.\n\nChecking again.",
      "read:in_progress",
      "read:completed",
      "\n\nDone.",
    ]);
  });

  it("keeps legacy events without projection metadata compatible", async () => {
    const h = await createHarness();
    await h.preamble("legacy", "Checking.", { preamble: undefined });
    await h.round();
    await h.chat("Done.");
    await h.finish();
    expect(h.updates()).toEqual(["read:in_progress", "read:completed", "Done."]);
  });
});
