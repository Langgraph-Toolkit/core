/**
 * defineGraph(): the developer-facing DSL.
 *
 * Returns a GraphDefinition ready for compile(). Fails fast on misuse:
 * Rule N1 (one bounded job per node), N2 (typed state), E2 (deterministic
 * routing declared with explicit targets), L1 (converge for cycles),
 * L2 (safety limits), P5 (interruptBefore).
 */
import type {
  ConditionalEdgeSpec,
  ConvergeSpec,
  ConditionalRouteFn,
  DefaultGraphContracts,
  GraphContracts,
  GraphDefinition,
  GraphSchemas,
  Gate,
  GateContext,
  GateDecision,
  IntentAnalyzer,
  IntentClassification,
  IntentClassifier,
  IntentContext,
  ToolContext,
  ToolDefinition,
  JsonObject,
  NodeFunction,
  NodeSpec,
  SafetySpec,
  StateDescriptor,
  StateField,
  StateSchema,
  TierAlias,
  ValueSchema,
  VerifySpec,
} from "./types.js";
import { GraphDefinitionError, isReducedField } from "./types.js";

/** Options accepted by defineGraph(). See GraphDefinition for semantics. */
export interface DefineGraphOptions<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
> {
  name: string;
  state: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>["state"] | StateDescriptor<TState>;
  stateDefaults?: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>["stateDefaults"];
  nodes: Record<string, NodeSpec<TState, C, TVariables, TGlobal>>;
  entry?: string;
  edges?: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>["edges"];
  /** Optional: verifier gate nodes (Rule E3). Accepts either a node list
   * (DSL shorthand) or a full VerifySpec { nodes, fns } object. */
  verify?: string[] | VerifySpec<TState>;
  /** Optional: verifier functions wired to the gate nodes (Rule E3). */
  verifierFns?: VerifySpec<TState>["fns"];
  converge?: ConvergeSpec<TState>;
  /** Safe defaults are inferred when omitted. */
  safety?: SafetySpec;
  interruptBefore?: readonly string[];
  log?: boolean;
  schemas?: GraphSchemas<TInput, TOutput, C>;
  variables?: Partial<TVariables>;
  global?: Partial<TGlobal>;
}

/**
 * Declare a graph with the DSL. Validates basics and returns a
 * GraphDefinition for compile() / GraphRegistry.register().
 *
 * @example
 * defineGraph({
 *   name: "admin-chat",
 *   state: { messages: messagesValue<ChatMessage>() },
 *   nodes: { plan: node(planFn, { tier: "strong" }), exec: node(execFn) },
 *   entry: "plan",
 *   edges: [edge("plan", "exec"), conditional("exec", route, ["plan", "END"])],
 *   safety: safety(20, 30000),
 * })
 */
export function defineGraph<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(
  opts: DefineGraphOptions<TState, TInput, TOutput, C, TVariables, TGlobal>,
): GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal> {
  const entry = opts.entry ?? Object.keys(opts.nodes)[0];
  if (!entry) throw new GraphDefinitionError("defineGraph requires at least one node.");
  if (Array.isArray(opts.verify) && opts.verify.length > 0 && !opts.nodes[opts.verify[0]]) {
    // best-effort validation; full check happens in compile()
  }
  const stateDescriptor = isStateDescriptor(opts.state) ? opts.state : undefined;
  return {
    name: opts.name,
    state: stateDescriptor?.fields ?? (opts.state as StateSchema<TState>),
    stateDefaults: opts.stateDefaults ?? stateDescriptor?.defaults,
    nodes: opts.nodes,
    entry,
    edges: opts.edges ?? [],
    verify: Array.isArray(opts.verify)
      ? { nodes: opts.verify, fns: opts.verifierFns ?? [] }
      : (opts.verify as GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>["verify"]),
    converge: opts.converge,
    safety: opts.safety ?? safety(100, 120_000),
    interruptBefore: opts.interruptBefore,
    log: opts.log,
    schemas: opts.schemas,
    variables: opts.variables,
    global: opts.global,
  };
}

function isStateDescriptor<TState extends object>(value: StateSchema<TState> | StateDescriptor<TState>): value is StateDescriptor<TState> {
  return typeof value === "object" && value !== null && "__stateDescriptor" in value && value.__stateDescriptor === true;
}

/** Define a state schema whose field values also become initial state defaults. */
export function defineState<TState extends object>(fields: StateSchema<TState>): StateDescriptor<TState> {
  const defaults: Partial<TState> = {};
  for (const key of Object.keys(fields) as Array<keyof TState>) {
    const field = fields[key] as StateField<TState[typeof key]>;
    defaults[key] = isReducedField(field) ? field.default : field;
  }
  return { __stateDescriptor: true, fields, defaults };
}

/**
 * Declare a node function, optionally bound to a model tier (Rule T3) and
 * a business risk classification (Rule A4: "dangerous" nodes interrupt
 * automatically unless listed in interruptBefore).
 */
export function node<
  TState extends object,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(
  fn: NodeFunction<TState, C, TVariables, TGlobal>,
  binding?: {
    tier?: TierAlias;
    risk?: import("./types.js").NodeRiskClass;
    label?: string;
    stepLabel?: string;
    gate?: import("./types.js").Gate<TState, C["interrupt"]>;
    tools?: readonly import("./types.js").ToolDefinition<object, C["toolCall"]>[];
    intent?: import("./types.js").IntentSpec<C["intent"]>;
  },
): NodeSpec<TState, C, TVariables, TGlobal> {
  if (!binding) return { fn };
  return {
    fn,
    binding: (binding as { tier?: TierAlias }).tier ? { tier: (binding as { tier: TierAlias }).tier } : undefined,
    risk: (binding as { risk?: import("./types.js").NodeRiskClass }).risk,
    label: (binding as { label?: string }).label,
    stepLabel: (binding as { stepLabel?: string }).stepLabel,
    gate: binding.gate,
    tools: binding.tools,
    intent: binding.intent,
  };
}

/** Create a typed schema parser used for graph input/output and tool payloads. */
export function schema<T>(name: string, parse: (value: import("./types.js").JsonValue) => T): ValueSchema<T> {
  return { name, parse };
}

/** Create a typed gate that returns allow, deny, or an interrupt request. */
export function gate<TState extends object, TInterrupt extends import("./types.js").JsonValue = import("./types.js").JsonValue>(
  name: string,
  check: (state: TState, ctx: GateContext) => GateDecision<TInterrupt> | Promise<GateDecision<TInterrupt>>,
): Gate<TState, TInterrupt> {
  return { name, check };
}

/** Create a typed tool definition that can be invoked from a node context. */
export function tool<TArgs extends object, TResult extends import("./types.js").JsonValue>(
  definition: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  return definition;
}

/** Create a typed intent classifier for deterministic graph routing. */
export function intent<TInput extends object, TIntent extends string>(
  name: string,
  classify: (input: TInput, ctx: IntentContext) => TIntent | Promise<TIntent>,
): IntentClassifier<TInput, TIntent> {
  return { name, classify };
}

/** Create an LLM-backed intent analyzer that returns typed details and observability metadata. */
export function intentAnalyzer<TInput extends object, TIntent extends string, TDetails extends JsonObject>(
  name: string,
  analyze: (input: TInput, ctx: IntentContext) => IntentClassification<TIntent, TDetails> | Promise<IntentClassification<TIntent, TDetails>>,
): IntentAnalyzer<TInput, TIntent, TDetails> {
  return { name, analyze };
}

/** Business risk classification for a node (Rule A4). */
export function risk(r: import("./types.js").NodeRiskClass): { risk: import("./types.js").NodeRiskClass } {
  return { risk: r };
}

/** Directed edge from A to B. If B is "END" the branch terminates there. */
export function edge<TState extends object = object>(from: string, to: string, label?: string) {
  return { from, to, label } as { from: string; to: string; label?: string };
}

/**
 * Conditional edge (Rule E2): routing fn is pure deterministic code over the
 * typed state. The model may return an enum; code decides the branch.
 * `targets` is the allow-list: routing cannot escape it (fail fast at runtime).
 */
export function conditional<TState extends object>(
  from: string,
  fn: ConditionalRouteFn<TState>,
  targets: readonly string[],
  label?: string,
): ConditionalEdgeSpec<TState> {
  if (targets.length === 0) {
    throw new GraphDefinitionError(`Conditional edge from "${from}" must declare at least one target.`);
  }
  return { from, fn, targets, label };
}

/**
 * Convergence declaration for cycles (Rule L1). Mandatory when an edge
 * creates a loop; `on` names the state field the loop must stabilize on.
 */
export function converge<TState extends object>(
  on: keyof TState & string,
  maxRounds: number,
): ConvergeSpec<TState> {
  return { on, maxRounds };
}

/**
 * Safety limits (Rule L2). recursionLimit is mandatory at compile time;
 * timeoutMs caps per-run wall-clock duration.
 */
export function safety(recursionLimit = 100, timeoutMs = 120_000): SafetySpec {
  return { recursionLimit, timeoutMs };
}

/** Stable label metadata for a node or edge in streamed execution. */
export function stepLabel(label: string): { label: string } {
  return { label };
}

/** Tier binding helper for node() (Rule T3). */
export function tier(t: TierAlias): { tier: TierAlias } {
  return { tier: t };
}
