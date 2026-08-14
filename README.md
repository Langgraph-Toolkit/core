# @langgraph-toolkit/core

**Configure the graph once. Run the same typed resource anywhere.** Core is a framework-agnostic TypeScript runtime for workflows, agents, background jobs, data pipelines, approval flows, classifiers, and any process that benefits from explicit state transitions. It does not import Express, Fastify, NestJS, StruxJS, MCP, or a model vendor.

## Install the smallest useful surface

```bash
npm install @langgraph-toolkit/core
```

Core is independently installable. Add an MCP package, provider package, checkpointer, or framework adapter only when the resource needs that boundary.

## The zero-config path

The normal path declares a state descriptor and a named node object. Core infers the state shape and initial values from `defineState`, accepts plain functions as nodes, creates linear edges when `edges` is omitted, and keeps runtime defaults on the graph. `buildGraph` compiles and attaches the executor in one call, so a run receives business input instead of repeating infrastructure configuration.

```ts
import {
  buildGraph,
  defineGraph,
  defineState,
} from "@langgraph-toolkit/core";

const state = defineState({
  question: "",
  answer: "",
});

const graph = buildGraph(
  defineGraph({
    name: "database-chat",
    state,
    nodes: {
      lookup: async (current) => ({
        answer: `Received: ${current.question}`,
      }),
    },
  }),
);

const result = await graph.run({ question: "How many users are there?" });
console.log(result.state.answer);
```

The smallest valid graph has no `stateDefaults`, no `never`, no mandatory per-run actor, policy, checkpoint, or provider object, and no framework-specific host code.

## Reuse inferred contracts instead of repeating state types

When a graph grows beyond a single inline node, derive its state type from the descriptor. `StateOf` keeps node input and output code synchronized with the descriptor, so a field is declared once.

```ts
import { StateOf, defineState } from "@langgraph-toolkit/core";

const chatState = defineState({ question: "", context: "", answer: "" });
type ChatState = StateOf<typeof chatState>;

const answer = async (current: ChatState): Promise<Partial<ChatState>> => ({
  answer: `Question: ${current.question}\nContext: ${current.context}`,
});
```

For model-backed nodes, `streamChatNode` owns the repeated thinking, token, reasoning, usage, cancellation, and final-answer event handling. Use a plain `answer` function only when the graph deliberately needs custom model orchestration.

```ts
import { streamChatNode } from "@langgraph-toolkit/core";

const answer = streamChatNode({
  system: "Answer only from the supplied context.",
  messages: (current: ChatState) => [
    { role: "user", content: `${current.question}\n\n${current.context}` },
  ],
  select: (current: ChatState, text: string) => ({ answer: text }),
});
```

## Configure once, override only when needed

Graph-level runtime options are inherited by `run` and `stream`. Optional run overrides remain available for request-specific values such as a thread identifier or a human answer.

| Concern | Default location | Per-run override |
|---|---|---|
| State shape and initial values | `defineState({...})` | No repeated declaration |
| Node order | `nodes: { ... }` | Use explicit `edges` only for branches or labels |
| Checkpoint | `defineGraph({ runtime: { checkpoint } })` | Override only for a special execution |
| Actor and permission | Graph runtime or host context | Override for a request when required |
| Provider and model tier | Community or application runtime | Override for an intentional routing decision |
| Variables and global values | `variables` and `global` on the graph | Supply request-specific values when needed |

```ts
const graph = buildGraph(
  defineGraph({
    name: "database-chat",
    state,
    nodes: {
      lookup,
      answer,
    },
    runtime: {
      checkpoint: checkpointStore,
      actor: actorFromRequest,
      policy: databaseReaderPolicy,
      tokenBudget: { limit: 20_000, windowMs: 3_600_000 },
      variables: { source: "database-chat" },
    },
  }),
);

const result = await graph.run({ question: "count users" });
const events = graph.stream({ question: "count users" });
const resumed = await graph.run(
  { question: "count users" },
  { threadId: "conversation-1", humanResponse: { approved: true, note: null } },
);
```

## Start small, add explicit structure only where it adds meaning

The inferred path is not a reduced API. It is a short form of the same typed contracts. Add named node bindings when a node needs a model tier, risk classification, tool list, intent analyzer, or step label. Add explicit edges when the workflow branches, loops, or needs labels in the stream.

```ts
import { conditional, defineGraph, edge, gate, node } from "@langgraph-toolkit/core";

const approval = gate("database-answer-approval", async (current) =>
  current.answer === undefined
    ? { kind: "deny", reason: "No answer exists to approve." }
    : { kind: "allow" },
);

const definition = defineGraph({
  name: "approval-flow",
  state,
  nodes: {
    draft: node(draftNode, { tier: "cheap", stepLabel: "Draft answer" }),
    approve: node(approvalNode, { gate: approval, stepLabel: "Review answer" }),
    respond: respondNode,
  },
  edges: [
    edge("draft", "approve", "prepare"),
    conditional("approve", routeAfterApproval, ["respond", "END"]),
  ],
});

const approvalGraph = buildGraph(definition);
```

## One graph, many backend hosts

Core owns the graph contract, not the transport lifecycle. The same compiled resource can be mounted by an Express router, Fastify plugin, NestJS module, StruxJS provider, a worker, or a custom HTTP server.

| Layer | Owns | Does not own |
|---|---|---|
| Core | State, nodes, edges, gates, interrupts, variables, runtime contracts, typed events | HTTP server or vendor SDK |
| MCP | Gateway, discovery, tools, async credentials, resource errors | Framework lifecycle or business graph semantics |
| Community | Providers, model inference, built-in use cases, contributor integrations | Core execution or HTTP routing |
| Adapter | Framework registration, request parsing, streaming, response lifecycle | Database schema or prompt policy |
| Checkpointers | Persistence drivers for SQLite, PostgreSQL, MySQL, MongoDB, and Redis | Graph topology or actor decisions |

This boundary is the main portability guarantee. A host can change without moving business workflow code into a framework-specific folder.

## Public building blocks

| Area | Main API | Why it exists |
|---|---|---|
| State | `defineState`, `reducedValue`, `messagesValue` | Infer state shape and merge behavior |
| Graph | `defineGraph`, `buildGraph`, `compile` | Define, validate, and create a runnable graph |
| Execution | `graph.run`, `graph.stream` | Run or stream typed step, tool, token, thinking, and interrupt events |
| Control flow | `edge`, `conditional`, `gate`, `interruptBefore` | Express branches, approvals, and human-in-the-loop behavior |
| Safety | actors, policies, tiers, token budgets, risk harness | Bound permission and cost decisions |
| Persistence | `Checkpointer` contract | Attach a database without coupling core to a driver |
| Extensibility | model, tool, intent, and queue contracts | Add providers and use cases without changing the runtime |

## Development

```bash
npm install
npm run build
npm test
```

Contributors should add one focused regression test for each public contract change. Keep graph code portable, keep host code thin, and prefer an inferred default over a new required option.

## License

MIT
