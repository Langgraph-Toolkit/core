# Changelog

## 0.1.0

Initial release of the framework-agnostic @langgraph/toolkit monorepo.

### Core (@langgraph/toolkit)
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
- @langgraph/adapter-struxjs: ServiceProvider, agent scanner, Strux checkpointer, SSE reply writer
- @langgraph/adapter-express: SSE middleware + router (`/run`, `/stream`)
- @langgraph/adapter-fastify: plugin + `decorateLangGraph()`
- @langgraph/adapter-nestjs: DynamicModule + Injectable `LangGraphService`

### Database adapters (@langgraph/adapter-checkpointers)
- `SqlCheckpointer` (SQLite/Postgres/MySQL) with `makeSyncSqlDriver`
- `RedisCheckpointer`, `MongoCheckpointer`
- Driver injection pattern: zero database dependencies at build time
