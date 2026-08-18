# Changelog

## Unreleased

### Fluent `GraphBuilder` — silent stubs now fail fast

The fluent builder previously accepted several controls (`.rag()`, `.supervisor()`,
`.reflect()`, `.replan()`, `.evaluate()`, `.remember()`, `.transaction()`, plus the
`map()`/`reduce()` object forms and a bare `.subgraph(name)`) that wrote to a dead
`controls` map and did nothing. They now throw a `GraphDefinitionError` naming the
supported alternative, so a broken topology is caught at build time instead of being
silently dropped.

### New real controls

- `.route(routes, { field })` — lowers to a bounded `conditional()` edge keyed on a
  declared state field. The selector field is required (no silent default).
- `.parallel(participants, { into })` — registers each branch as a real node, emits
  fan-out + convergence edges, and adds a `JoinSpec` barrier at the join target.
  Barrier-correct with sequential interleaving; true concurrency is tracked separately.
- `.plan(options)` — writes a declarative `PlanSpec` (`{ tier?, produce, into }`) onto
  the `GraphDefinition`. The executor resolves the tier through the run's
  `ModelRegistry`, calls `model.chat()` with a JSON-array-of-strings contract, and
  merges the result into `state[plan.into]`. Throws `GraphDefinitionError` if no tier
  is bound; skipped on resumed threads. Compile-time validation ensures `plan.into` is
  a declared state key.

### Type and contract alignment

- `PlanSpec` added to `GraphDefinition`; `LLMSession` now `extends Pick<LLMProvider, "chat">`.
- `Model` documented as the `LLMProvider` superset (`.generate()` wraps `.chat()`,
  `.structured()` adds schema-constrained output).

### Checkpointer

- `createMemoryCheckpointer` exported from the core barrel as the canonical in-process
  implementation. Downstream packages re-export it instead of carrying their own copy
  (removes a `createdAt` sort-tie bug that could re-trigger approval on resume for
  same-millisecond checkpoints).

### Tests & docs

- `fluent-contract.test.ts` split into real-behavior, fail-fast, and preserved-passing
  groups; adds same-millisecond checkpoint-tie and approval-resume regressions.
- README rewritten with a Live / Planned support matrix.

## 0.1.0

Initial release of the framework-agnostic @langgraph-toolkit/core monorepo.

### Core (@langgraph-toolkit/core)
- `defineGraph()` DSL: state reducers, nodes, edges, conditional routing, converge, safety
- `compile()` rule enforcement: named graphs/nodes, declared state, first-class edges, deterministic routing, cycle convergence (L1), runaway bounds (L2), verifier anchors (E3)
- Executor: `run()` / `stream()` SSE, human-in-the-loop (`interruptBefore` + checkpoint + `resumeFrom` + `humanResponse`), cancellation, timeouts
- Permission system: `Actor`, `RunPolicy`, `rolePolicy`, `combinePolicies`, `TierResolver`, `planTierResolver`, `ctx.actor`
- Cost control: `TokenBudget`, `withTokenBudget`, `TokenBudgetExceededError`, per-actor-tier charging
- Node risk classes: `tier()` / `risk()` node bindings, dangerous nodes auto-interrupt
- Risk harness: `testEdgeRisk()` probes a compiled graph for policy/tier/budget violations
- E2E harness for contributors: `e2eRun`, `e2eStream`, `expectDone`, `expectInterrupted`, `expectTerminal`, `e2eScenarioResume`, `e2eActor`
- Providers: `ToolkitModelRegistry`, `MockProvider`, `HuggingFaceProvider`, `OpenAiCompatibleProvider`
- Verifiers: `codeAnchor`, `testAnchor`, `verifyOrThrow`, non-LLM anchor requirement
- Queue dispatch: `registerQueueAdapter`, `dispatchToQueue`, `createGraphRunnerWorker`
- `MemoryCheckpointer`

### Host adapters
- @langgraph-toolkit/adapter-struxjs: ServiceProvider, agent scanner, Strux checkpointer, SSE reply writer
- @langgraph-toolkit/adapter-express: SSE middleware + router (`/run`, `/stream`)
- @langgraph-toolkit/adapter-fastify: plugin + `decorateLangGraph()`
- @langgraph-toolkit/adapter-nestjs: DynamicModule + Injectable `LangGraphService`

### Database adapters (@langgraph-toolkit/adapter-checkpointers)
- `SqlCheckpointer` (SQLite/Postgres/MySQL) with `makeSyncSqlDriver`
- `RedisCheckpointer`, `MongoCheckpointer`
- Driver injection pattern: zero database dependencies at build time
