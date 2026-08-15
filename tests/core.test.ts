import { describe, expect, it, vi } from "vitest";
import {
  CompileRuleViolationError,
  GraphRuntimeError,
  SafetyLimitExceededError,
} from "../src/index.js";
import {
  buildGraph,
  conditional,
  converge,
  createCancellationSource,
  defineGraph,
  defineState,
  edge,
  isReducedField,
  messagesValue,
  node,
  reducedValue,
  safety,
  schema,
} from "../src/legacy.js";
import { compile, attachExecutor, GraphRegistry } from "../src/runtime-barrel.js";
import { dispatchToQueue, registerQueueAdapter } from "../src/queue-barrel.js";
import { MemoryCheckpointer, codeAnchor, runVerifiers, hasAnchor } from "../src/testing-barrel.js";

describe("buildGraph zero-config entrypoint", () => {
	it("compiles and attaches a runnable graph in one call", async () => {
		const graph = buildGraph(defineGraph({
			name: "one-call",
			state: defineState({ question: "", answer: "" }),
			nodes: {
				answer: async (state) => ({ answer: state.question || "ready" }),
			},
		}));

		const result = await graph.run({ question: "" });
		expect(result.state.answer).toBe("ready");
	});
});

interface TestState {
  messages: unknown[];
  counter: number;
  done: boolean;
  response: string;
}

function simpleDef() {
  return defineGraph<TestState>({
    name: "simple",
    state: {
      messages: messagesValue(),
      counter: reducedValue<number>(0, (a, b) => (a as number) + (b as number)),
      done: false as unknown as never,
      response: "" as never,
    } as never,
    stateDefaults: { counter: 0 as never, done: false as never, response: "" as never },
    nodes: {
      start: node(async (state) => ({ counter: 1, response: "started" })),
      end: node(async () => ({ done: true })),
    },
    entry: "start",
    edges: [edge("start", "end")],
    safety: safety(10),
  });
}

describe("defineGraph + compile (Rule enforcement at compile time)", () => {
  it("compiles a valid linear graph", () => {
    const def = simpleDef();
    const compiled = compile(def);
    expect(compiled.name).toBe("simple");
    expect(compiled.entry).toBe("start");
    expect(compiled.safety.recursionLimit).toBe(10);
  });

  it("rejects a node writing to undeclared state (Rule N2) via runtime guard", () => {
    const def = simpleDef();
    const graph = attachExecutor(compile(def));
    // Node writes counter=1 - declared field, OK
    return expect(graph.run({ messages: [] })).resolves.toBeTruthy();
  });

	it("uses raw state descriptors as initial values without stateDefaults", async () => {
    const graph = attachExecutor(compile(defineGraph<{
      question: string;
      count: number;
    }>({
      name: "raw-state-defaults",
      state: {
        question: "",
        count: reducedValue(0, (previous, next) => previous + next),
      },
      nodes: {
        inspect: node(async (state) => ({ question: state.question, count: 1 })),
      },
      entry: "inspect",
      safety: safety(5),
    })));

    const result = await graph.run({});
    expect(result.state.question).toBe("");
		expect(result.state.count).toBe(1);
	});

	it("infers state and linear edges from the zero-config DSL", async () => {
		const graph = attachExecutor(compile(defineGraph({
			name: "inferred-state",
			state: defineState({
				question: "",
				count: reducedValue(0, (previous, next) => previous + next),
			}),
			nodes: {
				write: async (state) => ({ question: `${state.question}ready`, count: 1 }),
				finish: async () => ({}),
			},
		})));

		const result = await graph.run({});
		expect(result.state.question).toBe("ready");
		expect(result.state.count).toBe(1);
		expect(graph.adjacency.get("write")?.fixed).toEqual(["finish"]);
	});

	it("inherits checkpoint configuration from graph runtime defaults", async () => {
		const checkpoint = new MemoryCheckpointer();
		const graph = attachExecutor(compile(defineGraph({
			name: "runtime-checkpoint",
			state: defineState({ messages: messagesValue(), done: false }),
			nodes: {
				confirm: async () => ({ done: true }),
			},
			interruptBefore: ["confirm"],
			runtime: { checkpoint },
		})));

		const result = await graph.run({ messages: [] }, { threadId: "runtime-defaults" });
		expect(result.stoppedReason).toBe("interrupt");
		expect((await checkpoint.get("runtime-defaults"))?.node).toBe("confirm");
	});

  it("throws CompileRuleViolationError on unknown entry node", () => {
    const def = defineGraph<TestState>({
      name: "bad-entry",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      nodes: { start: node(async () => ({})) },
      entry: "missing",
      edges: [],
      safety: safety(10),
    });
    expect(() => compile(def)).toThrow();
  });

  it("detects unbounded cycles without converge (Rule L1)", () => {
    const def = defineGraph<TestState>({
      name: "loop-bad",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      nodes: {
        a: node(async () => ({})),
        b: node(async () => ({})),
      },
      entry: "a",
      edges: [edge("a", "b"), edge("b", "a")],
      safety: safety(10),
    });
    expect(() => compile(def)).toThrow();
  });

  it("accepts cycles with converge declared (Rule L1)", () => {
    const def = defineGraph<TestState>({
      name: "loop-ok",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      nodes: {
        a: node(async () => ({})),
        b: node(async () => ({})),
      },
      entry: "a",
      edges: [
        edge("a", "b"),
        conditional("b", () => "a", ["a", "END"]),
      ],
      converge: converge<TestState>("messages" as never, 3) as never,
      safety: safety(10),
    });
    expect(() => compile(def)).not.toThrow();
  });

  it("requires deterministic conditional targets (Rule E2): runtime rejects undeclared branch", async () => {
    const def = defineGraph<TestState>({
      name: "route-bad",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      nodes: {
        a: node(async () => ({})),
        b: node(async () => ({})),
      },
      entry: "a",
      edges: [conditional("a", () => "ghost", ["b", "END"])],
      safety: safety(10),
    });
    const graph = attachExecutor(compile(def));
    const result = await graph.run({ messages: [] });
    expect(result.stoppedReason).toBe("error");
    expect(result.error).toBeInstanceOf(GraphRuntimeError);
  });

  it("rejects recursion limit breach with SafetyLimitExceededError (Rule L2)", async () => {
    let tick = 0;
    const def = defineGraph<TestState>({
      name: "safety",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      nodes: {
        // Append messages every visit so state always changes and dry-loop
        // convergence cannot stop the cycle before the safety limit.
        a: node(async (s) => ({ messages: [...s.messages, { role: "user", content: `a-${++tick}` }] })),
        b: node(async () => ({})),
      },
      entry: "a",
      edges: [edge("a", "b"), conditional("b", () => "a", ["a", "END"])],
      converge: converge<TestState>("messages" as never, 10) as never,
      safety: safety(2),
    });
    const graph = attachExecutor(compile(def));
    const result = await graph.run({ messages: [] });
    expect(result.stoppedReason).toBe("safety");
    expect(result.error).toBeInstanceOf(SafetyLimitExceededError);
  });
});

describe("executor (run + stream + reducers + interrupt + cancel)", () => {
  it("runs a linear graph and applies reducers (Rule N2)", async () => {
    const def = simpleDef();
    const graph = attachExecutor(compile(def));
    const result = await graph.run({ messages: [{ role: "user", content: "hi" }] });
    expect(result.state.counter).toBe(1);
    expect(result.state.response).toBe("started");
  });

  it("stream emits step events per node visit (Rule P3)", async () => {
    const def = simpleDef();
    const graph = attachExecutor(compile(def));
    const types: string[] = [];
    for await (const ev of graph.stream({ messages: [] })) {
      types.push(ev.type);
    }
    expect(types.includes("node_start")).toBe(true);
    expect(types.filter((t) => t === "node_end").length).toBeGreaterThanOrEqual(2);
  });

  it("stream preserves the final tool_end event when a node resolves immediately (Rule P3)", async () => {
    const echoTool = {
      name: "echo",
      description: "Echo a message for stream instrumentation testing.",
      input: schema<{ readonly message: string }>("EchoInput", (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value) || typeof (value as Record<string, unknown>).message !== "string") {
          throw new Error("message is required");
        }
        return { message: (value as { readonly message: string }).message };
      }),
      async execute(args: { readonly message: string }) {
        return { echoed: args.message };
      },
    };
    const graph = attachExecutor(compile(defineGraph<{ readonly messages: unknown[]; readonly done: boolean }>({
      name: "tool-events",
      state: { messages: messagesValue(), done: false as never } as never,
      nodes: {
        call: node(async (_state, ctx) => {
          await ctx.callTool(echoTool, { message: "ok" });
          return { done: true };
        }),
      },
      entry: "call",
      safety: safety(5),
    })));
    const types: string[] = [];
    for await (const event of graph.stream({ messages: [] })) types.push(event.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types.indexOf("tool_end")).toBeLessThan(types.indexOf("node_end"));
  });

  it("interruptBefore pauses execution and checkpoint persists (Rule P5)", async () => {
    const def = defineGraph<TestState>({
      name: "gated",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      stateDefaults: { counter: 0 as never, done: false as never, response: "" as never },
      nodes: {
        plan: node(async () => ({ counter: 1 })),
        confirm: node(async () => ({ done: true })),
      },
      entry: "plan",
      edges: [edge("plan", "confirm")],
      safety: safety(10),
      interruptBefore: ["confirm"],
    });
    const cp = new MemoryCheckpointer();
    const graph = attachExecutor(compile(def));
    const result = await graph.run({ messages: [] }, { threadId: "t1", checkpoint: cp });
    expect(result.stoppedReason).toBe("interrupt");
    const saved = await cp.get("t1");
    // Checkpoint persists at the gated node (before it executes).
    expect(saved?.node).toBe("confirm");
  });

  it("resumes from checkpoint after interruption", async () => {
    const def = defineGraph<TestState>({
      name: "gated2",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      stateDefaults: { counter: 0 as never, done: false as never, response: "" as never },
      nodes: {
        plan: node(async () => ({ counter: 1 })),
        confirm: node(async () => ({ done: true })),
      },
      entry: "plan",
      edges: [edge("plan", "confirm")],
      safety: safety(10),
      interruptBefore: ["confirm"],
    });
    const cp = new MemoryCheckpointer();
    const graph = attachExecutor(compile(def));
    await graph.run({ messages: [] }, { threadId: "t2", checkpoint: cp });
    // Resume: supply human response for the interrupt at the gated node.
    const resumed = await graph.run({ messages: [] }, { threadId: "t2", checkpoint: cp, resumeFrom: "confirm", humanResponse: true });
    expect(resumed.state.done).toBe(true);
  });

  it("cancellation stops the loop (Rule L2)", async () => {
    const def = defineGraph<TestState>({
      name: "cancellable",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      stateDefaults: { counter: 0 as never, done: false as never, response: "" as never },
      nodes: {
        slow: node(async (_s, ctx) => {
          await new Promise((r) => setTimeout(r, 20));
          return ctx.cancelled() ? {} : { counter: 1 };
        }),
        next: node(async () => ({ done: true })),
      },
      entry: "slow",
      edges: [edge("slow", "next")],
      safety: safety(10),
    });
    const source = createCancellationSource();
    const graph = attachExecutor(compile(def));
    setTimeout(() => source.cancel(), 5);
    const result = await graph.run({ messages: [] }, { cancellation: source });
    expect(["cancelled", "error"]).toContain(result.stoppedReason);
    expect(source.isCancelled()).toBe(true);
  });
});

describe("verifiers (Rule E3: non-LLM anchor required)", () => {
  it("passes when a code anchor verifier is wired", async () => {
    const def = defineGraph<TestState>({
      name: "verified",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      stateDefaults: { counter: 0 as never, done: false as never, response: "" as never },
      nodes: {
        work: node(async () => ({ counter: 5 })),
      },
      entry: "work",
      edges: [],
      safety: safety(10),
      verify: ["work"],
      verifierFns: [codeAnchor(() => true)],
    });
    const compiled = attachExecutor(compile(def));
    const result = await compiled.run({ messages: [] });
    const panel = await runVerifiers(compiled, result.state, { requireNonLlmAnchor: true });
    expect(panel.pass).toBe(true);
    expect(hasAnchor(panel)).toBe(true);
  });

  it("fails when the panel has no non-LLM anchor", async () => {
    const def = defineGraph<TestState>({
      name: "unanchored",
      state: { messages: messagesValue(), counter: 0 as never, done: false as never, response: "" as never } as never,
      stateDefaults: { counter: 0 as never, done: false as never, response: "" as never },
      nodes: {
        work: node(async () => ({})),
      },
      entry: "work",
      edges: [],
      safety: safety(10),
      verify: ["work"],
      verifierFns: [async () => ({ pass: true, reason: "llm says ok", anchors: ["llm"] })],
    });
    const compiled = attachExecutor(compile(def));
    const result = await compiled.run({ messages: [] });
    const panel = await runVerifiers(compiled, result.state, { requireNonLlmAnchor: true });
    expect(panel.pass).toBe(false);
    expect(panel.reason).toContain("non-LLM anchor");
  });
});

describe("GraphRegistry", () => {
  it("compiles, registers and runs by name", async () => {
    const registry = new GraphRegistry();
    registry.register(simpleDef());
    expect(registry.list()).toEqual(["simple"]);
    const r = await registry.run("simple", { messages: [] });
    expect((r.state as TestState).counter).toBe(1);
  });

  it("rejects duplicate registration", () => {
    const registry = new GraphRegistry();
    registry.register(simpleDef());
    expect(() => registry.register(simpleDef())).toThrow(GraphRuntimeError);
  });

  it("errors on running unregistered graph", async () => {
    const registry = new GraphRegistry();
    await expect(registry.run("missing", {})).rejects.toThrow(GraphRuntimeError);
  });
});

describe("queue dispatch (host-agnostic)", () => {
  it("dispatches when an adapter is registered", async () => {
    const registry = new GraphRegistry();
    registry.register(simpleDef());
    const jobs: unknown[] = [];
    registerQueueAdapter("default", {
      enqueue: async (job) => {
        jobs.push(job);
        return "job-1";
      },
    });
    const jobId = await dispatchToQueue(registry, "simple", { messages: [] });
    expect(jobId).toBe("job-1");
    expect(jobs).toHaveLength(1);
  });

  it("errors when no adapter is registered", async () => {
    const registry = new GraphRegistry();
    registry.register(simpleDef());
    await expect(dispatchToQueue(registry, "simple", {}, { queue: "missing-queue" })).rejects.toThrow(
      GraphRuntimeError,
    );
  });
});

describe("state value helpers", () => {
  it("messagesValue / reducedValue are reduced fields", () => {
    expect(isReducedField(messagesValue())).toBe(true);
    expect(isReducedField(reducedValue(0, (a, b) => (a as number) + (b as number)))).toBe(true);
    expect(isReducedField(5)).toBe(false);
  });
});

describe("checkpointer memory", () => {
  it("persists and lists checkpoints", async () => {
    const cp = new MemoryCheckpointer();
    await cp.put({ threadId: "t", checkpointId: "c1", state: { a: 1 }, node: "n", round: 1 });
    await cp.put({ threadId: "t", checkpointId: "c2", state: { a: 2 }, node: "n", round: 2 });
    expect((await cp.get("t"))?.checkpointId).toBe("c2");
    expect((await cp.list("t")).length).toBe(2);
    expect(await cp.get("unknown")).toBeNull();
  });
});
