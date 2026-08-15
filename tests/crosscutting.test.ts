import { describe, expect, it } from "vitest";
import {
  createCache,
  createEvaluation,
  createExecutionRuntime,
  createGuardrails,
  createObservability,
  createReasoning,
  createReflection,
  createReliability,
  createSchema,
  createStreaming,
  createToolRegistry,
  type StepEvent,
  type ToolContext,
} from "../src/index.js";

describe("Core cross-cutting facades", () => {
  it("classifies intent through an injected LLM callback and creates a typed plan", async () => {
    const reasoning = createReasoning<"search" | "write">({
      classify: async () => ({ value: "search", details: {}, analysis: { confidence: 0.98, language: "en", needsClarification: false } }),
    });

    await expect(reasoning.classify({ message: "find nodes" })).resolves.toMatchObject({ value: "search" });
    await expect(reasoning.plan({ goal: "Find nodes" })).resolves.toMatchObject({ goal: "Find nodes", tasks: [{ id: "task-1" }] });
  });

  it("reflects candidates and validates quality checks", async () => {
    const reflection = createReflection({ threshold: 0.8 });
    await expect(reflection.consensus([{ value: "draft-a", score: 0.4 }, { value: "draft-b", score: 0.9 }])).resolves.toMatchObject({ accepted: true, value: "draft-b" });
    await expect(reflection.qualityGate("draft", [{ name: "non-empty", check: (value) => value.length > 0 }])).resolves.toMatchObject({ accepted: true, score: 1 });
  });

  it("applies guardrails and risk classification", async () => {
    const guardrails = createGuardrails({ input: (value) => typeof value === "string" && value.length < 10, denyReason: "too long" });
    await expect(guardrails.input("short")).resolves.toMatchObject({ allowed: true });
    await expect(guardrails.input("a value that is too long")).resolves.toMatchObject({ allowed: false, reason: "too long" });
    await expect(guardrails.classifyRisk({ value: "safe" })).resolves.toBe("low");
  });

  it("retries, caches, runs bounded parallel work and evaluates output", async () => {
    let attempts = 0;
    const reliability = createReliability({ attempts: 2 });
    await expect(reliability.retry(async () => { attempts += 1; if (attempts === 1) throw new Error("retry"); return "ok"; })).resolves.toBe("ok");
    expect(attempts).toBe(2);

    const cache = createCache({ namespace: "test" });
    await cache.set("key", { value: 3 });
    await expect(cache.get<{ readonly value: number }>("key")).resolves.toEqual({ value: 3 });

    const runtime = createExecutionRuntime({ concurrency: 2 });
    await expect(runtime.parallel([async () => 1, async () => 2, async () => 3])).resolves.toEqual([1, 2, 3]);

    const evaluation = createEvaluation();
    await expect(evaluation.run([{ id: "case-1", input: { value: 1 }, expected: { value: 1 } }], async (input) => input)).resolves.toMatchObject({ passed: true, score: 1 });
  });

  it("observes and filters token streams without changing events", async () => {
    const observed: JsonEvent[] = [];
    const streaming = createStreaming({ onEvent: (event) => { observed.push(event as JsonEvent); } });
    const source = createEvents();
    await expect(streaming.collect(source)).resolves.toHaveLength(2);
    expect(observed).toHaveLength(2);

    const tokenSource = createStepEvents();
    const tokens: string[] = [];
    for await (const token of streaming.tokens(tokenSource)) tokens.push(token);
    expect(tokens).toEqual(["hello", "world"]);
  });

  it("registers tools, executes plans and enforces approval", async () => {
    const registry = createToolRegistry();
    const context: ToolContext = { threadId: "thread", runId: "run", variables: {}, global: {} };
    registry.register({ name: "add", description: "Add two values", input: createSchema("add", () => ({ left: 0, right: 0 })), execute: (args: { readonly left: number; readonly right: number }) => args.left + args.right });
    await expect(registry.execute<number>("add", { left: 2, right: 3 }, context)).resolves.toBe(5);
    await expect(registry.executePlan([{ id: "sum", name: "add", args: { left: 4, right: 5 } }], context)).resolves.toEqual({ sum: 9 });
    await expect(registry.requireApproval({ name: "add", description: "Add two values", input: createSchema("add", () => ({ left: 0, right: 0 })), execute: (args: { readonly left: number; readonly right: number }) => args.left + args.right }, { left: 1, right: 1 }, async () => false, context)).rejects.toThrow("was not approved");
  });
});

type JsonEvent = string | { readonly value: number };

async function* createEvents(): AsyncIterable<JsonEvent> {
  yield "first";
  yield { value: 2 };
}

async function* createStepEvents(): AsyncIterable<StepEvent> {
  yield { graph: "test", threadId: "thread", runId: "run", ts: 1, type: "token", data: { value: "hello", index: 0 } };
  yield { graph: "test", threadId: "thread", runId: "run", ts: 2, type: "reasoning", data: { value: "thinking", index: 0 } };
  yield { graph: "test", threadId: "thread", runId: "run", ts: 3, type: "token", data: { value: "world", index: 1 } };
}
