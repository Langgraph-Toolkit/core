/**
 * @langgraph-toolkit/core
 *
 * Framework-agnostic LangGraph toolkit. Define graphs once, run them on
 * Express, Fastify, NestJS, StruxJS, or a plain queue worker with zero
 * changes to the graph code.
 *
 * Quick start:
 *
 *   import { defineGraph, buildGraph,
 *            messagesValue, safety, MemoryCheckpointer, ToolkitModelRegistry }
 *     from "@langgraph-toolkit/core";
 *
 *   const def = defineGraph({ name, state, nodes, entry, edges, safety, ... });
 *   const graph = buildGraph(def);
 *   await graph.run(input, { threadId: "t1", checkpoint: new MemoryCheckpointer() });
 */

// DSL
export { defineGraph, defineState, node, edge, conditional, converge, safety, tier, stepLabel, schema, gate, tool, intent, intentAnalyzer } from "./defineGraph.js";

// Compiler + executor
export { compile } from "./compile.js";
export { attachExecutor, buildGraph, execute, streamEvents } from "./executor.js";
export { streamChatNode } from "./chat-node.js";

// Registry (used by host adapters)
export { GraphRegistry } from "./registry.js";
export { ToolkitRuntime, createToolkitRuntime } from "./runtime.js";
export type { ToolkitRuntimeConfigurator, ToolkitRuntimeOptions } from "./runtime.js";

// State values / reducers
export { messagesValue, reducedValue, isReducedField } from "./types.js";

// Checkpointers
export { MemoryCheckpointer } from "./checkpoint-memory.js";

// Model registry + providers
export {
  ToolkitModelRegistry,
  defaultProviderFactory,
  OpenAiCompatibleProvider,
  HuggingFaceProvider,
  MockProvider,
} from "./providers.js";

// Policy helpers (Rules A1/A2/A4)
export { rolePolicy, combinePolicies, planTierResolver } from "./providers.js";
export { withTokenBudget, resetTokenLedger } from "./executor.js";

// Risk harness: probe graphs for edge risk before production
export { testEdgeRisk } from "./risk.js";
export type { RiskProbeOptions, RiskProbeResult, RiskViolation } from "./risk.js";

// Verification (Rule E3)
export {
  runVerifiers,
  verifyOrThrow,
  validateVerifiers,
  hasNonLlmAnchor,
  codeAnchor,
  testAnchor,
} from "./verify.js";

// Queue dispatch (host-agnostic)
export {
  dispatchToQueue,
  registerQueueAdapter,
  getQueueAdapter,
  createGraphRunnerWorker,
} from "./queue.js";

// Cancellation (Rule L2)
export { createCancellationSource } from "./types.js";

// E2E testing harness for contributors
export {
  e2eRun,
  e2eStream,
  e2eActor,
  e2eScenarioResume,
  expectDone,
  expectInterrupted,
  expectTerminal,
} from "./e2e.js";
export type { E2eRunRequest, E2eRunResponse, ParsedSseEvent } from "./e2e.js";

// Errors
export {
  ToolkitError,
  GraphDefinitionError,
  CompileRuleViolationError,
  GraphRuntimeError,
  SafetyLimitExceededError,
  CancelledError,
  PermissionDeniedError,
  TokenBudgetExceededError,
} from "./types.js";

// Types (re-export for consumers)
export type {
  GraphDefinition,
  CompiledGraph,
  NodeLike,
  StateDescriptor,
  NodeFunction,
  NodeSpec,
  EdgeSpec,
  ConditionalEdgeSpec,
  ConditionalRouteFn,
  ConvergeSpec,
  SafetySpec,
  InterruptSpec,
  InterruptMode,
  RunOptions,
  RunResult,
  StepEvent,
  Checkpoint,
  Checkpointer,
  CancellationSource,
  ChatMessage,
  ChatResult,
  LLMProvider,
  LLMProviderConfig,
  LLMSession,
  ModelRegistry,
  VerifierResult,
  VerifierFn,
  VerifySpec,
  NodeContext,
  IntentAnalyzer,
  IntentClassification,
  IntentAnalysis,
  QueuedJob,
  QueueAdapter,
  ReducedField,
  MessagesField,
  TierAlias,
  Actor,
  NodeRiskClass,
  PolicyDecision,
  RunPolicy,
  TierResolver,
  TokenBudget,
  TokenBudgetSpec,
  JsonPrimitive,
  JsonValue,
  JsonObject,
  ValueSchema,
  StateSchema,
  StateField,
  GraphContracts,
  DefaultGraphContracts,
  GraphRuntimeOptions,
  GraphSchemas,
  Gate,
  GateDecision,
  GateContext,
  ToolDefinition,
  ToolContext,
  IntentClassifier,
  IntentContext,
  IntentSpec,
  InterruptRequest,
  PendingInterrupt,
  StepDescriptor,
  StateOf,
  InputOf,
} from "./types.js";
export type { StreamChatNodeOptions } from "./chat-node.js";
