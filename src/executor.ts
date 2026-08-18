/**
 * executor: runtime for CompiledGraph.
 *
 * Implements the execution loop with:
 * - recursionLimit + timeout safety (Rule L2)
 * - deterministic pure routing (Rule E2)
 * - reducer merging of state updates (Rule N2)
 * - interruptBefore for expensive side effects (Rule P5)
 * - verifier gates before stopping (Rule E3)
 * - structured step events for observability (Rule P3)
 * - cancellation support (Rule L2)
 */
import { randomUUID } from "node:crypto";
import type {
  Actor,
  Checkpoint,
  CompiledGraph,
  GraphDefinition,
  IntentAnalysis,
  IntentAnalyzer,
  IntentClassification,
  IntentClassifier,
  JsonObject,
  JsonValue,
  NodeContext,
  InterruptRequest,
  RunOptions,
  RunResult,
  StepEvent,
  DefaultGraphContracts,
  GraphContracts,
} from "./types.js";
import {
  CancelledError,
  GraphDefinitionError,
  GraphRuntimeError,
  InterruptSignal,
  PermissionDeniedError,
  SafetyLimitExceededError,
  TokenBudgetExceededError,
} from "./types.js";
import type { ModelRegistry, Checkpointer } from "./types.js";
import { compile } from "./compile.js";

type RuntimeField = JsonValue | object;
type RuntimeShape = {
  readonly __reduced?: boolean;
  readonly default?: RuntimeField;
  readonly reducer?: (prev: RuntimeField, next: RuntimeField) => RuntimeField;
};
type RuntimeMap = Record<string, RuntimeField | RuntimeShape | undefined>;

type QueueResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "closed" };

/** Internal async queue that bridges node callbacks to the stream consumer. */
class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: QueueResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ kind: "value", value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ kind: "closed" });
  }

  next(): Promise<QueueResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ kind: "value", value });
    if (this.closed) return Promise.resolve({ kind: "closed" });
    return new Promise<QueueResult<T>>((resolve) => this.waiters.push(resolve));
  }

  drain(): T[] {
    const values = this.values.slice();
    this.values.length = 0;
    return values;
  }
}

type NodeExecutionOutcome<TState extends object, C extends GraphContracts> =
  | { readonly kind: "done"; readonly update: Partial<TState> }
  | { readonly kind: "interrupt"; readonly request: InterruptRequest<C["interrupt"]> }
  | { readonly kind: "route"; readonly target: string; readonly error: Error }
  | { readonly kind: "error"; readonly error: Error };

/**
 * Attach run()/stream() to a CompiledGraph, completing compile() output.
 * Prefer GraphRegistry.register() which calls both automatically.
 */
export function attachExecutor<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal> {
  graph.run = (input, opts) => execute(graph, input, opts);
  graph.stream = (input, opts) => streamEvents(graph, input, opts);
  graph.invoke = (input, opts) => execute(graph, input, opts);
  graph.resume = (threadId, response, opts) => execute(graph, {} as TInput, { ...opts, threadId, humanResponse: response });
  return graph;
}

/**
 * Build a runnable graph from either a DSL definition or an already compiled graph.
 *
 * The definition overload is the canonical zero-config path. It compiles and
 * attaches the executor in one call while preserving the explicit overload for
 * packages that perform compilation separately.
 */
export function buildGraph<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>;
export function buildGraph<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>;
export function buildGraph<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(graph: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal> | CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal> {
  const compiled = "adjacency" in graph ? graph : compile(graph);
  return attachExecutor(compiled);
}

function applyDefaults<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  input: Partial<TState>,
): TState {
  const defaults: Record<string, RuntimeField> = {};
  const stateShape = graph.definition.state as RuntimeMap;
  const stateDefaults = graph.definition.stateDefaults as Record<string, RuntimeField | undefined> | undefined;
  for (const [key, shape] of Object.entries(stateShape)) {
    if (shape === undefined) {
      const explicit = stateDefaults?.[key];
      if (explicit !== undefined) defaults[key] = explicit;
      continue;
    }
    if (shape === null) {
      defaults[key] = shape;
      continue;
    }
    const casted = shape as RuntimeShape;
    if (casted.__reduced) {
      // Use reduced field default; a stateDefaults value overrides it when present.
      const reducedDefault =
        stateDefaults?.[key] !== undefined
          ? stateDefaults[key]
          : casted.default;
      if (reducedDefault !== undefined) defaults[key] = reducedDefault;
    } else {
      // Raw state descriptors are the zero-config initial values. An explicit
      // stateDefaults entry remains an override for backwards compatibility.
      defaults[key] = stateDefaults?.[key] ?? shape;
    }
  }
  // Allow input to carry raw initial values for reduced fields (unwrap handled on first merge).
  // Rule N2: input is filtered by the state contract; undeclared keys are dropped.
  for (const [key, value] of Object.entries(input as Record<string, RuntimeField>)) {
    const shape = stateShape[key];
    if (shape === undefined) {
      // Rule N2: undeclared input fields are ignored at the state boundary.
      continue;
    }
    const casted = shape as RuntimeShape;
    const nextValue = casted?.__reduced ? (value ?? casted.default) : value;
    if (nextValue !== undefined) defaults[key] = nextValue;
  }
  return applyStateOptions(graph, defaults);
}

function mergeState<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  prev: TState,
  update: Partial<TState>,
): TState {
  const out = { ...(prev as object) } as Record<string, RuntimeField>;
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    const shape = (graph.definition.state as RuntimeMap)[key];
    if (!(key in graph.definition.state)) {
      throw new GraphRuntimeError(
        `Node wrote to an undeclared state field "${key}". State is a typed contract (Rule N2).`,
      );
    }
    if (shape === undefined) {
      out[key] = value as RuntimeField;
      continue;
    }
    if (shape === null) {
      out[key] = value as RuntimeField;
      continue;
    }
    const casted = shape as RuntimeShape;
    const declaredReducer = graph.definition.stateOptions?.reducers?.[key as keyof TState];
    if (typeof declaredReducer === "function") {
      const reducer = declaredReducer as unknown as (previous: RuntimeField, next: RuntimeField) => RuntimeField;
      out[key] = reducer(out[key], value as RuntimeField);
    } else if (declaredReducer === "append") {
      const previous = Array.isArray(out[key]) ? out[key] : [];
      const next = Array.isArray(value) ? value : [value];
      out[key] = [...previous, ...next] as RuntimeField;
    } else if (declaredReducer === "merge") {
      const previous = isRuntimeRecord(out[key]) ? out[key] : {};
      const next = isRuntimeRecord(value) ? value : {};
      out[key] = { ...previous, ...next };
    } else if (casted.__reduced && casted.reducer) {
      out[key] = casted.reducer(out[key] as RuntimeField, value as RuntimeField);
    } else {
      out[key] = value as RuntimeField;
    }
  }
  return copyFrameworkState(prev, applyStateOptions(graph, out));
}

const frameworkStateKeys = ["messages", "currentDateTime", "threadId", "runId", "sessionId", "previousSteps", "interrupt", "memory", "context"] as const;

function injectFrameworkState<TState extends object>(state: TState, values: Readonly<Partial<Record<(typeof frameworkStateKeys)[number], RuntimeField>>>): TState {
  const properties: PropertyDescriptorMap = {};
  for (const key of frameworkStateKeys) {
    if (Object.prototype.hasOwnProperty.call(state, key)) continue;
    properties[key] = {
      configurable: true,
      enumerable: false,
      value: values[key] ?? defaultFrameworkState(key),
      writable: true,
    };
  }
  Object.defineProperties(state, properties);
  return state;
}

function copyFrameworkState<TState extends object>(previous: TState, next: TState): TState {
  const properties: PropertyDescriptorMap = {};
  for (const key of frameworkStateKeys) {
    if (Object.prototype.hasOwnProperty.call(next, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(previous, key);
    if (descriptor) properties[key] = descriptor;
  }
  if (Object.keys(properties).length > 0) Object.defineProperties(next, properties);
  return next;
}

function defaultFrameworkState(key: (typeof frameworkStateKeys)[number]): RuntimeField {
  if (key === "messages" || key === "previousSteps") return [];
  if (key === "interrupt") return null;
  if (key === "memory" || key === "context") return {};
  return "";
}

function isRuntimeRecord(value: RuntimeField | undefined): value is Record<string, RuntimeField> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyStateOptions<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  values: Record<string, RuntimeField>,
): TState {
  const options = graph.definition.stateOptions;
  if (options?.derived) {
    for (const [key, derive] of Object.entries(options.derived)) {
      values[key] = derive(values as TState) as RuntimeField;
    }
  }
  if (options?.validate === true && Object.values(values).some((value) => value === undefined)) {
    throw new GraphRuntimeError("State validation failed because a declared field is undefined.");
  }
  if (typeof options?.validate === "function" && !options.validate(values as TState)) {
    throw new GraphRuntimeError("State validation rejected the current graph state.");
  }
  return values as TState;
}

function diffState<TState extends object>(before: TState, after: TState): Partial<TState> {
  const previous = before as object as Record<string, RuntimeField>;
  const next = after as object as Record<string, RuntimeField>;
  const diff: Record<string, RuntimeField> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) diff[key] = value;
  }
  return diff as Partial<TState>;
}

function resolveTargets<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  node: string,
  state: TState,
): string[] {
  const adj = graph.adjacency.get(node);
  if (!adj) return ["END"];
  const targets: string[] = [...adj.fixed];
  for (const cond of adj.conditional) {
    const decision = cond.fn(state);
    const chosen = Array.isArray(decision) ? decision : [decision];
    for (const c of chosen) {
      if (!cond.targets.includes(c)) {
        throw new GraphRuntimeError(
          `Conditional edge from "${node}" returned "${c}", which is not in its declared targets [${cond.targets.join(", ")}]. Routing must be deterministic and bounded (Rule E2).`,
        );
      }
      if (!targets.includes(c)) targets.push(c);
    }
  }
  return targets;
}

async function persist<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  cp: import("./types.js").Checkpointer<TState, C["interrupt"], TVariables> | undefined,
  threadId: string,
  state: TState,
  node: string,
  round: number,
  pendingInterrupt?: Checkpoint<TState, C["interrupt"], TVariables>["pendingInterrupt"],
): Promise<void> {
  if (!cp) return;
  await cp.put({
    threadId,
    checkpointId: randomUUID(),
    state,
    node,
    round,
    pendingInterrupt,
    createdAt: Date.now(),
  });
}

function loadCheckpointer<TState extends object, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject>(opts?: RunOptions<C, TVariables>): Checkpointer<TState, C["interrupt"], TVariables> | undefined {
  if (!opts?.checkpoint) return undefined;
  return opts.checkpoint as Checkpointer<TState, C["interrupt"], TVariables>;
}

function resolveRunOptions<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  opts: RunOptions<C, TVariables, TGlobal>,
): RunOptions<C, TVariables, TGlobal> {
  const runtime = graph.definition.runtime;
  return {
    ...runtime,
    ...opts,
    variables: {
      ...(graph.definition.variables ?? {}),
      ...(runtime?.variables ?? {}),
      ...(opts.variables ?? {}),
    } as Partial<TVariables>,
    global: {
      ...(graph.definition.global ?? {}),
      ...(runtime?.global ?? {}),
      ...(opts.global ?? {}),
    } as Partial<TGlobal>,
  };
}

/**
 * Return the last checkpoint for the run's thread, if resume state applies.
 * Used by Rule A4 to avoid re-interrupting a dangerous node that the human
 * already approved in a previous paused run.
 */
async function checkpointNode<C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(opts?: RunOptions<C, TVariables, TGlobal>): Promise<{ node: string; mode?: import("./types.js").InterruptMode } | undefined> {
  const cp = opts?.checkpoint ? loadCheckpointer<object, C, TVariables>(opts) : undefined;
  if (!cp || !opts?.threadId) return undefined;
  const last = await cp.get(opts.threadId);
  return last ? { node: last.node, mode: last.pendingInterrupt?.mode } : undefined;
}

// ---------- Token budget enforcement (Rule A3) ----------

const tokenLedger = new Map<string, { tokens: number; windowStart: number }>();

/**
 * Wrap an LLMProvider so that each chat() call charges its reported token
 * usage against the actor budget. When the budget for the tier is exceeded,
 * chat() rejects with TokenBudgetExceededError before calling the vendor.
 * The ledger is per (actor.id, tier) and resets after windowMs.
 */
export function withTokenBudget(
  provider: import("./types.js").LLMProvider,
  budget: import("./types.js").TokenBudget | undefined,
  actor: Actor | undefined,
): import("./types.js").LLMProvider {
  if (!budget || !actor) return provider;
  const reserve = (used: number, tier: string, spec: import("./types.js").TokenBudgetSpec, entry: { tokens: number; windowStart: number }): void => {
    if (used <= 0) return;
    if (entry.tokens + used > spec.limit) {
      throw new TokenBudgetExceededError(tier, spec.limit);
    }
    entry.tokens += used;
  };

  const ledgerEntry = (tier: string, spec: import("./types.js").TokenBudgetSpec): { tokens: number; windowStart: number } => {
    const key = `${actor.id}:${tier}`;
    const now = Date.now();
    const windowMs = spec.windowMs ?? 86400000;
    let entry = tokenLedger.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { tokens: 0, windowStart: now };
      tokenLedger.set(key, entry);
    }
    return entry;
  };

  return {
    ...provider,
    async chat(messages, opts) {
      const tier = provider.name.split(":")[1] ?? "__default__";
      const spec = budget.perTier[tier];
      if (!spec || spec.limit <= 0) return provider.chat(messages, opts);
      const entry = ledgerEntry(tier, spec);
      const current = provider;
      const result = await current.chat(messages, opts);
      const used = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      reserve(used, tier, spec, entry);
      return result;
    },
    async *streamDetailed(messages, opts) {
      const tier = provider.name.split(":")[1] ?? "__default__";
      const spec = budget.perTier[tier];
      if (!spec || spec.limit <= 0) {
        if (provider.streamDetailed) {
          yield* provider.streamDetailed(messages, opts);
        } else {
          for await (const value of provider.stream(messages, opts)) yield { type: "token", value };
        }
        return;
      }
      const entry = ledgerEntry(tier, spec);
      const stream = provider.streamDetailed
        ? provider.streamDetailed(messages, opts)
        : (async function* (): AsyncIterable<import("./types.js").ChatStreamChunk> {
            for await (const value of provider.stream(messages, opts)) yield { type: "token", value };
          })();
      for await (const chunk of stream) {
        if (chunk.type === "usage") {
          reserve(chunk.value.inputTokens + chunk.value.outputTokens, tier, spec, entry);
        }
        yield chunk;
      }
    },
  };
}

/** Reset the token ledger (useful for tests). */
export function resetTokenLedger(): void {
  tokenLedger.clear();
}

/**
 * Check whether a ModelRegistry exposes a given tier alias without throwing.
 * Replaces the previous "throw when alias missing" behavior so that unbound
 * nodes (falling back to "__default__") run without a model instead of
 * crashing a run whose other nodes have valid bindings.
 */
function tierAliasInRegistry(registry: ModelRegistry, alias: string): boolean {
  try {
    registry.tier(alias);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prompt contract for declarative `.plan()` consumption (PlanSpec). The model
 * must reply with ONLY a JSON array of short strings; parsePlanResult()
 * enforces that shape defensively.
 */
function planPrompt(state: object, produce: "subtasks" | "route"): string {
  const mode = produce === "route"
    ? "the ordered execution steps to follow"
    : "concrete subtasks to execute";
  return [
    `Decide ${mode} for the task below.`,
    'Reply with ONLY a JSON array of short strings, e.g. ["fetch data", "summarize"]. No prose.',
    `Task context: ${JSON.stringify(state)}`,
  ].join("\n");
}

/** Parse the plan model reply. Expects a JSON array of strings; throws on drift. */
function parsePlanResult(content: string): readonly string[] {
  const trimmed = content.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new GraphRuntimeError(
      `plan() model reply is not valid JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new GraphRuntimeError(
      `plan() model reply must be a JSON array of strings, got: ${trimmed.slice(0, 200)}`,
    );
  }
  return parsed as string[];
}

export async function execute<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  input: TInput,
  opts: RunOptions<C, TVariables, TGlobal> = {},
): Promise<RunResult<TState, TOutput, C["interrupt"], TVariables>> {
  const effectiveOpts = resolveRunOptions(graph, opts);
  const events: StepEvent<TState, C>[] = [];
  let result: RunResult<TState, TOutput, C["interrupt"], TVariables>;
  try {
    for await (const event of streamEvents(graph, input, effectiveOpts)) {
      events.push(event);
    }
    const last = events[events.length - 1];
    if (last?.type === "error" && last.data && typeof last.data === "object" && "error" in (last.data as object)) {
      throw (last.data as { error: Error }).error;
    }
    const finalState = (last?.data as { state: TState })?.state ?? applyDefaults(graph, input as Partial<TState>);
    const stoppedReason: RunResult<TState, TOutput, C["interrupt"], TVariables>["stoppedReason"] = last?.type === "interrupt" ? "interrupt" : last?.type === "cancelled" ? "cancelled" : last?.type === "safety" ? "safety" : "done";
    const output = stoppedReason === "done"
      ? graph.definition.schemas?.output?.parse(finalState as JsonValue) ?? (finalState as never as TOutput)
      : undefined;
    result = {
      state: finalState,
      output,
      variables: effectiveOpts.variables as Readonly<TVariables> | undefined,
      stoppedAt: last?.node ?? null,
      stoppedReason,
      interrupt: last?.type === "interrupt" ? last.data.request : undefined,
    };
  } catch (err) {
    let reason: RunResult<TState>["stoppedReason"] = "error";
    if (err instanceof SafetyLimitExceededError) reason = "safety";
    else if (err instanceof CancelledError) reason = "cancelled";
    return {
      state: applyDefaults(graph, input as Partial<TState>),
      stoppedAt: null,
      stoppedReason: reason,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  return result;
}

export async function* streamEvents<TState extends object, TInput extends object = Partial<TState>, TOutput extends object = TState, C extends GraphContracts = DefaultGraphContracts, TVariables extends JsonObject = JsonObject, TGlobal extends JsonObject = JsonObject>(
  graph: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  input: TInput,
  opts: RunOptions<C, TVariables, TGlobal> = {},
): AsyncGenerator<StepEvent<TState, C>, void, void> {
  opts = resolveRunOptions(graph, opts);
  const runId = randomUUID();
  const threadId = opts.threadId ?? randomUUID();
  const safety = graph.safety;
  const cancellation = opts.cancellation;

  // Rule A1: RunPolicy decides before the first node executes.
  if (opts.policy && opts.actor) {
    const decision = await opts.policy(opts.actor, graph.name, { threadId });
    if (decision === "deny") {
      throw new PermissionDeniedError(
        `Actor "${opts.actor.id}" is not allowed to run graph "${graph.name}".`,
        opts.actor,
        graph.name,
      );
    }
    if (decision === "interrupt") {
      yield { type: "interrupt", graph: graph.name, threadId, runId, ts: Date.now(), data: { reason: "policy" } };
      return;
    }
  } else if (opts.policy && !opts.actor) {
    throw new PermissionDeniedError(
      `RunPolicy requires an actor in RunOptions; received none.`,
    );
  }

  // Timeout safety
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = safety.timeoutMs
    ? new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new SafetyLimitExceededError(`timeout ${safety.timeoutMs}ms`)),
          safety.timeoutMs,
        );
      })
    : undefined;

  try {
    // A resumed graph may intentionally receive no new input. Hydrate the
    // persisted state before validation so required application fields, such
    // as Chat-MCP's query, come from the checkpoint instead of being rejected
    // before the resume node receives ctx.answer.
    const cp = loadCheckpointer<TState, C, TVariables>(opts);
    const lastCheckpoint = cp && !opts.resumeFrom ? await cp.get(threadId) : null;
    const checkpointInput = lastCheckpoint === null
      ? input
      : { ...lastCheckpoint.state, ...input };
    let state = applyDefaults(graph, checkpointInput);
    state = injectFrameworkState(state, {
      currentDateTime: new Date().toISOString(),
      threadId,
      runId,
      sessionId: threadId,
    });
    let node = graph.entry;
    let round = 0;

    // Resume from checkpoint
    if (lastCheckpoint) {
      node = lastCheckpoint.node === "END" ? graph.entry : lastCheckpoint.node;
      round = lastCheckpoint.round;
    }

    // Declarative PlanSpec (fluent `.plan()`): resolve the bound tier through
    // the run's ModelRegistry and produce the plan before the first node runs.
    // Skipped on a resumed thread -- the first run's plan is persisted in state.
    const plan = graph.definition.plan;
    if (plan && !lastCheckpoint && !opts.resumeFrom) {
      const registry = opts.modelRegistry;
      const tierAlias = plan.tier ?? "__default__";
      const model = registry && tierAliasInRegistry(registry, tierAlias)
        ? registry.tier(tierAlias)
        : undefined;
      if (!model) {
        throw new GraphDefinitionError(
          `plan() requires a bound model tier "${tierAlias}". Supply a modelRegistry with this tier configured.`,
        );
      }
      const result = await model.chat([
        { role: "user", content: planPrompt(state, plan.produce) },
      ]);
      state = mergeState(graph, state, {
        [plan.into]: parsePlanResult(result.content),
      } as Partial<TState>);
    }

    const seen = new Set<string>(); // Rule L1: dry-loop dedupe on ALL visited
    const completedNodes = new Set<string>();
    const pendingNodes: string[] = [];
    const loopRounds = new Map<string, number>();

    while (node !== "END" || pendingNodes.length > 0) {
      if (node === "END") {
        node = pendingNodes.shift() ?? "END";
        if (node === "END") break;
      }
      const repeatable = graph.loops.some((spec) => spec.node === node);
      if (completedNodes.has(node) && !repeatable && graph.converge === undefined) {
        node = pendingNodes.shift() ?? "END";
        continue;
      }
      round++;
      if (round > safety.recursionLimit) {
        yield { type: "safety", graph: graph.name, threadId, runId, ts: Date.now(), data: { reason: `recursionLimit ${safety.recursionLimit}` } };
        throw new SafetyLimitExceededError(`recursionLimit ${safety.recursionLimit}`);
      }
      if (cancellation?.isCancelled()) {
        yield { type: "cancelled", graph: graph.name, threadId, runId, ts: Date.now() };
        throw new CancelledError(threadId);
      }
      if (opts.signal?.aborted) {
        yield { type: "cancelled", graph: graph.name, threadId, runId, ts: Date.now() };
        throw new CancelledError(threadId);
      }

      const nodeSpec = graph.definition.nodes[node];
      const join = graph.joins.find((spec) => spec.target === node);
      if (join && !join.nodes.every((source) => completedNodes.has(source))) {
        const waiting = join.nodes.find((source) => !completedNodes.has(source));
        if (waiting) {
          node = waiting;
          continue;
        }
      }
      const loop = graph.loops.find((spec) => spec.node === node);
      if (loop) {
        const nextRound = (loopRounds.get(node) ?? 0) + 1;
        if (nextRound > loop.maxRounds) {
          yield { type: "safety", graph: graph.name, threadId, runId, node, ts: Date.now(), data: { reason: `loop ${node} exceeded ${loop.maxRounds} rounds` } };
          throw new SafetyLimitExceededError(`loop ${node} exceeded ${loop.maxRounds} rounds`);
        }
        loopRounds.set(node, nextRound);
      }
      const nodeStep = { id: node, label: nodeSpec?.stepLabel ?? nodeSpec?.label ?? node, kind: "node" as const };
      yield { type: "node_start", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now() };
      const t0 = Date.now();

      if (node !== graph.entry) {
        seen.add(node);
      }

      // Rule P5/A4: resolve the paused checkpoint node ONCE per iteration,
      // before interrupt logic (both guards compare against this value).
      const cpNode = await checkpointNode<C, TVariables, TGlobal>(opts);
      // Reuse the checkpoint already resolved during checkpoint-first state
      // hydration. This preserves approval context even when a host supplied
      // the checkpointer through graph runtime configuration.
      const wasPausedAtThisNode = Boolean(
        lastCheckpoint?.node === node || (cpNode && cpNode.node === node),
      );

      // Rule P5: interrupt before executing the node. When resuming from a
      // checkpoint paused at this same node (or explicitly via resumeFrom),
      // the interrupt was already granted in the previous run, so merge the
      // human response if supplied and continue without re-pausing.
      if (
        graph.interruptBefore.has(node) &&
        (opts.resumeFrom === node || wasPausedAtThisNode) &&
        opts.humanResponse !== undefined
      ) {
        // Route the human answer only to a declared state field. Graphs that
        // do not model conversational messages still receive the response via
        // ctx.answer and must not fail validation from an implicit messages key.
        const shapeKeys = Object.keys(graph.definition.state);
        const humanUpdate: Record<string, JsonValue> = shapeKeys.includes("response")
          ? { response: opts.humanResponse }
          : shapeKeys.includes("messages")
            ? { messages: [{ role: "user" as const, content: String(opts.humanResponse) }] }
            : {};
        yield { type: "answer", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { value: opts.humanResponse } };
        if (Object.keys(humanUpdate).length > 0) state = mergeState(graph, state, humanUpdate as Partial<TState>);
      } else if (
        graph.interruptBefore.has(node) &&
        !wasPausedAtThisNode &&
        !(opts.resumeFrom === node && opts.humanResponse !== undefined)
      ) {
        const request = graph.definition.interruptRequests?.[node];
        yield { type: "interrupt", graph: graph.name, threadId, runId, node, ts: Date.now(), data: { request, state } };
        await persist(graph, cp, threadId, state, node, round, { node, mode: "before", request });
        return; // pause; host decides how to surface it
      }

      const registry = opts.modelRegistry;
      let tierAlias = nodeSpec?.binding?.tier ?? "__default__";
      // Rule A2: dynamic tier selection based on the actor (e.g. free/pro).
      if (opts.tierResolver && opts.actor && nodeSpec?.binding?.tier) {
        tierAlias = await opts.tierResolver(opts.actor, { tier: nodeSpec.binding.tier }, graph.name);
      }
      // Unbound nodes (no tier binding) fall back to __default__; when the
      // registry has no __default__ tier the node simply runs without a
      // model instead of throwing (Rule T3: bindings are opt-in).
      const model = registry && tierAliasInRegistry(registry, tierAlias)
        ? registry.tier(tierAlias)
        : undefined;

      // Rule A4: dangerous nodes require explicit approval via interrupt.
      // The interrupt fires once per pause: when resuming from a checkpoint
      // whose paused node IS this dangerous node, approval has already been
      // granted and the node must run without re-pausing.
      if (nodeSpec?.risk === "dangerous" && !graph.interruptBefore.has(node) && !wasPausedAtThisNode) {
        yield { type: "interrupt", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { reason: "dangerous", state } };
        await persist(graph, cp, threadId, state, node, round, { node, mode: "before" });
        return;
      }

      // An approval fluent primitive is represented as a node gate. After a
      // before-node checkpoint is resumed with a human response, that gate was
      // already satisfied for this execution and must not immediately pause
      // the same node again.
      const resumedApprovalExecution = lastCheckpoint?.pendingInterrupt?.mode === "before"
        && opts.humanResponse !== undefined;
      const resumeApprovedGate = (wasPausedAtThisNode || (
        resumedApprovalExecution && nodeSpec?.gate?.name.startsWith("approval:") === true
      )) && opts.humanResponse !== undefined;
      if (nodeSpec?.gate && !resumeApprovedGate) {
        const variables = { ...(graph.definition.variables ?? {}), ...(opts.variables ?? {}) } as JsonObject;
        const global = { ...(graph.definition.global ?? {}), ...(opts.global ?? {}) } as JsonObject;
        const decision = await nodeSpec.gate.check(state, { threadId, runId, actor: opts.actor, variables, global });
        if (decision.kind === "deny") {
          throw new PermissionDeniedError(`Gate "${nodeSpec.gate.name}" denied node "${node}". ${decision.reason}`, opts.actor, graph.name);
        }
        if (decision.kind === "interrupt") {
          yield { type: "interrupt", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { request: decision.request, state, reason: "gate" } };
          await persist(graph, cp, threadId, state, node, round, { node, mode: "before", request: decision.request });
          return;
        }
      }

      for (const guard of graph.definition.guards ?? []) {
        if (guard.nodes.length > 0 && !guard.nodes.includes(node)) continue;
        if (!(await guard.check(state))) {
          throw new PermissionDeniedError(
            guard.message ?? `Guard denied node "${node}".`,
            opts.actor,
            graph.name,
          );
        }
      }

      // Rule A3: token budget accounting. Wrapped provider charges against
      // the actor budget when chat() reports usage.
      const chargedModel = model
        ? withTokenBudget(model, opts.tokenBudget, opts.actor)
        : undefined;

      const eventQueue = new AsyncEventQueue<StepEvent<TState, C>>();
      const variables = { ...(graph.definition.variables ?? {}), ...(opts.variables ?? {}) } as JsonObject;
      const global = { ...(graph.definition.global ?? {}), ...(opts.global ?? {}) } as JsonObject;
      const nodeModel = chargedModel ?? { chat: () => Promise.reject(new GraphRuntimeError("No model bound for this node; configure ModelRegistry (Rule T3).")) };
      const ctx: NodeContext<TState, C, TVariables, TGlobal> = {
        graph: graph.name,
        threadId,
        runId,
        signal: opts.signal,
        emit(step) {
          eventQueue.push(step);
        },
        emitError(message, cause) {
          eventQueue.push({
            type: "error",
            graph: graph.name,
            threadId,
            runId,
            node,
            step: nodeStep,
            ts: Date.now(),
            data: { error: new GraphRuntimeError(message, cause) },
          });
        },
        model: nodeModel,
        cancelled: () => cancellation?.isCancelled() ?? opts.signal?.aborted ?? false,
        variables: variables as TVariables,
        global: global as TGlobal,
        answer: wasPausedAtThisNode ? opts.humanResponse : undefined,
        think(value, label) {
          eventQueue.push({ type: "thinking", graph: graph.name, threadId, runId, node, step: { id: `${node}:thinking`, label: label ?? "Thinking", kind: "node" }, ts: Date.now(), data: { value } });
        },
        interrupt(request) {
          throw new InterruptSignal(request);
        },
        ask(request) {
          throw new InterruptSignal(request);
        },
        async callTool(tool, args) {
          eventQueue.push({ type: "tool_start", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { name: tool.name, args: args as C["toolCall"] } });
          const result = await tool.execute(args, { threadId, runId, actor: opts.actor, variables, global });
          eventQueue.push({ type: "tool_end", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { name: tool.name, result } });
          return result;
        },
        async runAgent(agent, input) {
          let tokenIndex = 0;
          let reasoningIndex = 0;
          let content = "";
          const toolCalls: string[] = [];
          for await (const chunk of agent.stream(input, {
            signal: opts.signal,
            threadId,
            runId,
            actor: opts.actor,
            variables,
            global,
          })) {
            if (chunk.type === "token") {
              content += chunk.value;
              eventQueue.push({ type: "token", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { value: chunk.value, index: tokenIndex++ } });
            } else if (chunk.type === "reasoning") {
              eventQueue.push({ type: "reasoning", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { value: chunk.value, index: reasoningIndex++ } });
            } else if (chunk.type === "tool_start") {
              toolCalls.push(chunk.call.name);
              eventQueue.push({ type: "tool_start", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { name: chunk.call.name, args: chunk.call.arguments as C["toolCall"] } });
            } else if (chunk.type === "tool_end") {
              eventQueue.push({ type: "tool_end", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { name: chunk.call.name, result: chunk.result } });
            } else if (chunk.type === "usage") {
              eventQueue.push({ type: "usage", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { tier: nodeSpec.binding?.tier ?? agent.name, value: chunk.usage } });
            } else if (chunk.type === "output") {
              content = chunk.output.content ?? content;
              for (const call of chunk.output.toolCalls ?? []) toolCalls.push(call.name);
            } else if ("error" in chunk) {
              eventQueue.push({ type: "error", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { error: chunk.error } });
              throw chunk.error;
            }
          }
          return { agent: agent.name, content, toolCalls };
        },
        async detectIntent<TInput extends object, TIntent extends string>(classifier: IntentClassifier<TInput, TIntent>, value: TInput) {
          const detected = await classifier.classify(value, {
            threadId,
            runId,
            actor: opts.actor,
            model: nodeModel,
            emitAnalysis: () => undefined,
            emitToken: () => undefined,
            emitReasoning: () => undefined,
            emitUsage: () => undefined,
          });
          eventQueue.push({ type: "intent", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { name: classifier.name, value: detected as C["intent"] } });
          return detected;
        },
        async analyzeIntent<TInput extends object, TIntent extends string, TDetails extends JsonObject>(analyzer: IntentAnalyzer<TInput, TIntent, TDetails>, value: TInput): Promise<IntentClassification<TIntent, TDetails>> {
          let tokenIndex = 0;
          let reasoningIndex = 0;
          let latestAnalysis: IntentAnalysis | undefined;
          const result = await analyzer.analyze(value, {
            threadId,
            runId,
            actor: opts.actor,
            model: nodeModel,
            emitAnalysis(analysis) {
              latestAnalysis = analysis;
            },
            emitToken(value, index) {
              eventQueue.push({ type: "token", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { value, index: index >= 0 ? index : tokenIndex++ } });
            },
            emitReasoning(value, index) {
              eventQueue.push({ type: "reasoning", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { value, index: index >= 0 ? index : reasoningIndex++ } });
            },
            emitUsage(value) {
              eventQueue.push({ type: "usage", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { tier: nodeSpec.binding?.tier ?? "__default__", value } });
            },
          });
          const analysis = result.analysis ?? latestAnalysis;
          eventQueue.push({ type: "intent", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { name: analyzer.name, value: result.value as C["intent"], ...(analysis === undefined ? {} : { analysis }) } });
          return result;
        },
        log: (event) => {
          if (graph.definition.log !== false) {
            // host can plug a logger; default is no-op
            void event;
          }
        },
        actor: opts.actor,
      };

      let settledEvent: QueueResult<StepEvent<TState, C>> | undefined;
      const readNextEvent = () => eventQueue.next().then((result) => {
        settledEvent = result;
        return { kind: "event" as const, result };
      });
      let nextEvent = readNextEvent();
      const nodeExecution = (async (): Promise<NodeExecutionOutcome<TState, C>> => {
        try {
          const fanoutField = nodeSpec.fanOut;
          const runtimeState = state as object as Record<string, RuntimeField>;
          const collection = fanoutField ? runtimeState[fanoutField] : undefined;
          const retry = graph.definition.retries?.find((spec) => spec.node === node)
            ?? graph.definition.retries?.find((spec) => spec.node === undefined);
          const attempts = retry?.attempts ?? 1;
          let update: Partial<TState> | undefined;
          let lastError: unknown;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              if (!fanoutField || !Array.isArray(collection) || collection.length === 0) {
                const result = nodeSpec.fn(state, ctx);
                update = result instanceof Promise
                  ? await Promise.race(timeoutPromise ? [result, timeoutPromise] : [result])
                  : result;
              } else {
                let fanoutState = state;
                for (const item of collection) {
                  const itemState = { ...(state as object), [fanoutField]: [item] } as TState;
                  const itemResult = nodeSpec.fn(itemState, ctx);
                  const itemUpdate = itemResult instanceof Promise
                    ? await Promise.race(timeoutPromise ? [itemResult, timeoutPromise] : [itemResult])
                    : itemResult;
                  fanoutState = mergeState(graph, fanoutState, itemUpdate);
                }
                update = diffState(state, fanoutState);
              }
              break;
            } catch (error) {
              if (error instanceof InterruptSignal) throw error;
              lastError = error;
              if (attempt >= attempts) break;
              eventQueue.push({
                type: "info",
                graph: graph.name,
                threadId,
                runId,
                node,
                step: nodeStep,
                ts: Date.now(),
                data: { retry: attempt, attempts },
              });
              const delay = retry?.backoff === "exponential" ? 10 * 2 ** (attempt - 1) : 10;
              await new Promise<void>((resolve) => setTimeout(resolve, delay));
            }
          }
          if (update === undefined) {
            throw lastError ?? new GraphRuntimeError(`Node "${node}" did not produce a state update.`);
          }
          return { kind: "done", update };
        } catch (err) {
          if (err instanceof InterruptSignal) {
            return { kind: "interrupt", request: err.request as unknown as InterruptRequest<C["interrupt"]> };
          }
          const error = err instanceof Error ? err : new Error(String(err));
          const fallback = graph.definition.fallbacks?.find((candidate) => candidate.target !== node && candidate.policy !== "rethrow");
          if (fallback) {
            eventQueue.push({ type: "info", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { fallback: fallback.target } });
            return { kind: "route", target: fallback.target, error };
          }
          const errorRoute = graph.errorRoutes.find((candidate) => candidate.node === node);
          if (errorRoute) {
            const decision = errorRoute.route(state);
            const target = Array.isArray(decision) ? decision[0] : decision;
            if (target && errorRoute.targets.includes(target)) {
              eventQueue.push({ type: "info", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { errorRoute: target } });
              return { kind: "route", target, error };
            }
          }
          eventQueue.push({ type: "error", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { error } });
          return { kind: "error", error };
        }
      })();

      let outcome: NodeExecutionOutcome<TState, C> | undefined;
      const nodeResult = nodeExecution.then((result) => ({ kind: "outcome" as const, result }));
      while (outcome === undefined) {
        const winner = await Promise.race([nodeResult, nextEvent]);
        if (winner.kind === "outcome") {
          // A node may resolve immediately after its final callback event is
          // pushed. Give that already-resolved queue waiter one microtask to
          // settle before closing the queue, otherwise the final event can be
          // consumed by Promise.race but never yielded to the stream caller.
          await Promise.resolve();
          if (settledEvent?.kind === "value") {
            yield settledEvent.value;
            settledEvent = undefined;
          }
          outcome = winner.result;
          break;
        }
        if (winner.result.kind === "value") {
          yield winner.result.value;
          settledEvent = undefined;
          nextEvent = readNextEvent();
        }
      }

      eventQueue.close();
      for (const event of eventQueue.drain()) yield event;

      if (outcome === undefined) throw new GraphRuntimeError(`Node "${node}" completed without an outcome.`);
      if (outcome.kind === "interrupt") {
        yield { type: "interrupt", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { request: outcome.request, state, reason: "node" } };
        await persist(graph, cp, threadId, state, node, round, { node, mode: "before", request: outcome.request });
        return;
      }
      if (outcome.kind === "route") {
        yield { type: "edge", graph: graph.name, threadId, runId, node, step: { id: `${node}:${outcome.target}`, label: `Error to ${outcome.target}`, kind: "edge" }, ts: Date.now(), data: { from: node, to: outcome.target } };
        node = outcome.target;
        continue;
      }
      if (outcome.kind === "error") throw outcome.error;
      const update = outcome.update;

      const before = JSON.stringify(state);
      state = mergeState(graph, state, update);
      const latency = Date.now() - t0;
      yield {
        type: "node_end",
        graph: graph.name,
        threadId,
        runId,
        node,
        step: nodeStep,
        ts: Date.now(),
        data: { state: JSON.stringify(state) !== before ? state : undefined, latencyMs: latency },
      };

      await persist(graph, cp, threadId, state, node, round);
      completedNodes.add(node);

      // A post-node pause is persisted after the node has completed. On the
      // following run, checkpointNode() exposes mode="after" so this node is
      // not paused a second time for the same checkpoint.
      if (graph.interruptAfter.has(node) && cpNode?.mode !== "after") {
        const request = graph.definition.interruptRequests?.[node];
        yield { type: "interrupt", graph: graph.name, threadId, runId, node, step: nodeStep, ts: Date.now(), data: { request, state, reason: "after" } };
        await persist(graph, cp, threadId, state, node, round, { node, mode: "after", request });
        return;
      }

      const targets = resolveTargets(graph, node, state);
      // Rule L1 dry-loop: if the only next target was already visited and state did not change, stop
      if (
        targets.length === 1 &&
        targets[0] !== "END" &&
        seen.has(targets[0]) &&
        JSON.stringify(state) === before
      ) {
        return; // converged (dry)
      }
      if (targets.length === 0 || (targets.length === 1 && targets[0] === "END")) {
        yield { type: "edge", graph: graph.name, threadId, runId, node, step: { id: `${node}:END`, label: "Complete", kind: "edge" }, ts: Date.now(), data: { from: node, to: "END" } };
        node = "END";
      } else if (targets.length === 1) {
        const target = targets[0];
        const edge = graph.definition.edges.find((candidate) => candidate.from === node && (("to" in candidate && candidate.to === target) || ("targets" in candidate && candidate.targets.includes(target))));
        yield { type: "edge", graph: graph.name, threadId, runId, node, step: { id: `${node}:${target}`, label: edge?.label ?? `${node} to ${target}`, kind: "edge" }, ts: Date.now(), data: { from: node, to: target } };
        node = target;
      } else {
        const orderedTargets = [...targets.filter((target) => target !== "END"), ...(targets.includes("END") ? ["END"] : [])];
        node = orderedTargets.shift() ?? "END";
        pendingNodes.push(...orderedTargets.filter((target) => !pendingNodes.includes(target)));
      }
    }

    yield { type: "node_end", graph: graph.name, threadId, runId, node: "END", step: { id: "END", label: "Complete", kind: "graph" }, ts: Date.now(), data: { state } };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
