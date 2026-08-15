import { describe, expect, it } from "vitest";
import {
  createGraph,
  createNode,
  createState,
  createWorkflow,
} from "../src/index.js";

describe("0.2.0 fluent workflow contract", () => {
  it("exposes the same high-level builder surface on workflow and graph", () => {
    const state = createState({ query: "", answer: "" });
    const workflow = createWorkflow("contract-workflow", { state });
    const graph = createGraph({ name: "contract-graph", state });
    const methods = [
      "reflect",
      "plan",
      "replan",
      "route",
      "map",
      "reduce",
      "parallel",
      "join",
      "retry",
      "fallback",
      "guard",
      "approval",
      "interrupt",
      "subgraph",
      "transaction",
      "rag",
      "supervisor",
      "evaluate",
      "remember",
      "checkpoint",
    ] as const;

    for (const method of methods) {
      expect(typeof workflow[method]).toBe("function");
      expect(typeof graph[method]).toBe("function");
    }
  });

  it("allows the canonical workflow facade to start with runtime state defaults", () => {
    const workflow = createWorkflow("zero-config-workflow");

    expect(workflow.definition().name).toBe("zero-config-workflow");
    expect(workflow.definition().stateDefaults).toMatchObject({
      threadId: "",
      runId: "",
      sessionId: "",
      messages: [],
    });
  });

  it("supports canonical config objects and shorthand overloads", () => {
    const state = createState({
      query: "",
      documents: [] as string[],
      answer: "",
      summary: "",
    });
    const documentAgent = async (document: string): Promise<{ answer: string }> => ({ answer: document });

    const workflow = createWorkflow("contract-config", { state })
      .parallel({ sql: documentAgent, rag: documentAgent })
      .map({
        from: (value: { documents: string[] }) => value.documents,
        run: documentAgent,
        into: "answer",
      })
      .join({ from: ["sql", "rag"], into: "answer" })
      .reduce({
        from: "answer",
        into: "summary",
        reducer: (previous: string, next: string) => `${previous}${next}`,
      })
      .join("answer")
      .retry({ attempts: 3, backoff: "exponential" })
      .retry(2)
      .fallback({ node: "answer", run: documentAgent, policy: "recover" })
      .route({ quick_chat: "answer", complex: "answer" })
      .interrupt({ type: "approval", text: "Continue?" })
      .transaction({ state: true, sideEffects: true, checkpoint: true })
      .plan()
      .reflect({ threshold: 0.8 })
      .replan()
      .guard()
      .approval()
      .subgraph("answer")
      .rag()
      .supervisor()
      .evaluate()
      .remember()
      .checkpoint();

    expect(workflow).toBeDefined();
  });

  it("lowers fluent interrupt and approval policies into executable human-in-the-loop pauses", async () => {
    const state = createState({ approved: false, result: "" });
    const write = createNode(async () => ({ result: "written" }));

    const explicitInterrupt = createWorkflow("interrupt-lowering", { state })
      .node("write", write)
      .start("write")
      .interrupt({
        before: "write",
        type: "review",
        text: "Review this write before continuing.",
        payload: { resource: "record" },
      })
      .compile();
    const interruptEvents = [];
    for await (const event of explicitInterrupt.stream({})) interruptEvents.push(event);

    expect(interruptEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "interrupt",
        data: expect.objectContaining({
          request: expect.objectContaining({
            kind: "review",
            prompt: "Review this write before continuing.",
            payload: { resource: "record" },
          }),
        }),
      }),
    ]));

    const conditionalApproval = createWorkflow("approval-lowering", { state })
      .node("write", write)
      .start("write")
      .approval({
        before: "write",
        when: (value) => !value.approved,
        text: "Approve the write?",
      })
      .compile();
    const approvalEvents = [];
    for await (const event of conditionalApproval.stream({})) approvalEvents.push(event);

    expect(approvalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "interrupt",
        data: expect.objectContaining({
          request: expect.objectContaining({ kind: "approval", prompt: "Approve the write?" }),
        }),
      }),
    ]));
  });

  it("adds a process-local checkpointer when the fluent checkpoint control has no adapter", async () => {
    const state = createState({ answer: "" });
    const compiled = createWorkflow("checkpoint-lowering", { state })
      .node("answer", createNode(async () => ({ answer: "saved" })))
      .start("answer")
      .checkpoint()
      .compile();

    await compiled.invoke({}, { threadId: "checkpoint-contract-thread" });
    const checkpointer = compiled.definition.runtime?.checkpoint;

    expect(checkpointer).toBeDefined();
    await expect(checkpointer?.list("checkpoint-contract-thread")).resolves.toHaveLength(1);
  });

  it("executes fluent retry, fallback and guard policies at runtime", async () => {
    const state = createState({ answer: "" });
    let attempts = 0;
    const retrying = createWorkflow("retry-lowering", { state })
      .node("answer", createNode(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
        return { answer: "retried" };
      }))
      .start("answer")
      .retry({ attempts: 3, backoff: "fixed" })
      .compile();

    await expect(retrying.invoke({})).resolves.toMatchObject({ state: { answer: "retried" } });
    expect(attempts).toBe(3);

    const recovered = createWorkflow("fallback-lowering", { state })
      .node("primary", createNode(async () => {
        throw new Error("unavailable");
      }))
      .node("recovery", createNode(async () => ({ answer: "recovered" })))
      .start("primary")
      .fallback({ node: "recovery", policy: "recover" })
      .compile();
    await expect(recovered.invoke({})).resolves.toMatchObject({ state: { answer: "recovered" } });

    const guarded = createWorkflow("guard-lowering", { state })
      .node("answer", createNode(async () => ({ answer: "blocked" })))
      .start("answer")
      .guard({ before: "answer", when: () => false, message: "Tier does not permit this operation." })
      .compile();
    await expect(guarded.invoke({})).resolves.toMatchObject({
      stoppedReason: "error",
      error: expect.objectContaining({ message: "Tier does not permit this operation." }),
    });
  });

  it("compiles with the canonical method and preserves the low-level alias", async () => {
    const state = createState({ answer: "" });
    const answer = createNode(async (_value: { answer: string }) => ({ answer: "ok" }));
    const workflow = createWorkflow("contract-runtime", { state })
      .node("answer", answer)
      .start("answer");

    const compiled = workflow.compile();
    const legacyCompiled = workflow.build();
    const invoked = await compiled.invoke({});
    const run = await legacyCompiled.run({});

    expect(invoked.state.answer).toBe("ok");
    expect(run.state.answer).toBe("ok");
    expect(typeof compiled.resume).toBe("function");
  });

  it("keeps graph primitives available on the low-level facade", () => {
    const graph = createGraph({
      name: "primitive-contract",
      state: createState({ count: 0 }),
    });

    expect(typeof graph.node).toBe("function");
    expect(typeof graph.edge).toBe("function");
    expect(typeof graph.start).toBe("function");
    expect(typeof graph.conditional).toBe("function");
    expect(typeof graph.fanout).toBe("function");
    expect(typeof graph.converge).toBe("function");
    expect(typeof graph.loop).toBe("function");
    expect(typeof graph.onError).toBe("function");
    expect(typeof graph.compile).toBe("function");
    expect(typeof graph.build).toBe("function");
  });
});
