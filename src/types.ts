/** Core public contracts for @langgraph-toolkit/core. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export class ToolkitError extends Error {
  constructor(message: string, public code: string) { super(message); this.name = "ToolkitError"; }
}
export class GraphDefinitionError extends ToolkitError {
  constructor(message: string) { super(message, "GRAPH_DEFINITION_ERROR"); this.name = "GraphDefinitionError"; }
}
export class CompileRuleViolationError extends GraphDefinitionError {
  constructor(message: string, public rule: string, public details: JsonObject = {}) { super(`[Rule ${rule}] ${message}`); this.name = "CompileRuleViolationError"; }
}
export class GraphRuntimeError extends ToolkitError {
  constructor(message: string, public cause?: Error) { super(message, "GRAPH_RUNTIME_ERROR"); this.name = "GraphRuntimeError"; }
}
export class ModelProviderNotConfiguredError extends GraphRuntimeError {
  constructor() {
    super("No model provider is configured. Register a provider or pass one to autoModel().");
    this.name = "ModelProviderNotConfiguredError";
  }
}
export class SafetyLimitExceededError extends GraphRuntimeError {
  constructor(limit: string) { super(`Safety limit exceeded: ${limit}`, new Error(limit)); this.name = "SafetyLimitExceededError"; }
}
export class CancelledError extends ToolkitError {
  constructor(public threadId?: string) { super(`Graph run cancelled${threadId ? ` (thread ${threadId})` : ""}`, "CANCELLED"); this.name = "CancelledError"; }
}
export class PermissionDeniedError extends ToolkitError {
  constructor(message: string, public actor?: Actor, public graph?: string) { super(message, "PERMISSION_DENIED"); this.name = "PermissionDeniedError"; }
}
export class TokenBudgetExceededError extends GraphRuntimeError {
  constructor(public tier: string, public budget: number) { super(`Token budget exceeded for tier "${tier}" (limit ${budget})`, new Error(tier)); this.name = "TokenBudgetExceededError"; }
}
export class InterruptSignal<TInterrupt extends JsonValue = JsonValue> extends Error {
  constructor(public request: InterruptRequest<TInterrupt>) { super(request.reason ?? "Graph execution requires human input."); this.name = "InterruptSignal"; }
}

export interface ValueSchema<T> { readonly name: string; parse(value: JsonValue): T; }
export function createSchema<T>(name: string, parse: (value: JsonValue) => T): ValueSchema<T> { return { name, parse }; }

export interface ReducedField<T> { readonly __reduced: true; readonly default: T; readonly reducer: (prev: T, next: T) => T; }
export type StateField<T> = ReducedField<T> | T;
export type StateSchema<TState extends object> = { [K in keyof TState]: StateField<TState[K]> };
/** A state schema carrying the initial values inferred from each field descriptor. */
export interface StateDescriptor<TState extends object> {
  readonly __stateDescriptor: true;
  readonly fields: StateSchema<TState>;
  readonly defaults: Partial<TState>;
  readonly options?: StateOptions<TState>;
}
/** Reducer modes supported by inference-first state declarations. */
export type StateValueReducer<TValue> = "append" | "merge" | ((previous: TValue, next: TValue) => TValue);
/** Declarative behavior attached to a state descriptor. */
export interface StateOptions<TState extends object> {
  readonly immutable?: boolean;
  readonly reducers?: Readonly<Partial<{ [K in keyof TState]: StateValueReducer<TState[K]> }>>;
  readonly derived?: Readonly<Record<string, (state: Readonly<TState>) => JsonValue>>;
  readonly validate?: boolean | ((state: Readonly<TState>) => boolean);
  readonly history?: boolean;
  readonly snapshots?: boolean;
  readonly recovery?: boolean;
}
/** State fields injected by the execution runtime for every createState graph. */
export interface FrameworkState {
  readonly messages: readonly ChatMessage[];
  readonly currentDateTime: string;
  readonly threadId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly previousSteps: readonly StepDescriptor[];
  readonly interrupt: JsonValue;
  readonly memory: JsonObject;
  readonly context: JsonObject;
}
/** Infer the runtime state object from a state descriptor without repeating the state interface. */
export type StateOf<TDescriptor> = TDescriptor extends StateDescriptor<infer TState> ? TState : JsonObject;
/** Infer the graph input object from a compiled graph contract. */
export type InputOf<TGraph> = TGraph extends { readonly definition: { readonly state: StateSchema<infer TState> } } ? Partial<TState> : JsonObject;
/** The runtime value represented by a state field descriptor. */
export type StateValue<TField> = TField extends ReducedField<infer TValue> ? TValue : TField;
/** Infer the state value object from a field descriptor map. */
export type InferState<TFields> = {
  [K in keyof TFields]: StateValue<TFields[K]>;
};
/** Serializable field values accepted by the inference-first state DSL. */
export type StateFieldInput = object | string | number | boolean | null;
/** A state descriptor map with its inferred state value type attached. */
export type InferredStateDescriptor<TFields extends Record<string, StateFieldInput>> = Omit<StateDescriptor<InferState<TFields>>, "fields"> & {
  readonly fields: TFields;
};
export interface MessagesField<TMessage extends ChatMessage = ChatMessage> extends ReducedField<readonly TMessage[]> { readonly __messages: true; }
export function messagesValue<TMessage extends ChatMessage = ChatMessage>(): MessagesField<TMessage> {
  return { __messages: true, __reduced: true, default: [], reducer: (prev, next) => [...prev, ...(Array.isArray(next) ? next : [next])] };
}
export function reducedValue<T>(defaultValue: T, reducer: (prev: T, next: T) => T): ReducedField<T> { return { __reduced: true, default: defaultValue, reducer }; }
export function isReducedField<T>(value: StateField<T>): value is ReducedField<T> { return typeof value === "object" && value !== null && "__reduced" in value && value.__reduced === true; }

export interface Actor { readonly id: string; readonly roles?: readonly string[]; readonly claims?: JsonObject; }
export type NodeRiskClass = "read" | "write" | "dangerous";
export type PolicyDecision = "allow" | "deny" | "interrupt";
export type TierAlias = string;
export interface RunPolicy { (actor: Actor, graphName: string, opts: { readonly threadId?: string }): PolicyDecision | Promise<PolicyDecision>; }
export interface TierResolver { (actor: Actor, binding: { readonly tier: TierAlias }, graphName: string): TierAlias | Promise<TierAlias>; }
export interface TokenBudgetSpec { readonly limit: number; readonly windowMs?: number; }
export interface TokenBudget { readonly perTier: Readonly<Record<string, TokenBudgetSpec>>; }

export interface GraphContracts {
  readonly input: object;
  readonly output: object;
  readonly interrupt: JsonValue;
  readonly answer: JsonValue;
  readonly thinking: JsonValue;
  readonly toolCall: JsonValue;
  readonly intent: string;
}
export interface DefaultGraphContracts extends GraphContracts {}
export interface GraphSchemas<TInput extends object, TOutput extends object, C extends GraphContracts> {
  readonly input?: ValueSchema<TInput>;
  readonly output?: ValueSchema<TOutput>;
  readonly interrupt?: ValueSchema<C["interrupt"]>;
  readonly answer?: ValueSchema<C["answer"]>;
  readonly thinking?: ValueSchema<C["thinking"]>;
  readonly toolCall?: ValueSchema<C["toolCall"]>;
}
export interface InterruptRequest<TInterrupt extends JsonValue = JsonValue> {
  readonly kind: string;
  readonly prompt: string;
  readonly payload: TInterrupt;
  readonly reason?: string;
}
export interface PendingInterrupt<TInterrupt extends JsonValue = JsonValue> {
  readonly node: string;
  readonly mode: InterruptMode;
  readonly request?: InterruptRequest<TInterrupt>;
}
export type GateDecision<TInterrupt extends JsonValue = JsonValue> =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "interrupt"; readonly request: InterruptRequest<TInterrupt> };
export interface Gate<TState extends object, TInterrupt extends JsonValue = JsonValue> {
  readonly name: string;
  readonly check: (state: TState, ctx: GateContext) => GateDecision<TInterrupt> | Promise<GateDecision<TInterrupt>>;
}
export interface GateContext { readonly threadId: string; readonly runId: string; readonly actor?: Actor; readonly variables: JsonObject; readonly global: JsonObject; }
export interface ToolDefinition<TArgs extends object = JsonObject, TResult extends JsonValue = JsonValue> {
  readonly name: string;
  readonly description: string;
  readonly input: ValueSchema<TArgs>;
  readonly execute: (args: TArgs, ctx: ToolContext) => TResult | Promise<TResult>;
}
export interface ToolContext { readonly threadId: string; readonly runId: string; readonly actor?: Actor; readonly variables: JsonObject; readonly global: JsonObject; }
export interface IntentClassifier<TInput extends object, TIntent extends string> {
  readonly name: string;
  readonly classify: (input: TInput, ctx: IntentContext) => TIntent | Promise<TIntent>;
}
export interface IntentAnalysis {
  readonly confidence: number;
  readonly language: string;
  readonly tableHint?: string;
  readonly needsClarification: boolean;
}
export interface IntentContext {
  readonly threadId: string;
  readonly runId: string;
  readonly actor?: Actor;
  readonly model: LLMSession;
  readonly emitAnalysis: (analysis: IntentAnalysis) => void;
  readonly emitToken: (value: string, index: number) => void;
  readonly emitReasoning: (value: string, index: number) => void;
  readonly emitUsage: (value: TokenUsage) => void;
}
export interface IntentClassification<TIntent extends string, TDetails extends JsonObject = JsonObject> {
  readonly value: TIntent;
  readonly details: TDetails;
  readonly analysis: IntentAnalysis;
}
export interface IntentAnalyzer<TInput extends object, TIntent extends string, TDetails extends JsonObject = JsonObject> {
  readonly name: string;
  readonly analyze: (input: TInput, ctx: IntentContext) => IntentClassification<TIntent, TDetails> | Promise<IntentClassification<TIntent, TDetails>>;
}
export interface IntentSpec<TIntent extends string> { readonly values: readonly TIntent[]; readonly classifier?: IntentClassifier<object, TIntent>; }
export interface StepDescriptor { readonly id: string; readonly label: string; readonly kind: "node" | "edge" | "graph"; }

export type NodeFunction<TState extends object, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> =
  (state: TState, ctx: NodeContext<TState, C, TVariables, TGlobal>) => Promise<Partial<TState>> | Partial<TState>;
export interface NodeContext<TState extends object = object, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> {
  readonly graph: string;
  readonly threadId: string;
  readonly runId: string;
  /** Abort signal propagated from the host adapter into model/tool calls. */
  readonly signal?: AbortSignal;
  readonly actor?: Actor;
  readonly variables: Readonly<TVariables>;
  readonly global: Readonly<TGlobal>;
  readonly answer?: C["answer"];
  readonly model: LLMSession;
  readonly cancelled: () => boolean;
  readonly emit: (step: StepEvent<TState, C>) => void;
  readonly emitError: (message: string, cause?: Error) => void;
  readonly log: (event: JsonObject) => void;
  readonly think: (value: C["thinking"], label?: string) => void;
  /** Request a pause; the default runtime throws internally after recording the request. */
  readonly interrupt: (request: InterruptRequest<C["interrupt"]>) => void;
  /** Request a human answer; the default runtime throws internally after recording the request. */
  readonly ask: (request: InterruptRequest<C["interrupt"]>) => void;
  readonly callTool: <TArgs extends object, TResult extends JsonValue>(tool: ToolDefinition<TArgs, TResult>, args: TArgs) => Promise<TResult>;
  readonly detectIntent: <TInput extends object, TIntent extends string>(classifier: IntentClassifier<TInput, TIntent>, input: TInput) => Promise<TIntent>;
  readonly analyzeIntent: <TInput extends object, TIntent extends string, TDetails extends JsonObject>(analyzer: IntentAnalyzer<TInput, TIntent, TDetails>, input: TInput) => Promise<IntentClassification<TIntent, TDetails>>;
}
export interface TierBinding { readonly tier: TierAlias; }
export interface NodeSpec<TState extends object, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> {
  readonly fn: NodeFunction<TState, C, TVariables, TGlobal>;
  readonly binding?: TierBinding;
  readonly fanOut?: keyof TState & string;
  readonly risk?: NodeRiskClass;
  readonly label?: string;
  readonly stepLabel?: string;
  readonly gate?: Gate<TState, C["interrupt"]>;
  readonly tools?: readonly ToolDefinition<object, C["toolCall"]>[];
  readonly intent?: IntentSpec<C["intent"]>;
}
/** A node may be a plain function in zero-config graphs or a configured NodeSpec. */
export type NodeLike<TState extends object, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> =
  | NodeSpec<TState, C, TVariables, TGlobal>
  | NodeFunction<TState, C, TVariables, TGlobal>;
export type RouteDecision<TState extends object> = string | string[];
export type ConditionalRouteFn<TState extends object> = (state: TState) => RouteDecision<TState>;
export interface EdgeSpec<TState extends object = object> { readonly from: string; readonly to: string; readonly label?: string; }
export interface ConditionalEdgeSpec<TState extends object = object> { readonly from: string; readonly fn: ConditionalRouteFn<TState>; readonly targets: readonly string[]; readonly label?: string; }

/** A collection field processed by a node as bounded parallel work. */
export interface FanoutSpec<TState extends object> {
  readonly node: string;
  readonly field: keyof TState & string;
}

/** A barrier that waits for the declared upstream nodes before continuing. */
export interface JoinSpec {
  readonly nodes: readonly string[];
  readonly target: string;
}

/** A state reducer registered by a graph builder. */
export interface ReductionSpec<TState extends object> {
  readonly field: keyof TState & string;
  readonly reducer: (state: TState) => Partial<TState>;
}

/** A bounded conditional loop registered by a graph builder. */
export interface LoopSpec<TState extends object> {
  readonly node: string;
  readonly route: ConditionalRouteFn<TState>;
  readonly targets: readonly string[];
  readonly maxRounds: number;
}

/** A bounded route used when a node execution fails. */
export interface ErrorRouteSpec<TState extends object> {
  readonly node: string;
  readonly route: ConditionalRouteFn<TState>;
  readonly targets: readonly string[];
}

/** Retry policy applied to a single node or every node in a workflow. */
export interface RetrySpec {
  readonly node?: string;
  readonly attempts: number;
  readonly backoff: "fixed" | "exponential";
}

/** A recovery node selected when execution of another node fails. */
export interface FallbackSpec {
  readonly target: string;
  readonly policy: "recover" | "return" | "rethrow";
}

/** A workflow-level predicate evaluated before selected nodes execute. */
export interface GuardSpec<TState extends object> {
  readonly nodes: readonly string[];
  readonly check: (state: TState) => boolean | Promise<boolean>;
  readonly message?: string;
}

export interface ConvergeSpec<TState extends object> { readonly on: keyof TState & string; readonly maxRounds: number; }
export interface SafetySpec { readonly recursionLimit: number; readonly timeoutMs?: number; readonly maxTokensPerNode?: number; }
export type InterruptMode = "before" | "after";
export interface InterruptSpec<TInterrupt extends JsonValue = JsonValue> { readonly nodes: readonly string[]; readonly mode?: InterruptMode; readonly request?: InterruptRequest<TInterrupt>; }

/** Defaults inherited by every run of a compiled graph. */
export interface GraphRuntimeOptions<TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> {
  readonly checkpoint?: Checkpointer;
  readonly modelRegistry?: ModelRegistry;
  readonly actor?: Actor;
  readonly policy?: RunPolicy;
  readonly tierResolver?: TierResolver;
  readonly tokenBudget?: TokenBudget;
  readonly variables?: Partial<TVariables>;
  readonly global?: Partial<TGlobal>;
}

export interface GraphDefinition<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> {
  readonly name: string;
  readonly state: StateSchema<TState>;
  /** @deprecated Define initial values directly in `defineState`; retained for compatibility. */
  readonly stateDefaults?: Partial<TState>;
  /** Declarative state behavior retained from createState(fields, options). */
  readonly stateOptions?: StateOptions<TState>;
  readonly schemas?: GraphSchemas<TInput, TOutput, C>;
  readonly nodes: Readonly<Record<string, NodeSpec<TState, C, TVariables, TGlobal>>>;
  readonly edges: readonly (EdgeSpec<TState> | ConditionalEdgeSpec<TState>)[];
  readonly entry: string;
  readonly verify?: { readonly nodes: readonly string[]; readonly fns?: readonly VerifierFn<TState>[] };
  readonly converge?: ConvergeSpec<TState>;
  readonly fanouts?: readonly FanoutSpec<TState>[];
  readonly joins?: readonly JoinSpec[];
  readonly reductions?: readonly ReductionSpec<TState>[];
  readonly loops?: readonly LoopSpec<TState>[];
  readonly errorRoutes?: readonly ErrorRouteSpec<TState>[];
  /** Declarative retry policies lowered from fluent `.retry()`. */
  readonly retries?: readonly RetrySpec[];
  /** Declarative recovery targets lowered from fluent `.fallback()`. */
  readonly fallbacks?: readonly FallbackSpec[];
  /** Declarative execution predicates lowered from fluent `.guard()`. */
  readonly guards?: readonly GuardSpec<TState>[];
  readonly safety: SafetySpec;
  readonly interruptBefore?: readonly string[];
  readonly interruptAfter?: readonly string[];
  /** Human-in-the-loop requests keyed by their lifecycle target node. */
  readonly interruptRequests?: Readonly<Record<string, InterruptRequest<C["interrupt"]>>>;
  readonly log?: boolean;
  readonly variables?: Partial<TVariables>;
  readonly global?: Partial<TGlobal>;
  /** Runtime resources inherited by `run()` and `stream()`. */
  readonly runtime?: GraphRuntimeOptions<TVariables, TGlobal>;
}
export interface CompiledGraph<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> {
  readonly definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>;
  readonly name: string;
  readonly adjacency: Map<string, { fixed: string[]; conditional: ConditionalEdgeSpec<TState>[] }>;
  readonly entry: string;
  readonly terminals: Set<string>;
  readonly converge?: ConvergeSpec<TState>;
  readonly fanouts: ReadonlyMap<string, FanoutSpec<TState>>;
  readonly joins: readonly JoinSpec[];
  readonly reductions: readonly ReductionSpec<TState>[];
  readonly loops: readonly LoopSpec<TState>[];
  readonly errorRoutes: readonly ErrorRouteSpec<TState>[];
  readonly safety: SafetySpec;
  readonly interruptBefore: Set<string>;
  readonly interruptAfter: Set<string>;
  run(input: TInput, opts?: RunOptions<C, TVariables, TGlobal>): Promise<RunResult<TState, TOutput, C["interrupt"], TVariables>>;
  invoke(input: TInput, opts?: RunOptions<C, TVariables, TGlobal>): Promise<RunResult<TState, TOutput, C["interrupt"], TVariables>>;
  resume(threadId: string, response: C["answer"], opts?: Omit<RunOptions<C, TVariables, TGlobal>, "threadId" | "humanResponse">): Promise<RunResult<TState, TOutput, C["interrupt"], TVariables>>;
  stream(input: TInput, opts?: RunOptions<C, TVariables, TGlobal>): AsyncIterable<StepEvent<TState, C>>;
}

export interface RunOptions<C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject> {
  readonly threadId?: string;
  readonly checkpoint?: Checkpointer;
  readonly resumeFrom?: string;
  readonly humanResponse?: C["answer"];
  readonly modelRegistry?: ModelRegistry;
  readonly cancellation?: CancellationSource;
  readonly signal?: AbortSignal;
  readonly actor?: Actor;
  readonly policy?: RunPolicy;
  readonly tierResolver?: TierResolver;
  readonly tokenBudget?: TokenBudget;
  readonly variables?: Partial<TVariables>;
  readonly global?: Partial<TGlobal>;
}
export interface RunResult<TState extends object, TOutput extends object = TState, TInterrupt extends JsonValue = JsonValue, TVariables extends JsonObject = JsonObject> {
  readonly state: TState;
  readonly output?: TOutput;
  readonly variables?: Readonly<TVariables>;
  readonly stoppedAt: string | null;
  readonly stoppedReason: "done" | "interrupt" | "safety" | "cancelled" | "error";
  readonly interrupt?: InterruptRequest<TInterrupt>;
  readonly error?: Error;
}
export interface Checkpoint<TState extends object = JsonObject, TInterrupt extends JsonValue = JsonValue, TVariables extends JsonObject = JsonObject> {
  readonly threadId: string;
  readonly checkpointId: string;
  readonly state: TState;
  readonly node: string;
  readonly round: number;
  readonly pendingInterrupt?: PendingInterrupt<TInterrupt>;
  readonly variables?: Partial<TVariables>;
  readonly createdAt: number;
}
export interface Checkpointer<TState extends object = JsonObject, TInterrupt extends JsonValue = JsonValue, TVariables extends JsonObject = JsonObject> {
  get(threadId: string): Promise<Checkpoint<TState, TInterrupt, TVariables> | null>;
  put(checkpoint: Checkpoint<TState, TInterrupt, TVariables>): Promise<void>;
  list(threadId: string): Promise<Checkpoint<TState, TInterrupt, TVariables>[]>;
}
export interface StepEventBase { readonly graph: string; readonly threadId: string; readonly runId: string; readonly node?: string; readonly step?: StepDescriptor; readonly ts: number; }
export type StepEvent<TState extends object = object, C extends GraphContracts = DefaultGraphContracts> =
  | (StepEventBase & { readonly type: "node_start"; readonly data?: { readonly state?: TState } })
  | (StepEventBase & { readonly type: "node_end"; readonly data?: { readonly state?: TState; readonly latencyMs?: number } })
  | (StepEventBase & { readonly type: "edge"; readonly data: { readonly from: string; readonly to: string } })
  | (StepEventBase & { readonly type: "thinking"; readonly data: { readonly value: C["thinking"] } })
  | (StepEventBase & { readonly type: "token"; readonly data: { readonly value: string; readonly index: number } })
  | (StepEventBase & { readonly type: "reasoning"; readonly data: { readonly value: string; readonly index: number } })
  | (StepEventBase & { readonly type: "model_tool_call"; readonly data: { readonly id?: string; readonly index: number; readonly name?: string; readonly arguments: string } })
  | (StepEventBase & { readonly type: "usage"; readonly data: { readonly tier: string; readonly value: TokenUsage } })
  | (StepEventBase & { readonly type: "intent"; readonly data: { readonly name: string; readonly value: C["intent"]; readonly analysis?: IntentAnalysis } })
  | (StepEventBase & { readonly type: "answer"; readonly data: { readonly value: C["answer"] } })
  | (StepEventBase & { readonly type: "tool_start"; readonly data: { readonly name: string; readonly args: C["toolCall"] } })
  | (StepEventBase & { readonly type: "tool_end"; readonly data: { readonly name: string; readonly result: JsonValue } })
  | (StepEventBase & { readonly type: "interrupt"; readonly data: { readonly request?: InterruptRequest<C["interrupt"]>; readonly state?: TState; readonly reason?: string } })
  | (StepEventBase & { readonly type: "error"; readonly data: { readonly error: Error } })
  | (StepEventBase & { readonly type: "safety"; readonly data?: { readonly reason: string } })
  | (StepEventBase & { readonly type: "cancelled"; readonly data?: { readonly reason?: string } })
  | (StepEventBase & { readonly type: "info"; readonly data?: JsonObject });

export interface CancellationSource { cancel(): void; isCancelled(): boolean; }
export function createCancellationSource(): CancellationSource { let cancelled = false; return { cancel: () => { cancelled = true; }, isCancelled: () => cancelled }; }

export interface ModelToolCall { readonly id: string; readonly name: string; readonly arguments: JsonObject; }
export interface ModelToolSpec { readonly name: string; readonly description: string; readonly parameters: JsonObject; }
export type ModelToolChoice = "auto" | "none" | "required" | { readonly name: string };
export interface ResponseFormat { readonly type: "text" | "json_object" | "json_schema"; readonly name?: string; readonly schema?: JsonObject; readonly strict?: boolean; }
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}
export interface TokenUsage { readonly inputTokens: number; readonly outputTokens: number; }
export type ChatStreamChunk =
  | { readonly type: "token"; readonly value: string }
  | { readonly type: "reasoning"; readonly value: string }
  | { readonly type: "tool_call"; readonly value: { readonly id?: string; readonly index: number; readonly name?: string; readonly arguments: string } }
  | { readonly type: "usage"; readonly value: TokenUsage };
export type ReasoningEffort = "none" | "low" | "medium" | "high";
export interface ChatStreamOptions {
  readonly signal?: AbortSignal;
  readonly tools?: readonly ModelToolSpec[];
  readonly toolChoice?: ModelToolChoice;
  readonly responseFormat?: ResponseFormat;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
}
export interface ChatResult { readonly content: string; readonly usage?: TokenUsage; readonly finishReason?: string; readonly toolCalls?: readonly ModelToolCall[]; readonly raw?: JsonValue; }
export interface LLMProviderConfig { readonly driver: "openai" | "anthropic" | "huggingface" | "openai-compatible" | "mock"; readonly model: string; readonly apiKey?: string; readonly baseURL?: string; readonly provider?: string; readonly maxTokens?: number; readonly temperature?: number; readonly reasoningEffort?: ReasoningEffort; readonly mockResponse?: string; readonly adapterRepo?: string; }
export interface LLMProvider {
  readonly name: string;
  chat(messages: readonly ChatMessage[], opts?: ChatStreamOptions): Promise<ChatResult>;
  stream(messages: readonly ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<string>;
  streamDetailed?(messages: readonly ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<ChatStreamChunk>;
}
export interface LLMSession {
  chat(messages: readonly ChatMessage[], opts?: ChatStreamOptions): Promise<ChatResult>;
  streamDetailed?(messages: readonly ChatMessage[], opts?: ChatStreamOptions): AsyncIterable<ChatStreamChunk>;
}
export interface ModelRegistry { tier(alias: TierAlias): LLMProvider; reconfigure(tiers: Readonly<Record<string, LLMProviderConfig>>, factory: (cfg: LLMProviderConfig) => LLMProvider): void; tokenUsage: Map<string, { input: number; output: number }>; }

export interface VerifierResult { readonly pass: boolean; readonly reason?: string; readonly anchors: readonly ("llm" | "code" | "test" | "http" | "db")[]; }
export type VerifierFn<TState extends object> = (state: TState) => Promise<VerifierResult> | VerifierResult;
export interface VerifySpec<TState extends object> { readonly nodes: readonly string[]; readonly fns: readonly VerifierFn<TState>[]; }
export interface QueuedJob<TInput extends object = JsonObject> { readonly graphName: string; readonly input: TInput; readonly opts: Omit<RunOptions, "checkpoint">; readonly queue?: string; }
export interface QueueAdapter<TInput extends object = JsonObject> { enqueue(job: QueuedJob<TInput>, opts?: { readonly delayMs?: number }): Promise<string>; }
