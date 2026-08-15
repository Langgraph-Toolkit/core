/**
 * Target API graph facades.
 *
 * The builder is intentionally a thin typed layer over the existing DSL and
 * executor. It keeps graph definition ergonomic while preserving the
 * framework-neutral Core boundary.
 */
import { compile } from "./compile.js";
import { buildGraph } from "./executor.js";
import { conditional, defineGraph, defineState, edge, node, tool } from "./defineGraph.js";
import type {
  CompiledGraph,
  Checkpoint,
  Checkpointer,
  ConditionalRouteFn,
  DefaultGraphContracts,
  EdgeSpec,
  GraphContracts,
  GraphDefinition,
  GraphRuntimeOptions,
  GuardSpec,
  JsonObject,
  JsonValue,
  NodeLike,
  NodeSpec,
  ReducedField,
  SafetySpec,
  StateDescriptor,
  StateFieldInput,
  ToolDefinition,
  VerifySpec,
  ValueSchema,
  InferState,
  IntentSpec,
  InterruptRequest,
  NodeFunction,
  NodeRiskClass,
  StateSchema,
  StateOptions,
  RetrySpec,
  FallbackSpec,
  FrameworkState,
} from "./types.js";

/** State fields accepted by the inference-first state facade. */
export type StateFieldMap = Record<string, StateFieldInput>;

/** A typed route with an explicit allow-list of destinations. */
export interface RouteDefinition<TState extends object> {
  readonly route: ConditionalRouteFn<TState>;
  readonly targets: readonly string[];
  readonly label?: string;
}

/** Route used by dynamic fan-out declarations. */
export interface DynamicFanoutRoute<TState extends object> extends RouteDefinition<TState> {
  readonly field?: keyof TState & string;
}

/** State reducer used by a fluent reduce declaration. */
export type StateReducer<TState extends object> = (state: TState) => Partial<TState>;

/** Route used to terminate or repeat a loop. */
export interface LoopRoute<TState extends object> {
  readonly route: ConditionalRouteFn<TState>;
  readonly targets: readonly string[];
  readonly maxRounds: number;
}

/** Error route used by a graph builder. */
export interface ErrorRoute<TState extends object> {
  readonly node: string;
  readonly route: ConditionalRouteFn<TState>;
  readonly targets: readonly string[];
}

/** Typed runnable accepted by high-level workflow capabilities. */
export type FluentCallable<TInput extends object = JsonObject, TOutput extends object = JsonObject> = (input: TInput) => Promise<TOutput> | TOutput;

/** Agent-compatible participant accepted directly by parallel workflow branches. */
export interface WorkflowParticipant<TState extends object> {
  readonly name: string;
  run(input: TState): Promise<{ readonly output: Partial<TState> }>;
}

/** Retry policy accepted at workflow or node scope. */
export interface RetryOptions {
  readonly attempts?: number;
  readonly backoff?: "fixed" | "exponential";
}

/** Fallback policy accepted at workflow or node scope. */
export interface FallbackOptions<TOutput extends object = object> {
  readonly node?: string;
  readonly run?: FluentCallable<object, TOutput>;
  readonly policy?: "recover" | "return" | "rethrow";
}

/** Predicate policy used by fluent `.guard()` before a node executes. */
export interface GuardOptions<TState extends object> {
  /** Nodes guarded by this predicate. Omit to apply it to every workflow node. */
  readonly before?: string | readonly string[];
  /** Return false to deny execution before a protected node starts. */
  readonly when?: (state: TState) => boolean | Promise<boolean>;
  /** Alias for `when`, useful when naming a reusable guard function. */
  readonly check?: (state: TState) => boolean | Promise<boolean>;
  /** Message included in the deterministic Core rejection. */
  readonly message?: string;
  /** Optional identifier retained for diagnostics and compatibility. */
  readonly policy?: string;
}

/** Static parallel task map used by the high-level workflow facade. */
export type ParallelOptions<TState extends object> = Readonly<Record<string, FluentCallable<TState, Partial<TState>> | WorkflowParticipant<TState>>>;

/** Collection mapping declaration with inferred or explicit output field. */
export interface MapOptions<TState extends object, TOutput extends object = object> {
  readonly from: (state: TState) => readonly object[];
  readonly run: FluentCallable<object, TOutput>;
  readonly into?: keyof TState & string;
}

/** State reduction declaration for the high-level facade. */
export interface ReduceOptions<TState extends object> {
  readonly from: keyof TState & string;
  readonly into?: keyof TState & string;
  readonly reducer: (previous: JsonValue, next: JsonValue) => JsonValue;
}

/** Static route map used by the high-level facade. */
export type RouteMap = Readonly<Record<string, string>>;

/** Interrupt shorthand for approval and human-in-the-loop flows. */
export interface InterruptOptions {
  readonly type?: "approval" | "question" | "review";
  readonly text?: string;
  /** Pause before these nodes. A single string is accepted as shorthand. */
  readonly before?: string | readonly string[];
  /** Pause after these nodes. A single string is accepted as shorthand. */
  readonly after?: string | readonly string[];
  /** Serializable context returned to the host with the interrupt event. */
  readonly payload?: JsonValue;
  /** Machine-readable explanation for audit logs and hosts. */
  readonly reason?: string;
}

/** Human-decision policy lowered to a node Gate at runtime. */
export interface ApprovalOptions<TState extends object> extends InterruptOptions {
  readonly before?: string | readonly string[];
  readonly when?: (state: TState) => boolean | Promise<boolean>;
  readonly allowEdit?: boolean;
  readonly allowReject?: boolean;
  readonly allowEscalate?: boolean;
}

/** Transaction scope declaration. */
export interface TransactionOptions {
  readonly state?: boolean;
  readonly sideEffects?: boolean;
  readonly checkpoint?: boolean;
}

/** A checkpoint implementation or adapter facade accepted without Core importing storage packages. */
export type CheckpointSource = Checkpointer | { readonly checkpointer: Checkpointer };

/** Options for compiling a fluent graph. */
export interface CompileOptions {
  readonly verify?: VerifySpec<object>;
}

/** Options accepted by createGraph(). */
export interface GraphOptions<
  TFields extends StateFieldMap,
  TInput extends object = Partial<InferState<TFields>>,
  TOutput extends object = InferState<TFields>,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
> {
  readonly name?: string;
  readonly state: TFields | StateDescriptor<InferState<TFields>>;
  readonly nodes?: Readonly<Record<string, NodeLike<InferState<TFields>, C, TVariables, TGlobal>>>;
  readonly entry?: string;
  readonly edges?: GraphDefinition<InferState<TFields>, TInput, TOutput, C, TVariables, TGlobal>["edges"];
  readonly safety?: SafetySpec;
  readonly runtime?: GraphRuntimeOptions<TVariables, TGlobal>;
  readonly variables?: Partial<TVariables>;
  readonly global?: Partial<TGlobal>;
  readonly schemas?: GraphDefinition<InferState<TFields>, TInput, TOutput, C, TVariables, TGlobal>["schemas"];
}

/** Options accepted by the canonical named workflow facade. */
export type WorkflowOptions<
  TFields extends StateFieldMap,
  TInput extends object = Partial<InferState<TFields>>,
  TOutput extends object = InferState<TFields>,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
> = Omit<GraphOptions<TFields, TInput, TOutput, C, TVariables, TGlobal>, "name">;

/** A fluent graph definition that compiles into the existing runnable graph. */
export interface GraphBuilder<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
> {
  readonly name: string;
  readonly state: StateSchema<TState>;
  /** Add or replace one graph node. */
  node(name: string, definition: NodeLike<TState, C, TVariables, TGlobal>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a fixed edge. */
  edge(from: string, to: string, label?: string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a bounded conditional edge. */
  conditional(from: string, route: RouteDefinition<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a named router using the same bounded route contract. */
  router(from: string, route: RouteDefinition<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Set the graph entry node. */
  start(name: string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Mark a node as operating over a state collection. */
  fanout(nodeName: string, field: keyof TState & string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Declare a convergent cycle. */
  converge(field: keyof TState & string, maxRounds?: number): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a bounded dynamic fan-out route. */
  dynamicFanout(nodeName: string, route: DynamicFanoutRoute<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Join several upstream nodes into one target. */
  join(nodes: readonly string[], target: string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Join branches using the canonical object contract. */
  join(options: { readonly from: readonly string[]; readonly into: string }): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Join the inferred upstream branches into a target. */
  join(target: string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Connect a collection field to a node. */
  map(field: keyof TState & string, nodeName: string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Map a collection through a typed callable. */
  map(options: MapOptions<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a typed state reduction callback for the graph definition. */
  reduce(field: keyof TState & string, reducer: StateReducer<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Reduce a collection using the canonical object contract. */
  reduce(options: ReduceOptions<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a bounded loop route. */
  loop(nodeName: string, route: LoopRoute<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a compiled child graph as a node. */
  subgraph(name: string, graph: CompiledGraph<object>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register an existing node as a subgraph capability. */
  subgraph(name: string): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a graph builder as a child node. */
  nestedGraph(name: string, graph: GraphBuilder<object>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Resolve a child graph at execution definition time. */
  dynamicGraph(name: string, factory: GraphFactory<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Route a node failure through a bounded graph edge. */
  onError(route: ErrorRoute<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Interrupt before one or more named nodes. */
  interruptBefore(...nodes: readonly string[]): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Interrupt after one or more named nodes. */
  interruptAfter(...nodes: readonly string[]): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Return the immutable definition without attaching an executor. */
  definition(): GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Compile and validate the graph topology. */
  compile(options?: CompileOptions): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Compile and attach the default runnable executor. */
  build(): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Reflect over the current workflow result. */
  reflect(options?: { readonly threshold?: number }): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a model-backed planning capability. */
  plan(options?: object): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Add a model-backed replanning capability. */
  replan(options?: object): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a static or classifier-backed route map. */
  route(routes: RouteMap): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register parallel named capabilities. */
  parallel(options?: ParallelOptions<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a retry policy. */
  retry(options?: RetryOptions | number): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a fallback policy. */
  fallback(options?: FallbackOptions): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a guardrail predicate enforced before selected nodes execute. */
  guard(options?: GuardOptions<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a human approval capability. */
  approval(options?: ApprovalOptions<TState>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register an interrupt request. */
  interrupt(options?: InterruptOptions): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a transaction scope. */
  transaction(options?: TransactionOptions): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a Community RAG capability. */
  rag(options?: object): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a supervisor capability. */
  supervisor(options?: object): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register an evaluation capability. */
  evaluate(options?: object): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a memory capability. */
  remember(options?: object): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
  /** Register a checkpoint capability. */
  checkpoint(source?: CheckpointSource): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>;
}

/** Factory for a graph builder that receives the current state. */
export type GraphFactory<TState extends object> = (state: TState) => GraphBuilder<TState>;

interface BuilderOptions<TState extends object, TInput extends object, TOutput extends object, C extends GraphContracts, TVariables extends JsonObject, TGlobal extends JsonObject> {
  readonly definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>;
  readonly controls: Map<string, ReadonlyArray<string>>;
}

/** Create a typed state descriptor with runtime fields and optional state behavior. */
export function createState<TFields extends StateFieldMap>(fields: TFields, options: StateOptions<InferState<TFields>> = {}): StateDescriptor<InferState<TFields>> {
  const descriptor = defineState(fields);
  return { ...descriptor, options } as StateDescriptor<InferState<TFields>>;
}

/** Create a typed tool definition using the canonical Core facade name. */
export function createTool<TArgs extends object, TResult extends JsonValue>(definition: ToolDefinition<TArgs, TResult>): ToolDefinition<TArgs, TResult> {
  return tool(definition);
}

/** Binding options accepted by the canonical node factory. */
export interface NodeOptions<TState extends object, C extends GraphContracts = DefaultGraphContracts> {
  readonly tier?: import("./types.js").TierAlias;
  readonly risk?: NodeRiskClass;
  readonly label?: string;
  readonly stepLabel?: string;
  readonly gate?: import("./types.js").Gate<TState, C["interrupt"]>;
  readonly tools?: readonly ToolDefinition<object, C["toolCall"]>[];
  readonly intent?: IntentSpec<C["intent"]>;
}

/** Create a typed graph node without importing the lower-level DSL name. */
export function createNode<
  TState extends object,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(fn: NodeFunction<TState, C, TVariables, TGlobal>, options?: NodeOptions<TState, C>): NodeSpec<TState, C, TVariables, TGlobal> {
  return node(fn, options);
}

/** Create a typed fixed edge for a graph definition. */
export function createEdge<TState extends object = object>(from: string, to: string, label?: string): EdgeSpec<TState> {
  return { from, to, label };
}

/** Create a bounded conditional route declaration for a fluent graph. */
export function createRoute<TState extends object>(route: ConditionalRouteFn<TState>, targets: readonly string[], label?: string): RouteDefinition<TState> {
  if (targets.length === 0) throw new Error("createRoute requires at least one target.");
  return { route, targets, label };
}

/** Create a named subgraph builder using the same state and graph contracts. */
export function createSubgraph<
  TFields extends StateFieldMap,
  TInput extends object = Partial<InferState<TFields>>,
  TOutput extends object = InferState<TFields>,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(options: GraphOptions<TFields, TInput, TOutput, C, TVariables, TGlobal>): GraphBuilder<InferState<TFields>, TInput, TOutput, C, TVariables, TGlobal> {
  return createGraph(options);
}

/** Compose compatible workflow definitions into one typed graph namespace. */
export function composeWorkflows<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(name: string, workflows: readonly GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal>[]): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal> {
  const first = workflows[0]?.definition();
  if (!first) throw new Error("composeWorkflows requires at least one workflow.");
  const nodes: Record<string, NodeSpec<TState, C, TVariables, TGlobal>> = {};
  const edges: Array<GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>["edges"][number]> = [];
  for (const workflow of workflows) {
    const definition = workflow.definition();
    for (const [nodeName, nodeDefinition] of Object.entries(definition.nodes)) {
      if (nodes[nodeName]) throw new Error(`composeWorkflows found duplicate node "${nodeName}".`);
      nodes[nodeName] = nodeDefinition;
    }
    edges.push(...definition.edges);
  }
  return createBuilder({
    definition: {
      ...first,
      name,
      nodes,
      edges,
      entry: first.entry,
    },
    controls: new Map(),
  });
}

/** Create a fluent graph builder with inferred state and zero-config defaults. */
export function createGraph<
  TFields extends StateFieldMap,
  TInput extends object = Partial<InferState<TFields>>,
  TOutput extends object = InferState<TFields>,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(options: GraphOptions<TFields, TInput, TOutput, C, TVariables, TGlobal>): GraphBuilder<InferState<TFields>, TInput, TOutput, C, TVariables, TGlobal> {
  const state = options.state;
  const stateInput: StateDescriptor<InferState<TFields>> = isStateDescriptor(state)
    ? state
    : createState(state);
  const initialNodes = options.nodes ?? {};
  const name = options.name ?? "workflow";
  const definition = Object.keys(initialNodes).length > 0
    ? defineGraph<InferState<TFields>, TInput, TOutput, C, TVariables, TGlobal>({
        name,
        state: stateInput,
        stateOptions: stateInput.options,
        nodes: initialNodes,
        entry: options.entry,
        edges: options.edges,
        safety: options.safety,
        schemas: options.schemas,
        variables: options.variables,
        global: options.global,
        runtime: options.runtime,
      })
    : {
        name,
        state: stateInput.fields,
        stateDefaults: stateInput.defaults,
        stateOptions: stateInput.options,
        nodes: {},
        entry: options.entry ?? "",
        edges: options.edges ?? [],
        safety: options.safety ?? { recursionLimit: 100, timeoutMs: 120_000 },
        schemas: options.schemas,
        variables: options.variables,
        global: options.global,
        runtime: options.runtime,
      };
  const controls = new Map<string, ReadonlyArray<string>>();
  return createBuilder({ definition, controls });
}

/**
 * Create the canonical high-level workflow facade.
 *
 * The workflow facade intentionally shares the exact GraphBuilder contract with
 * createGraph. This keeps the zero-config path short while preserving graph()
 * primitives for developers who need explicit topology control.
 */
export function createWorkflow(
  name: string,
): GraphBuilder<FrameworkState, Partial<FrameworkState>, FrameworkState>;
export function createWorkflow<
  TFields extends StateFieldMap,
  TInput extends object = Partial<InferState<TFields>>,
  TOutput extends object = InferState<TFields>,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(name: string, options: WorkflowOptions<TFields, TInput, TOutput, C, TVariables, TGlobal>): GraphBuilder<InferState<TFields>, TInput, TOutput, C, TVariables, TGlobal>;
export function createWorkflow(
  name: string,
  options?: WorkflowOptions<StateFieldMap>,
): unknown {
  const state = options?.state ?? createState({
    messages: [],
    currentDateTime: "",
    threadId: "",
    runId: "",
    sessionId: "",
    previousSteps: [],
    interrupt: null,
    memory: {},
    context: {},
  });
  return createGraph(
    { ...options, name, state } as unknown as GraphOptions<StateFieldMap>,
  );
}

function createBuilder<
  TState extends object,
  TInput extends object,
  TOutput extends object,
  C extends GraphContracts,
  TVariables extends JsonObject,
  TGlobal extends JsonObject,
>({ definition, controls }: BuilderOptions<TState, TInput, TOutput, C, TVariables, TGlobal>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal> {
  const clone = (next: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal> => createBuilder({ definition: next, controls });
  const withNodes = (nodes: Record<string, NodeSpec<TState, C, TVariables, TGlobal>>): GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal> => ({ ...definition, nodes });
  const nodes = (): Record<string, NodeSpec<TState, C, TVariables, TGlobal>> => ({ ...definition.nodes });
  const withEdges = (edges: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>["edges"]): GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal> => ({ ...definition, edges });
  const capability = (name: string, values: readonly string[] = []): GraphBuilder<TState, TInput, TOutput, C, TVariables, TGlobal> => {
    controls.set(name, values);
    return clone(definition);
  };
  const resolveCheckpointer = (source: CheckpointSource | undefined): Checkpointer => {
    if (source === undefined) return createMemoryCheckpointer();
    return "checkpointer" in source ? source.checkpointer : source;
  };
  const nodeNames = (value: string | readonly string[] | undefined): readonly string[] =>
    value === undefined ? [] : typeof value === "string" ? [value] : value;
  const interruptRequest = (options: InterruptOptions): InterruptRequest<C["interrupt"]> => ({
    kind: options.type ?? "approval",
    prompt: options.text ?? "Human input is required before workflow execution can continue.",
    payload: (options.payload ?? null) as C["interrupt"],
    reason: options.reason,
  });
  const appendInterrupt = (
    current: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>,
    target: string | readonly string[] | undefined,
    mode: "before" | "after",
    options: InterruptOptions,
  ): GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal> => {
    const targets = nodeNames(target);
    if (targets.length === 0) return current;
    const request = interruptRequest(options);
    const interruptRequests = {
      ...(current.interruptRequests ?? {}),
      ...Object.fromEntries(targets.map((targetNode) => [targetNode, request])),
    } as Readonly<Record<string, InterruptRequest<C["interrupt"]>>>;
    return mode === "before"
      ? {
          ...current,
          interruptBefore: [...new Set([...(current.interruptBefore ?? []), ...targets])],
          interruptRequests,
        }
      : {
          ...current,
          interruptAfter: [...new Set([...(current.interruptAfter ?? []), ...targets])],
          interruptRequests,
        };
  };

  return {
    name: definition.name,
    state: definition.state,
    node(name, value) {
      const nextNodes = { ...nodes(), [name]: typeof value === "function" ? { fn: value } : value };
      return clone({ ...withNodes(nextNodes), entry: definition.entry || name });
    },
    edge(from, to, label) {
      return clone(withEdges([...definition.edges, edge(from, to, label)]));
    },
    conditional(from, route) {
      return clone(withEdges([...definition.edges, conditional(from, route.route, route.targets, route.label)]));
    },
    router(from, route) {
      return clone(withEdges([...definition.edges, conditional(from, route.route, route.targets, route.label)]));
    },
    start(name) {
      return clone({ ...definition, entry: name });
    },
    fanout(nodeName, field) {
      const current = nodes()[nodeName];
      if (!current) return clone(definition);
      return clone({
        ...withNodes({ ...nodes(), [nodeName]: { ...current, fanOut: field } }),
        fanouts: [...(definition.fanouts ?? []).filter((spec) => spec.node !== nodeName), { node: nodeName, field }],
      });
    },
    converge(field, maxRounds = definition.safety.recursionLimit) {
      return clone({ ...definition, converge: { on: field, maxRounds } });
    },
    dynamicFanout(nodeName, route) {
      const current = nodes()[nodeName];
      const nextNodes = current ? { ...nodes(), [nodeName]: { ...current, fanOut: route.field } } : nodes();
      return createBuilder({
        definition: {
          ...withNodes(nextNodes),
          edges: [...definition.edges, conditional(nodeName, route.route, route.targets, route.label)],
          fanouts: route.field === undefined
            ? definition.fanouts
            : [...(definition.fanouts ?? []).filter((spec) => spec.node !== nodeName), { node: nodeName, field: route.field }],
        },
        controls,
      });
    },
    join(upstreamOrTarget: readonly string[] | string | { readonly from: readonly string[]; readonly into: string }, target?: string) {
      const upstream: readonly string[] = typeof upstreamOrTarget === "string"
        ? definition.edges.filter((item): item is EdgeSpec<TState> => "from" in item && "to" in item).map((item) => item.from)
        : "from" in upstreamOrTarget
          ? upstreamOrTarget.from
          : upstreamOrTarget;
      const targetName = typeof upstreamOrTarget === "string" ? upstreamOrTarget : target ?? ("into" in upstreamOrTarget ? upstreamOrTarget.into : "");
      if (targetName.length === 0) return clone(definition);
      return clone({
        ...withEdges([...definition.edges, ...upstream.map((from) => edge(from, targetName))]),
        joins: [...(definition.joins ?? []).filter((spec) => spec.target !== targetName), { nodes: upstream, target: targetName }],
      });
    },
    map(fieldOrOptions: (keyof TState & string) | MapOptions<TState>, nodeName?: string) {
      if (typeof fieldOrOptions !== "string") {
        controls.set("map", [fieldOrOptions.into ?? "inferred"]);
        return clone(definition);
      }
      const field = fieldOrOptions;
      if (!nodeName) return clone(definition);
      const previous = definition.edges.length > 0 ? definition.edges[definition.edges.length - 1] : undefined;
      const from = previous && "to" in previous ? previous.to : definition.entry;
      const current = nodes()[from];
      const mapped = current
        ? { ...nodes(), [from]: { ...current, fanOut: field } }
        : nodes();
      return clone({
        ...withNodes(mapped),
        edges: [...definition.edges, edge(from, nodeName)],
        fanouts: current
          ? [...(definition.fanouts ?? []).filter((spec) => spec.node !== from), { node: from, field }]
          : definition.fanouts,
      });
    },
    reduce(fieldOrOptions: (keyof TState & string) | ReduceOptions<TState>, reducer?: StateReducer<TState>) {
      if (typeof fieldOrOptions !== "string") {
        controls.set(`reduce:${fieldOrOptions.from}`, [fieldOrOptions.into ?? fieldOrOptions.from]);
        return clone(definition);
      }
      const field = fieldOrOptions;
      if (!reducer) return clone(definition);
      controls.set(`reduce:${field}`, [reducer.name || field]);
      return clone({
        ...definition,
        reductions: [...(definition.reductions ?? []).filter((spec) => spec.field !== field), { field, reducer }],
      });
    },
    loop(nodeName, route) {
      return clone({
        ...withEdges([...definition.edges, conditional(nodeName, route.route, route.targets)]),
        loops: [...(definition.loops ?? []).filter((spec) => spec.node !== nodeName), { node: nodeName, route: route.route, targets: route.targets, maxRounds: route.maxRounds }],
        converge: { on: Object.keys(definition.state)[0] as keyof TState & string, maxRounds: route.maxRounds },
      });
    },
    subgraph(name: string, graph?: CompiledGraph<object>) {
      if (!graph) return capability("subgraph", [name]);
      return clone(withNodes({ ...nodes(), [name]: { fn: async () => Object.assign({} as Partial<TState>, (await graph.run({})).state) } }));
    },
    nestedGraph(name, graph) {
      return clone(withNodes({ ...nodes(), [name]: { fn: async () => Object.assign({} as Partial<TState>, (await graph.build().run({})).state) } }));
    },
    dynamicGraph(name, factory) {
      return clone(withNodes({ ...nodes(), [name]: { fn: async (state) => Object.assign({} as Partial<TState>, (await factory(state).build().run(state)).state) } }));
    },
    onError(route) {
      return clone({
        ...definition,
        errorRoutes: [...(definition.errorRoutes ?? []).filter((spec) => spec.node !== route.node), route],
      });
    },
    interruptBefore(...nodeNames) {
      return clone({ ...definition, interruptBefore: [...(definition.interruptBefore ?? []), ...nodeNames] });
    },
    interruptAfter(...nodeNames) {
      return clone({ ...definition, interruptAfter: [...(definition.interruptAfter ?? []), ...nodeNames] });
    },
    definition() {
      return { ...definition, nodes: { ...definition.nodes }, edges: [...definition.edges] };
    },
    compile(options) {
      const next = options?.verify ? { ...definition, verify: options.verify } : definition;
      return buildGraph(next);
    },
    build() {
      return buildGraph(definition);
    },
    reflect(options) {
      return capability("reflect", options?.threshold === undefined ? [] : [String(options.threshold)]);
    },
    plan() {
      return capability("plan");
    },
    replan() {
      return capability("replan");
    },
    route(routes) {
      return capability("route", Object.entries(routes).map(([label, target]) => `${label}:${target}`));
    },
    parallel(options = {}) {
      return capability("parallel", Object.keys(options));
    },
    retry(options = {}) {
      const normalized: RetrySpec = {
        attempts: Math.max(1, typeof options === "number" ? options : options.attempts ?? 1),
        backoff: typeof options === "number" ? "fixed" : options.backoff ?? "fixed",
      };
      controls.set("retry", [String(normalized.attempts)]);
      return clone({ ...definition, retries: [...(definition.retries ?? []), normalized] });
    },
    fallback(options = {}) {
      const policy = options.policy ?? "recover";
      if (policy === "rethrow") return capability("fallback", ["rethrow"]);
      if (options.node) {
        const fallback: FallbackSpec = { target: options.node, policy };
        controls.set("fallback", [options.node]);
        return clone({ ...definition, fallbacks: [...(definition.fallbacks ?? []), fallback] });
      }
      if (!options.run) return capability("fallback", []);
      const target = `__fallback_${definition.fallbacks?.length ?? 0}`;
      const fallback: FallbackSpec = { target, policy };
      const fallbackNode: NodeSpec<TState, C, TVariables, TGlobal> = {
        fn: async (state) => options.run!(state) as unknown as Partial<TState>,
        label: "Fallback recovery",
        stepLabel: "Fallback recovery",
      };
      controls.set("fallback", [target]);
      return clone({
        ...withNodes({ ...nodes(), [target]: fallbackNode }),
        fallbacks: [...(definition.fallbacks ?? []), fallback],
      });
    },
    guard(options = {}) {
      const guard: GuardSpec<TState> = {
        nodes: nodeNames(options.before),
        check: options.check ?? options.when ?? (() => true),
        message: options.message ?? options.policy,
      };
      controls.set("guard", guard.nodes.length === 0 ? ["all"] : guard.nodes);
      return clone({ ...definition, guards: [...(definition.guards ?? []), guard] });
    },
    approval(options = {}) {
      controls.set("approval", nodeNames(options.before));
      const targets = nodeNames(options.before);
      if (targets.length === 0) return clone(definition);
      const request = interruptRequest({ ...options, type: "approval" });
      const nextNodes = { ...nodes() };
      for (const target of targets) {
        const existing = nextNodes[target];
        if (!existing) continue;
        const priorGate = existing.gate;
        nextNodes[target] = {
          ...existing,
          gate: {
            name: `approval:${target}`,
            check: async (state, context) => {
              const priorDecision = priorGate ? await priorGate.check(state, context) : { kind: "allow" as const };
              if (priorDecision.kind !== "allow") return priorDecision;
              if (options.when && !(await options.when(state))) return { kind: "allow" };
              return { kind: "interrupt", request };
            },
          },
        };
      }
      return clone({ ...definition, nodes: nextNodes });
    },
    interrupt(options) {
      const normalized = options ?? {};
      controls.set("interrupt", normalized.type ? [normalized.type] : []);
      const before = appendInterrupt(definition, normalized.before, "before", normalized);
      return clone(appendInterrupt(before, normalized.after, "after", normalized));
    },
    transaction(options) {
      return capability("transaction", [options?.state ? "state" : "none", options?.sideEffects ? "side-effects" : "no-side-effects", options?.checkpoint ? "checkpoint" : "no-checkpoint"]);
    },
    rag() {
      return capability("rag");
    },
    supervisor() {
      return capability("supervisor");
    },
    evaluate() {
      return capability("evaluate");
    },
    remember() {
      return capability("remember");
    },
    checkpoint(source) {
      controls.set("checkpoint", [source === undefined ? "memory" : "configured"]);
      return clone({
        ...definition,
        runtime: {
          ...(definition.runtime ?? {}),
          checkpoint: resolveCheckpointer(source),
        },
      });
    },
  };
}

/** Process-local checkpoint store used by `.checkpoint()` when no adapter is supplied. */
function createMemoryCheckpointer(): Checkpointer {
  const checkpoints = new Map<string, Checkpoint>();
  return {
    async get(threadId) {
      // Map preserves insertion order. Prefer it to a timestamp sort because
      // multiple nodes can checkpoint within the same millisecond, where a
      // sort tie could return the oldest record and re-trigger an approval.
      const matching = [...checkpoints.values()]
        .filter((checkpoint) => checkpoint.threadId === threadId);
      return matching.at(-1) ?? null;
    },
    async put(checkpoint) {
      checkpoints.set(`${checkpoint.threadId}:${checkpoint.checkpointId}`, checkpoint);
    },
    async list(threadId) {
      return [...checkpoints.values()]
        .filter((checkpoint) => checkpoint.threadId === threadId)
        .sort((left, right) => left.createdAt - right.createdAt);
    },
  };
}

function isStateDescriptor<TState extends object>(value: StateDescriptor<TState> | StateFieldMap): value is StateDescriptor<TState> {
  return typeof value === "object" && value !== null && "__stateDescriptor" in value && value.__stateDescriptor === true;
}

/** Create a parser schema under the target facade name. */
export function createSchema<TValue>(name: string, parse: (value: JsonValue) => TValue): ValueSchema<TValue> {
  return { name, parse };
}

/** Create a bounded graph safety declaration. */
export function createSafety(recursionLimit = 100, timeoutMs = 120_000): SafetySpec {
  return { recursionLimit, timeoutMs };
}

/** Create a named step label metadata object. */
export function createStepLabel(label: string): { readonly label: string } {
  return { label };
}

/** Create a risk binding metadata object. */
export function createRisk(risk: "read" | "write" | "dangerous"): { readonly risk: "read" | "write" | "dangerous" } {
  return { risk };
}

/** Create a model-tier binding metadata object. */
export function createTier(tierName: string): { readonly tier: string } {
  return { tier: tierName };
}
