import type { LLMProvider, ValueSchema } from "../src/types.js";
import { createAgent } from "../src/agent-api.js";
import { createModel } from "../src/model-api.js";
import { describe, expect, it } from "vitest";

describe("Model structured output", () => {
  it("falls back from unavailable JSON Schema to JSON object without leaking provider behavior to applications", async () => {
    const responseFormats: string[] = [];
    const provider: LLMProvider = {
      name: "live-compatible",
      async chat(_messages, options) {
        const format = options?.responseFormat?.type ?? "text";
        responseFormats.push(format);
        if (format === "json_schema") throw new Error("LLM request failed (400): response_format type is unavailable now");
        return { content: '{"intent":"general"}' };
      },
      async *stream() { yield ""; },
    };
    const schema: ValueSchema<{ readonly intent: string }> = {
      name: "Intent",
      parse: (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.intent !== "string") throw new Error("invalid intent");
        return { intent: value.intent };
      },
    };

    await expect(createModel({ provider }).structured(schema).generate({ messages: [{ role: "user", content: "classify" }] })).resolves.toEqual({ intent: "general" });
    expect(responseFormats).toEqual(["json_schema", "json_object"]);
  });

  it("keeps the originating tool call id in streamed provider history", async () => {
    let round = 0;
    const provider: LLMProvider = {
      name: "openai-compatible-tool-history",
      async chat() { return { content: "" }; },
      async *stream() { yield ""; },
      async *streamDetailed(messages) {
        round += 1;
        if (round === 1) {
          yield { type: "tool_call" as const, value: { id: "call-live-1", index: 0, name: "lookup", arguments: '{"query":"users"}' } };
          return;
        }
        expect(messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-live-1", content: '{"count":6}' });
        yield { type: "token" as const, value: "Có 6 users." };
      },
    };
    const agent = createAgent({
      model: createModel({ provider }),
      tools: [{
        spec: { name: "lookup", description: "Look up a value.", parameters: { type: "object", properties: { query: { type: "string" } } } },
        execute: async () => ({ count: 6 }),
      }],
    });

    const events = [];
    for await (const event of agent.stream({ query: "users" })) events.push(event);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "output")).toMatchObject({ type: "output", output: { content: "Có 6 users." } });
  });

  it("returns a tool failure to the model and keeps the streamed tool lifecycle paired", async () => {
    let round = 0;
    const provider: LLMProvider = {
      name: "tool-error-recovery",
      async chat() { return { content: "" }; },
      async *stream() { yield ""; },
      async *streamDetailed(messages) {
        round += 1;
        if (round === 1) {
          yield { type: "tool_call" as const, value: { id: "call-failure-1", index: 0, name: "lookup", arguments: "{}" } };
          return;
        }
        expect(messages.at(-1)).toMatchObject({
          role: "tool",
          toolCallId: "call-failure-1",
          content: expect.stringContaining("TOOL_EXECUTION_FAILED"),
        });
        yield { type: "token" as const, value: "Không thể tra cứu ngay lúc này." };
      },
    };
    const agent = createAgent({
      model: createModel({ provider }),
      tools: [{
        spec: { name: "lookup", description: "Look up a value.", parameters: { type: "object", properties: {} } },
        execute: async () => { throw new Error("Temporary MCP failure"); },
      }],
    });

    const events = [];
    for await (const event of agent.stream({ query: "users" })) events.push(event);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({
      type: "tool_end",
      result: { error: { code: "TOOL_EXECUTION_FAILED", message: "Temporary MCP failure" } },
    });
    expect(events.find((event) => event.type === "output")).toMatchObject({ type: "output", output: { content: "Không thể tra cứu ngay lúc này." } });
  });
});
