# @langgraph-toolkit/core

Pure TypeScript graph runtime for workflows, agents, background jobs, data pipelines, and framework adapters. The package has no dependency on Express, Fastify, NestJS, StruxJS, MCP, or a model vendor.

## Install

```bash
npm install @langgraph-toolkit/core
```

The package is independently installable. Install a framework adapter, MCP package, provider package, or checkpointer only when the application needs that capability.

## Zero-config graph

`defineState` infers the state type from the descriptor object. A node can be a plain function. When nodes are listed in order, the graph creates linear edges automatically. Runtime defaults belong to the graph definition, so a normal `run` call only needs input.

```ts
import {
  compileGraph,
  defineGraph,
  defineState,
  reducedValue,
} from "@langgraph-toolkit/core";

const state = defineState({
  question: "",
  answer: "",
  rows: reducedValue<readonly string[]>([], (current, next) => [...current, ...next]),
});

const graph = compileGraph(
  defineGraph({
    name: "database-chat",
    state,
    nodes: [
      (input) => ({ question: input.question.trim() }),
      (input) => ({ answer: `Question received: ${input.question}` }),
    ],
    runtime: {
      checkpoint: checkpointStore,
      actor: () => ({ id: "system", roles: ["reader"] }),
      policy: readerPolicy,
      variables: { source: "database-chat" },
    },
  }),
);

const result = await graph.run({ question: "How many users are there?" });
console.log(result.answer);
```

The explicit form remains available when a graph needs named nodes, branches, labels, reducers, or typed gates.

```ts
const graph = compileGraph(
  defineGraph({
    name: "approval-flow",
    state,
    nodes: {
      draft: draftNode,
      approve: approveNode,
      respond: respondNode,
    },
    edges: [
      { from: "draft", to: "approve", label: "prepare" },
      { from: "approve", to: "respond", label: "approved" },
    ],
    runtime: { checkpoint: checkpointStore },
  }),
);
```

## Runtime defaults and overrides

Graph-level runtime values are inherited by `run` and `stream`. A request may override a value for one execution, but the common path stays short.

```ts
const result = await graph.run({ question: "count users" });
const events = graph.stream({ question: "count users" });
const resumed = await graph.run(
  { question: "count users" },
  { threadId: "conversation-1", humanResponse: { approved: true } },
);
```

Supported runtime values include checkpoint storage, actor resolution, policy, model selection, token budget, global variables, cancellation, and interrupt handling. These values are plain contracts and do not import a host framework.

## Public building blocks

| Area | Main API | Purpose |
|---|---|---|
| State | `defineState`, `reducedValue`, `messagesValue` | Infer state shape and merge behavior |
| Graph | `defineGraph`, `compileGraph` | Define and validate workflow topology |
| Execution | `graph.run`, `graph.stream` | Execute or stream typed graph events |
| Control flow | `interrupt`, `gate`, conditional edges | Human approval and typed routing |
| Registry | `GraphRegistry` | Register independent graphs for adapters |
| Safety | policies, actors, token budgets, risk harness | Enforce permissions and cost limits |
| Persistence | `Checkpointer` contract | Connect SQLite, PostgreSQL, MySQL, MongoDB, or Redis adapters |
| Extensibility | model and queue contracts | Connect hosted models, Hugging Face, OpenAI-compatible endpoints, and workers |

## Checkpoint configuration

Checkpoint configuration is normally attached once at graph construction. A request only supplies a thread identifier when the graph is resumed.

```ts
const graph = compileGraph(
  defineGraph({
    name: "database-chat",
    state,
    nodes,
    runtime: { checkpoint: checkpointStore },
  }),
);

await graph.run({ question: "count users" }, { threadId: "user-42" });
```

Use `@langgraph-toolkit/adapter-checkpointers` for concrete drivers. Core only defines the stable contract, which keeps the package framework agnostic.

## Permissions and cost control

Actors, policies, tier resolution, and token budgets are graph runtime contracts. They are not required arguments for every request when configured at graph level.

```ts
const graph = compileGraph(
  defineGraph({
    name: "database-chat",
    state,
    nodes,
    runtime: {
      actor: requestActor,
      policy: databaseReaderPolicy,
      tokenBudget: { limit: 20_000, windowMs: 3_600_000 },
    },
  }),
);
```

Use the risk harness and contributor E2E contracts to verify denied actors, tier escalation, budget exhaustion, interrupt behavior, and checkpoint resume before publishing an adapter or provider.

## Package boundary

Core does not import MCP or community providers. MCP depends on core because an MCP agent is a graph composition. A gateway or transport integration can remain outside core and be injected through a typed contract. Adapters depend on core only, unless their own framework requires another package.

```text
core
├── MCP agent package
├── community providers
├── Express, Fastify, NestJS, and StruxJS adapters
└── checkpoint adapters
```

This dependency direction lets an application use core alone, MCP without community providers, or one adapter without installing the other framework adapters.

## Development

```bash
npm install
npm run build
npm test
```

Before opening a pull request, add a focused regression test for every public contract change. Keep implementation modules small, export one cohesive concept per file, and preserve the no-host-dependency rule for core.

## License

MIT
