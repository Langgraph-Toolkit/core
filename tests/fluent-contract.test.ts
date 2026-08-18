import { describe, expect, it } from "vitest";
import {
  createGraph,
  createMemoryCheckpointer,
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

  it("lowers route() into a bounded conditional edge keyed on the selector field", () => {
    const state = createState({ intent: "", answer: "" });
    const workflow = createWorkflow("route-contract", { state })
      .node("branch-a", createNode(async () => ({ answer: "a" })))
      .node("branch-b", createNode(async () => ({ answer: "b" })))
      .start("branch-a")
      .edge("branch-a", "branch-b", "step")
      .route({ quick: "branch-b", deep: "branch-a" }, { field: "intent" });

    const definition = workflow.definition();
    const conditional = definition.edges.find((edge) => "fn" in edge);

    expect(conditional).toBeDefined();
    if (!conditional || !("fn" in conditional)) throw new Error("Expected a conditional edge.");
    expect(conditional.from).toBe("branch-b");
    expect(conditional.label).toBe("route:intent");
    expect(conditional.targets).toEqual(expect.arrayContaining(["branch-a", "branch-b"]));
    expect(conditional.fn({ intent: "quick" })).toBe("branch-b");
    expect(conditional.fn({ intent: "deep" })).toBe("branch-a");
    expect(() => conditional.fn({ intent: "unknown" })).toThrow(/route\(\) map has no entry for intent="unknown"/);
  });

  it("rejects route() selector fields that are not declared in the state schema", () => {
    const state = createState({ answer: "" });
    const builder = createWorkflow("route-field-contract", { state })
      .node("answer", createNode(async () => ({ answer: "ok" })))
      .start("answer");

    expect(() => builder.route({ quick: "answer" }, { field: "intent" })).toThrow(/not declared in the graph state/);
  });

  it("lowers parallel() into branch nodes, fan-out and convergence edges, and a join barrier", () => {
    const state = createState({ query: "", documents: [] as string[], answer: "" });
    const branch = async (): Promise<{ answer: string }> => ({ answer: "done" });

    const workflow = createWorkflow("parallel-contract", { state })
      .node("seed", createNode(async () => ({})))
      .start("seed")
      .parallel({ sql: branch, rag: branch }, { into: "answer" });

    const definition = workflow.definition();
    expect(Object.keys(definition.nodes)).toEqual(expect.arrayContaining(["seed", "sql", "rag"]));
    const fixed = definition.edges.filter((edge) => "to" in edge);
    expect(fixed).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "seed", to: "sql" }),
      expect.objectContaining({ from: "seed", to: "rag" }),
      expect.objectContaining({ from: "sql", to: "answer" }),
      expect.objectContaining({ from: "rag", to: "answer" }),
    ]));
    expect(definition.joins).toEqual([
      { nodes: ["sql", "rag"], target: "answer" },
    ]);
  });

  it("records plan() as a declarative PlanSpec and fails at runtime without a bound model tier", async () => {
    const state = createState({ query: "", subtasks: [] as string[], answer: "" });
    const workflow = createWorkflow("plan-contract", { state })
      .node("seed", createNode(async () => ({})))
      .start("seed")
      .plan();

    expect(workflow.definition().plan).toEqual({ tier: undefined, produce: "subtasks", into: "subtasks" });

    const result = await workflow.compile().invoke({});
    expect(result.stoppedReason).toBe("error");
    expect(result.error?.message).toMatch(/plan\(\) requires a bound model tier/);
  });

  it("fails fast on fluent controls that are not yet implemented", () => {
    const state = createState({ query: "", answer: "", summary: "" });
    const builder = createWorkflow("fail-fast-contract", { state })
      .node("answer", createNode(async () => ({ answer: "ok" })))
      .start("answer");

    expect(() => builder.rag()).toThrow(/not yet implemented/);
    expect(() => builder.supervisor()).toThrow(/not yet implemented/);
    expect(() => builder.replan()).toThrow(/not yet implemented/);
    expect(() => builder.reflect()).toThrow(/not yet implemented/);
    expect(() => builder.evaluate()).toThrow(/not yet implemented/);
    expect(() => builder.remember()).toThrow(/not yet implemented/);
    expect(() => builder.transaction()).toThrow(/not yet implemented/);
    expect(() => builder.subgraph("answer")).toThrow(/not yet implemented/);
    expect(() => builder.map({
      from: (value: { query: string }) => [value.query],
      run: async (item: string) => ({ answer: item }),
      into: "answer",
    })).toThrow(/not yet implemented/);
    expect(() => builder.reduce({
      from: "answer",
      into: "summary",
      reducer: (previous, next) => `${previous}${next}`,
    })).toThrow(/not yet implemented/);
    expect(() => builder.fallback({})).toThrow(/not yet implemented/);
    expect(() => builder.fallback({ policy: "rethrow" })).toThrow(/not yet implemented/);
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

  it("returns the newest checkpoint on a same-millisecond tie instead of re-triggering approval", async () => {
    // Regression for the adapter-checkpointers sort-tie bug: when several nodes
    // checkpoint within the same millisecond, sorting by createdAt can return
    // the OLDEST record and re-pause a node that already resumed. The canonical
    // memory checkpointer therefore orders by insertion, not timestamp.
    const checkpointer = createMemoryCheckpointer();
    const sameMillisecond = Date.now();
    await checkpointer.put({
      threadId: "tie-thread",
      checkpointId: "cp-old",
      state: { node: "paused", approved: false },
      node: "paused",
      round: 1,
      createdAt: sameMillisecond,
      pendingInterrupt: { node: "paused", mode: "before" },
    });
    await checkpointer.put({
      threadId: "tie-thread",
      checkpointId: "cp-new",
      state: { node: "resumed", approved: true },
      node: "resumed",
      round: 2,
      createdAt: sameMillisecond,
    });

    const latest = await checkpointer.get("tie-thread");
    expect(latest?.checkpointId).toBe("cp-new");
    expect(latest?.node).toBe("resumed");
    expect(latest?.pendingInterrupt).toBeUndefined();
  });

  it("does not re-trigger an approval gate when resuming a paused thread", async () => {
    const state = createState({ approved: false, result: "" });
    let executions = 0;
    const compiled = createWorkflow("approval-resume-contract", { state })
      .node("act", createNode(async () => {
        executions += 1;
        return { result: "executed" };
      }))
      .start("act")
      .approval({ before: "act", when: (value) => !value.approved, text: "Approve the act?" })
      .checkpoint()
      .compile();

    const paused = await compiled.invoke({}, { threadId: "approval-resume-thread" });
    expect(paused.stoppedReason).toBe("interrupt");
    expect(executions).toBe(0);

    const resumed = await compiled.resume("approval-resume-thread", true);
    expect(resumed.stoppedReason).toBe("done");
    expect(resumed.state.result).toBe("executed");
    expect(executions).toBe(1);
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
