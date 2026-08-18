# @langgraph-toolkit/core

**Define a typed workflow once. Run the same resource in a worker, CLI process, test harness, or supported backend adapter.** Core is the framework-agnostic runtime for workflows, agents, background jobs, data pipelines, approval flows, classifiers, and other stateful processes with observable transitions. It does not require a web framework, MCP transport, checkpointer driver, or model vendor.

## Install

```bash
npm install @langgraph-toolkit/core
```

Start with Core only. Add another package only when the resource needs that boundary: `@langgraph-toolkit/mcp` for MCP servers, `@langgraph-toolkit/community` for provider integrations and RAG, `@langgraph-toolkit/adapter-checkpointers` for durable state, or a host adapter for HTTP framework lifecycle.

## Quick start

`createWorkflow(name, options?)` is the canonical application facade. It infers state from one object, applies framework-provided runtime fields, accepts plain node functions, and compiles to a runnable workflow.

```ts
import {
  createState,
  createWorkflow,
} from "@langgraph-toolkit/core";

const state = createState({
  question: "",
  answer: "",
});

const workflow = createWorkflow("typed-answer", { state })
  .node("answer", current => ({
    answer: `Received: ${current.question}`,
  }))
  .start("answer")
  .compile();

const result = await workflow.invoke({
  question: "How many users are there?",
});

console.log(result.state.answer);
```

For the smallest possible workflow, options are optional. Core injects runtime fields such as `threadId`, `runId`, `sessionId`, `messages`, `previousSteps`, `interrupt`, `memory`, and `context` when execution begins. A developer does not need a duplicate `stateDefaults` object or a required actor, policy, checkpoint, or provider object for every invocation.

```ts
import { createWorkflow } from "@langgraph-toolkit/core";

const health = createWorkflow("health")
  .node("ready", () => ({ status: "ready" }))
  .start("ready")
  .compile();

const result = await health.invoke({});
```

## State behavior without a second configuration layer

Pass state behavior to `createState(fields, options?)`. Reducers define merge behavior, derived fields run after each update, and validation protects invalid transitions. History, snapshots, and recovery metadata stay with the state descriptor for compatible executors and checkpointers.

```ts
import {
  createState,
  createWorkflow,
} from "@langgraph-toolkit/core";

const state = createState(
  {
    items: [] as string[],
    total: 0,
  },
  {
    reducers: {
      items: (current, incoming) => [...current, ...incoming],
    },
    derived: {
      total: current => current.items.length,
    },
    validate: true,
    history: true,
    snapshots: true,
    recovery: true,
  },
);

const workflow = createWorkflow("collect-items", { state })
  .node("collect", () => ({ items: ["one", "two"] }))
  .start("collect")
  .compile();
```

## Compile once, invoke and resume deliberately

`.compile()` is the canonical lifecycle boundary. It validates the topology and returns a runnable compiled workflow. `.invoke()` executes it; `.resume()` continues a matching interrupted thread. `.build()` and `.run()` remain compatibility aliases for existing integrations and are not the recommended onboarding path.

```ts
const workflow = createWorkflow("review", {
  state: createState({ draft: "", approved: false }),
})
  .node("draft", () => ({ draft: "Prepared for review" }))
  .start("draft")
  .interrupt({ after: ["draft"] })
  .compile();

const first = await workflow.invoke({}, { threadId: "review-42" });

if (first.interrupted) {
  const resumed = await workflow.resume("review-42", {
    approved: true,
  });
  console.log(resumed.state.draft);
}
```

Node labels and edge labels become stream metadata. Use `workflow.stream(input, options)` when a host needs steps, token chunks, reasoning, tool activity, intent, interrupts, or completion events.

## Scale from a linear workflow to explicit topology

The fluent surface is additive. Start with nodes and a linear path, then add the controls that express a real
requirement. Controls fall into two classes: **live** controls lower into real topology or runtime behavior, and *
*planned** controls fail fast with a `GraphDefinitionError` that names the supported alternative.

**Live controls — lower to topology or runtime:**

| Control                                                                  | What it does                                                                                                                             |
|--------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `.node()`, `.edge()`, `.start()`                                         | Register named nodes, labeled transitions, and the entry point                                                                           |
| `.conditional()`, `.router()`, `.route()`                                | Bounded branching; `.route()` picks a target from a declared state field                                                                 |
| `.fanout()`, `.converge()`, `.dynamicFanout()`                           | Collection fan-out, declared convergence cycles, and data-driven fan-out                                                                 |
| `.parallel()`, `.join()`                                                 | Independent named branches and a convergence barrier (barrier-correct, sequentially interleaved; true concurrency is tracked separately) |
| `.loop()`, `.onError()`                                                  | Bounded repeat routes and error routing                                                                                                  |
| `.interrupt()`, `.interruptBefore()`, `.interruptAfter()`, `.approval()` | Human-in-the-loop pauses and approval gates                                                                                              |
| `.retry()`, `.fallback()`, `.guard()`                                    | Resilience, recovery, and pre-node policy checks                                                                                         |
| `.map()`, `.reduce()` (string form)                                      | Collection work over a state field                                                                                                       |
| `.subgraph()`, `.nestedGraph()`, `.dynamicGraph()`                       | Reusable and composed graphs                                                                                                             |
| `.checkpoint()`                                                          | Durable continuation backed by an injected checkpointer                                                                                  |
| `.plan()`                                                                | Declarative `PlanSpec` (model tier + target field) consumed by the executor                                                              |

**Planned controls — throw `GraphDefinitionError` with the supported alternative:**

| Control                            | Suggested alternative                               |
|------------------------------------|-----------------------------------------------------|
| `.rag()`                           | `.subgraph()` to compose a retrieval pipeline       |
| `.supervisor()`                    | `.conditional()` + `.join()` to orchestrate agents  |
| `.reflect()`                       | A critique node with `.guard()` or `.loop()`        |
| `.replan()`                        | `.plan()` with `.loop()`                            |
| `.evaluate()`                      | A scoring node directly                             |
| `.remember()`                      | `.checkpoint()` for state persistence               |
| `.transaction()`                   | `.checkpoint()` for rollback support                |
| `.subgraph()` without a graph      | `.subgraph(name, graph)` with a compiled graph      |
| `.map()` / `.reduce()` object form | `.map(field, nodeName)` / `.reduce(field, reducer)` |

`createGraph(options)` exposes the same builder contract for advanced workflow topology. It is the right choice when named entry points, routes, joins, fan-out, loops, or graph composition are central to the resource design.

```ts
import {
  createGraph,
  createState,
} from "@langgraph-toolkit/core";

const graph = createGraph({
  name: "two-step",
  state: createState({ value: "", result: "" }),
})
  .node("normalize", current => ({ value: current.value.trim() }))
  .node("finish", current => ({ result: current.value.toUpperCase() }))
  .start("normalize")
  .edge("normalize", "finish", "normalized")
  .compile();
```

## Package boundaries

| Package | Owns | Use it when |
| --- | --- | --- |
| `@langgraph-toolkit/core` | State, workflow topology, nodes, edges, streams, interrupts, schemas, tools, intent, gates, generic model contracts | Every workflow |
| `@langgraph-toolkit/mcp` | MCP declarations, async credentials, discovery, typed tools, server lifecycle | A graph needs MCP tools, resources, or prompts |
| `@langgraph-toolkit/community` | Provider integrations, model pools, RAG and community use cases | A workflow needs a contributed provider or retrieval integration |
| `@langgraph-toolkit/adapter-checkpointers` | Redis and persistence implementations, history, restore and fork | State must survive the process lifecycle |
| Framework adapters | Request parsing, streaming responses, dependency lifecycle | Mounting a compiled workflow in Express, Fastify, NestJS, or StruxJS |

Core owns `autoModel`, `autoMemory`, `autoCache`, `autoGuardrails`, `autoReliability`, `autoObservability`, and `autoEvaluation`. The persistence adapter owns `autoCheckpoint`; Community owns `autoRag`. This separation keeps a base Core install independent of provider and storage dependencies.

## Advanced and migration imports

The Core root contains the canonical 0.2.0 facade. Exact definition-style primitives are intentionally separate:

| Import | Purpose |
| --- | --- |
| `@langgraph-toolkit/core` | Canonical `create*` facade and public contracts |
| `@langgraph-toolkit/core/low-level` | Explicit `defineGraph`, `defineState`, `node`, `edge`, `conditional`, and `buildGraph` primitives |
| `@langgraph-toolkit/core/legacy` | Compatibility alias for an incremental migration from the older DSL |
| `@langgraph-toolkit/core/runtime` | Optional execution and streaming helpers |

Do not import low-level DSL helpers from the Core root in new application code. This keeps common code short while retaining exact primitives for advanced integrations.

## Development

```bash
npm install
npm run build
npm test
```

Contributors should add a focused regression test for every public behavior change. Preserve framework portability, prefer inference over a new required option, and keep host-specific lifecycle code inside the relevant adapter.

## License

MIT
