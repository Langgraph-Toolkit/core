/**
 * @langgraph-toolkit/core
 *
 * The framework-agnostic graph vocabulary. This root barrel contains the
 * canonical 0.2 API; the former definition DSL is available from `/legacy`.
 *
 * @example
 * ```ts
 * import { createWorkflow, createState, createNode } from "@langgraph-toolkit/core";
 * ```
 */

/** Core-owned zero-config capability facades. */
export { autoModel, autoMemory, autoCache, autoGuardrails, autoReliability, autoObservability, autoEvaluation } from "./auto.js";
export type { AutoModelOptions } from "./auto.js";

/** Canonical inference-first graph facades from the target API. */
export {
  createGraph,
  createWorkflow,
  createState,
  createTool,
  createNode,
  createEdge,
  createRoute,
  createSubgraph,
  composeWorkflows,
  createSchema,
  createSafety,
  createStepLabel,
  createRisk,
  createTier,
} from "./graph-api.js";

/** Schema builder for typed state, tool inputs and structured model outputs. */
export { schema } from "./schema.js";
export type { SchemaValue, SchemaShape, InferSchemaShape } from "./schema.js";
export { intentAnalyzer } from "./defineGraph.js";

/** Graph builder contracts for inference-first workflow composition. */
export type {
  GraphBuilder,
  GraphOptions,
  StateFieldMap,
  RouteDefinition,
  DynamicFanoutRoute,
  LoopRoute,
  ErrorRoute,
  StateReducer,
  CompileOptions,
  NodeOptions,
  WorkflowOptions,
  FluentCallable,
  ApprovalOptions,
  CheckpointSource,
  RetryOptions,
  FallbackOptions,
  ParallelOptions,
  MapOptions,
  ReduceOptions,
  RouteMap,
  InterruptOptions,
  TransactionOptions,
} from "./graph-api.js";

/** Stable graph and execution errors. */
export {
  ToolkitError,
  GraphDefinitionError,
  CompileRuleViolationError,
  GraphRuntimeError,
  ModelProviderNotConfiguredError,
  SafetyLimitExceededError,
  CancelledError,
  PermissionDeniedError,
  TokenBudgetExceededError,
} from "./types.js";

/** Public graph, state, model, tool, interrupt, and stream contracts. */
export type {
  GraphDefinition,
  CompiledGraph,
  NodeLike,
  NodeFunction,
  NodeSpec,
  NodeContext,
  NodeAgent,
  NodeAgentResult,
  StateDescriptor,
  StateSchema,
  StateField,
  StateFieldInput,
  StateOptions,
  StateValueReducer,
  FrameworkState,
  ReducedField,
  MessagesField,
  StateOf,
  InputOf,
  EdgeSpec,
  ConditionalEdgeSpec,
  ConditionalRouteFn,
  ConvergeSpec,
  SafetySpec,
  InterruptSpec,
  InterruptMode,
  InterruptRequest,
  PendingInterrupt,
  Gate,
  GateDecision,
  GateContext,
  ToolDefinition,
  ToolContext,
  IntentClassifier,
  IntentContext,
  IntentAnalyzer,
  IntentClassification,
  IntentAnalysis,
  IntentSpec,
  StepDescriptor,
  GraphContracts,
  DefaultGraphContracts,
  GraphSchemas,
  RunOptions,
  RunResult,
  StepEvent,
  Checkpoint,
  Checkpointer,
  CancellationSource,
  Actor,
  JsonPrimitive,
  JsonValue,
  JsonObject,
  ValueSchema,
  StateSchemaValue,
  ChatMessage,
  ChatResult,
  ChatStreamChunk,
  ChatStreamOptions,
  LLMProvider,
  LLMSession,
  LLMProviderConfig,
  ModelRegistry,
  ModelToolCall,
  ModelToolSpec,
  ModelToolChoice,
  ResponseFormat,
  TokenUsage,
  ReasoningEffort,
} from "./types.js";

/** Model facades and multimodal contracts. */
export {
  createModel,
  createModelPool,
  createEmbeddingModel,
  createSpeechModel,
  modelUsage,
} from "./model-api.js";

/** Generic agent, supervisor, bus, memory and context facades. */
export {
  createAgent,
  createSupervisor,
  createAgentBus,
  createMemory,
  createContextManager,
} from "./agent-api.js";

/** Model contracts. */
export type {
  Model,
  ModelOptions,
  ModelRequest,
  ModelResponse,
  ModelChunk,
  StructuredModel,
  EmbeddingModel,
  EmbeddingModelOptions,
  EmbeddingOptions,
  EmbeddingResult,
  SpeechModel,
  ModelPool,
  ModelPoolOptions,
  SpeechInput,
  SpeechText,
  SpeechOptions,
  SpeechResult,
  SpeechAudio,
} from "./model-api.js";

/** Agent, supervisor, bus, memory and context contracts. */
export type {
  Agent,
  AgentOptions,
  AgentTool,
  AgentToolSource,
  AgentTextOutput,
  AgentResult,
  AgentEvent,
  AgentRunOptions,
  Supervisor,
  SupervisorOptions,
  SupervisorPlan,
  SupervisorTask,
  AgentBus,
  AgentBusOptions,
  AgentMessage,
  AgentSubscriber,
  Memory,
  MemoryOptions,
  MemoryRecord,
  ContextManager,
  ContextOptions,
} from "./agent-api.js";

/** Reasoning, intent planning and reflection contracts. */
export { createReasoning } from "./reasoning-api.js";
export type {
  Reasoning,
  ReasoningOptions,
  ReasoningRunOptions,
  ReasoningTask,
  ReasoningDependency,
  ReasoningPlan,
  ReasoningResult,
  AdvancedReasoningOptions,
  DependencyGraph,
} from "./reasoning-api.js";
export { createReflection, reflectionCheck } from "./reflection-api.js";
export type { Reflection, ReflectionOptions, ReflectionCandidate, ReflectionResult, ReflectionCheck } from "./reflection-api.js";

/** Guardrails and risk classification contracts. */
export { createGuardrails } from "./safety-api.js";
export type { Guardrails, GuardrailOptions, GuardrailCheck, GuardrailResult, RiskLevel } from "./safety-api.js";

/** Reliability, cache, streaming, observability, evaluation and execution facades. */
export { createReliability, createCache, createStreaming, createObservability, createEvaluation, createExecutionRuntime } from "./runtime-features.js";
export type {
  Reliability,
  ReliabilityOptions,
  RecoveryResult,
  TransactionStep,
  Cache,
  CacheOptions,
  CacheSetOptions,
  Streaming,
  StreamingOptions,
  Observability,
  ObservabilityOptions,
  TraceSpan,
  TraceRecord,
  Evaluation,
  EvaluationOptions,
  EvaluationCase,
  EvaluationResult,
  EvaluationReport,
  ExecutionRuntime,
  ExecutionRuntimeOptions,
} from "./runtime-features.js";

/** Tool registry and multi-tool orchestration contracts. */
export { createToolRegistry } from "./tool-api.js";
export type { ToolRegistry, ToolPlanStep, ToolApproval } from "./tool-api.js";
