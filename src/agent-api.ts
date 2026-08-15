/**
 * Generic agent, supervisor, bus, memory and context facades.
 *
 * These contracts deliberately operate on objects and typed callbacks. They
 * do not assume SQL, MCP, chat, rows, approval terminology or a host
 * framework.
 */
import type { ChatMessage, CompiledGraph, JsonObject, JsonValue, ModelToolCall, ModelToolSpec, RunOptions, StepEvent, TokenUsage } from "./types.js";
import type { Model } from "./model-api.js";

/** Options accepted by an agent execution. */
export interface AgentRunOptions extends RunOptions {
  /** Execution id supplied automatically by a graph node runtime when available. */
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

/** Result returned from an agent run. */
export interface AgentResult<TOutput extends object> {
  readonly output: TOutput;
  readonly state?: object;
}

/** Typed lifecycle event emitted by an agent stream. */
export type AgentEvent<TOutput extends object = JsonObject> =
  | { readonly type: "step"; readonly event: StepEvent<object> }
  | { readonly type: "token" | "reasoning"; readonly value: string }
  | { readonly type: "tool_start"; readonly call: ModelToolCall }
  | { readonly type: "tool_end"; readonly call: ModelToolCall; readonly result: JsonValue }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "output"; readonly output: TOutput }
  | { readonly type: "error"; readonly error: Error };

/** Generic agent contract usable for workflows beyond chat. */
export interface Agent<TInput extends object = JsonObject, TOutput extends object = JsonObject> {
  readonly name: string;
  run(input: TInput, options?: AgentRunOptions): Promise<AgentResult<TOutput>>;
  stream(input: TInput, options?: AgentRunOptions): AsyncIterable<AgentEvent<TOutput>>;
}

/** A model-callable tool supplied directly or by a lazily discovered source such as MCP. */
export interface AgentTool {
  readonly spec: ModelToolSpec;
  execute(args: JsonObject): JsonValue | Promise<JsonValue>;
}

/** Structural tool source accepted by `createAgent` without coupling Core to an integration package. */
export interface AgentToolSource {
  bindTools?(options?: AgentRunOptions): Promise<readonly AgentTool[]>;
}

/** Default text output returned by a model-backed agent. */
export interface AgentTextOutput {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
}

/** Agent construction options. */
export interface AgentOptions<TInput extends object, TOutput extends object> {
  readonly name?: string;
  readonly graph?: CompiledGraph<TInput, TInput, TOutput>;
  readonly run?: (input: TInput, options?: AgentRunOptions) => Promise<AgentResult<TOutput>>;
  readonly stream?: (input: TInput, options?: AgentRunOptions) => AsyncIterable<AgentEvent<TOutput>>;
  /** Model-backed agents need no application-side run wrapper. */
  readonly model?: Model;
  /** Direct tools or lazy sources such as the object returned by `createMCP`. */
  readonly tools?: readonly (AgentTool | AgentToolSource)[];
  /** Optional policy applied before a JSON-safe input becomes a model request. */
  readonly instructions?: string;
  /** Limit model/tool rounds for the built-in generic execution loop. */
  readonly maxRounds?: number;
}

/** Create a generic agent from a compiled graph or injected implementation. */
export function createAgent<TInput extends object, TOutput extends object>(options: AgentOptions<TInput, TOutput>): Agent<TInput, TOutput> {
  const name = options.name ?? options.graph?.name ?? "agent";
  return {
    name,
    run: async (input, runOptions) => {
      if (options.run) return options.run(input, runOptions);
      if (options.model) return runModelAgent<TInput, TOutput>(name, options, input, runOptions);
      if (!options.graph) throw new Error(`Agent "${name}" has no graph or run implementation.`);
      const result = await options.graph.run(input, runOptions);
      return { output: result.output ?? copyOutput<TOutput>(result.state), state: result.state };
    },
    stream: (input, runOptions) => {
      if (options.stream) return options.stream(input, runOptions);
      if (options.model) return streamModelAgent<TInput, TOutput>(name, options, input, runOptions);
      if (!options.graph) return errorStream<TOutput>(new Error(`Agent "${name}" has no graph or stream implementation.`));
      return graphStream(options.graph, input, runOptions);
    },
  };
}

/** Supervisor assignment unit. */
export interface SupervisorTask {
  readonly id: string;
  readonly agent: string;
  readonly input: JsonObject;
}

/** Supervisor result containing typed task assignments. */
export interface SupervisorPlan {
  readonly tasks: readonly SupervisorTask[];
  readonly reason?: string;
}

/** Supervisor contract for multi-agent orchestration. */
export interface Supervisor {
  plan(input: JsonObject): Promise<SupervisorPlan>;
  assign(input: JsonObject, agents: readonly Agent<JsonObject, JsonObject>[]): Promise<SupervisorPlan>;
  run(input: JsonObject, agents: readonly Agent<JsonObject, JsonObject>[]): Promise<JsonObject>;
}

/** Supervisor construction options. */
export interface SupervisorOptions {
  readonly name?: string;
  readonly plan?: (input: JsonObject) => Promise<SupervisorPlan> | SupervisorPlan;
}

/** Create a generic supervisor with explicit task planning. */
export function createSupervisor(options: SupervisorOptions = {}): Supervisor {
  const plan = options.plan ?? ((input: JsonObject): SupervisorPlan => ({ tasks: [], reason: `No assignments for ${Object.keys(input).length} input fields.` }));
  return {
    plan: async (input) => plan(input),
    assign: async (input, agents) => {
      const planned = await plan(input);
      const names = new Set(agents.map((agent) => agent.name));
      return { ...planned, tasks: planned.tasks.filter((task) => names.has(task.agent)) };
    },
    run: async (input, agents) => {
      const planned = await plan(input);
      const results: Record<string, JsonValue> = {};
      for (const task of planned.tasks) {
        const agent = agents.find((candidate) => candidate.name === task.agent);
        if (!agent) continue;
        const result = await agent.run(task.input);
        results[task.id] = result.output as JsonValue;
      }
      return results;
    },
  };
}

/** Message passed through an agent bus. */
export interface AgentMessage {
  readonly topic: string;
  readonly payload: JsonObject;
  readonly source?: string;
  readonly correlationId?: string;
}

/** Agent bus subscription callback. */
export type AgentSubscriber = (message: AgentMessage) => void | Promise<void>;

/** Agent bus contract for typed inter-agent messages. */
export interface AgentBus {
  publish(message: AgentMessage): Promise<void>;
  subscribe(topic: string, subscriber: AgentSubscriber): () => void;
}

/** Agent bus construction options. */
export interface AgentBusOptions {
  readonly onError?: (error: Error, message: AgentMessage) => void;
}

/** Create an in-process agent bus with explicit topic subscriptions. */
export function createAgentBus(options: AgentBusOptions = {}): AgentBus {
  const subscribers = new Map<string, Set<AgentSubscriber>>();
  return {
    async publish(message) {
      const topicSubscribers = subscribers.get(message.topic);
      if (!topicSubscribers) return;
      await Promise.all([...topicSubscribers].map(async (subscriber) => {
        try {
          await subscriber(message);
        } catch (error) {
          options.onError?.(new Error("Agent bus subscriber failed."), message);
        }
      }));
    },
    subscribe(topic, subscriber) {
      const topicSubscribers = subscribers.get(topic) ?? new Set<AgentSubscriber>();
      topicSubscribers.add(subscriber);
      subscribers.set(topic, topicSubscribers);
      return () => {
        topicSubscribers.delete(subscriber);
        if (topicSubscribers.size === 0) subscribers.delete(topic);
      };
    },
  };
}

/** Memory record stored by the framework-neutral memory facade. */
export interface MemoryRecord {
  readonly key: string;
  readonly value: JsonValue;
  readonly createdAt: number;
}

/** Memory facade options. */
export interface MemoryOptions {
  readonly namespace?: string;
  readonly initial?: readonly MemoryRecord[];
}

/** Memory contract shared by agents, context managers and adapters. */
export interface Memory {
  remember(key: string, value: JsonValue): Promise<void>;
  recall(key: string): Promise<MemoryRecord | null>;
  list(): Promise<readonly MemoryRecord[]>;
  clear(): Promise<void>;
}

/** Create an in-process memory implementation suitable for local execution and tests. */
export function createMemory(options: MemoryOptions = {}): Memory {
  const values = new Map<string, MemoryRecord>((options.initial ?? []).map((record) => [record.key, record]));
  return {
    async remember(key, value) {
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async recall(key) {
      return values.get(key) ?? null;
    },
    async list() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

/** Context manager options. */
export interface ContextOptions {
  readonly initial?: JsonObject;
}

/** Typed runtime context manager contract. */
export interface ContextManager {
  get<TValue extends JsonValue>(key: string): TValue | undefined;
  set(key: string, value: JsonValue): void;
  merge(values: JsonObject): void;
  snapshot(): JsonObject;
}

/** Create an isolated context manager for one workflow or agent scope. */
export function createContextManager(options: ContextOptions = {}): ContextManager {
  const values: Record<string, JsonValue> = { ...(options.initial ?? {}) };
  return {
    get: <TValue extends JsonValue>(key: string) => values[key] as TValue | undefined,
    set: (key, value) => { values[key] = value; },
    merge: (input) => { Object.assign(values, input); },
    snapshot: () => ({ ...values }),
  };
}

async function* graphStream<TInput extends object, TOutput extends object>(
  graph: CompiledGraph<TInput, TInput, TOutput>,
  input: TInput,
  options?: AgentRunOptions,
): AsyncIterable<AgentEvent<TOutput>> {
  for await (const event of graph.stream(input, options)) {
    yield { type: "step", event: event as StepEvent<object> };
  }
  const result = await graph.run(input, options);
  yield { type: "output", output: result.output ?? copyOutput<TOutput>(result.state) };
}

async function* errorStream<TOutput extends object>(error: Error): AsyncIterable<AgentEvent<TOutput>> {
  yield { type: "error", error };
}

function copyOutput<TOutput extends object>(value: object): TOutput {
  return Object.assign({} as TOutput, value);
}

async function runModelAgent<TInput extends object, TOutput extends object>(
  name: string,
  options: AgentOptions<TInput, TOutput>,
  input: TInput,
  runOptions?: AgentRunOptions,
): Promise<AgentResult<TOutput>> {
  const model = options.model;
  if (!model) throw new Error(`Agent "${name}" has no model.`);
  const tools = await resolveAgentTools(options.tools, runOptions);
  const messages = toAgentMessages(input, options.instructions);
  const calls: ModelToolCall[] = [];
  const maxRounds = options.maxRounds ?? 8;

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await model.generate({ messages, tools: tools.map((tool) => tool.spec), signal: runOptions?.signal });
    messages.push({ role: "assistant", content: response.content, ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}) });
    if (!response.toolCalls || response.toolCalls.length === 0) return { output: toAgentOutput<TOutput>(response.content, calls) };
    for (const call of response.toolCalls) {
      const tool = tools.find((candidate) => candidate.spec.name === call.name);
      if (!tool) throw new Error(`Agent "${name}" requested unavailable tool "${call.name}".`);
      calls.push(call);
      messages.push({ role: "tool", content: JSON.stringify(await executeAgentTool(tool, call)), toolCallId: call.id });
    }
  }
  throw new Error(`Agent "${name}" exceeded ${maxRounds} tool rounds.`);
}

async function* streamModelAgent<TInput extends object, TOutput extends object>(name: string, options: AgentOptions<TInput, TOutput>, input: TInput, runOptions?: AgentRunOptions): AsyncIterable<AgentEvent<TOutput>> {
  try {
    const model = options.model;
    if (!model) throw new Error(`Agent "${name}" has no model.`);
    const tools = await resolveAgentTools(options.tools, runOptions);
    const messages = toAgentMessages(input, options.instructions);
    const calls: ModelToolCall[] = [];
    const maxRounds = options.maxRounds ?? 8;

    for (let round = 0; round < maxRounds; round += 1) {
      const collected = new Map<number, { id?: string; name?: string; arguments: string }>();
      let content = "";
      for await (const chunk of model.stream({ messages, tools: tools.map((tool) => tool.spec), signal: runOptions?.signal })) {
        if (chunk.type === "token") { content += chunk.value; yield { type: "token", value: chunk.value }; }
        if (chunk.type === "reasoning") yield { type: "reasoning", value: chunk.value };
        if (chunk.type === "usage") yield { type: "usage", usage: chunk.value };
        if (chunk.type === "tool_call") {
          const current = collected.get(chunk.value.index) ?? { arguments: "" };
          collected.set(chunk.value.index, { id: chunk.value.id ?? current.id, name: chunk.value.name ?? current.name, arguments: `${current.arguments}${chunk.value.arguments}` });
        }
      }
      const roundCalls = [...collected.values()].map((call, index): ModelToolCall => ({
        id: call.id ?? `${name}-${round}-${index}`,
        name: call.name ?? (() => { throw new Error(`Agent "${name}" received an unnamed tool call.`); })(),
        arguments: parseToolArguments(call.arguments, name),
      }));
      messages.push({ role: "assistant", content, ...(roundCalls.length ? { toolCalls: roundCalls } : {}) });
      if (roundCalls.length === 0) { yield { type: "output", output: toAgentOutput<TOutput>(content, calls) }; return; }
      for (const call of roundCalls) {
        const tool = tools.find((candidate) => candidate.spec.name === call.name);
        if (!tool) throw new Error(`Agent "${name}" requested unavailable tool "${call.name}".`);
        yield { type: "tool_start", call };
        const result = await executeAgentTool(tool, call);
        yield { type: "tool_end", call, result };
        calls.push(call);
        messages.push({ role: "tool", content: JSON.stringify(result), toolCallId: call.id });
      }
    }
    throw new Error(`Agent "${name}" exceeded ${maxRounds} tool rounds.`);
  } catch (error) {
    yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function resolveAgentTools(sources: readonly (AgentTool | AgentToolSource)[] | undefined, options?: AgentRunOptions): Promise<readonly AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const source of sources ?? []) {
    if ("spec" in source) tools.push(source);
    else if (source.bindTools) tools.push(...await source.bindTools(options));
  }
  return tools;
}

/** Preserve the agent loop when a provider-backed tool rejects one malformed or transient call. */
async function executeAgentTool(tool: AgentTool, call: ModelToolCall): Promise<JsonValue> {
  try {
    return await tool.execute(call.arguments);
  } catch (error) {
    return {
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function toAgentMessages(input: object, instructions?: string): ChatMessage[] {
  const record = input as Record<string, JsonValue>;
  const query = typeof record.query === "string" ? record.query : JSON.stringify(input);
  return [...(instructions ? [{ role: "system" as const, content: instructions }] : []), { role: "user" as const, content: query }];
}

function toAgentOutput<TOutput extends object>(content: string, toolCalls: readonly ModelToolCall[]): TOutput {
  return { content, toolCalls } as TOutput;
}

function parseToolArguments(source: string, name: string): JsonObject {
  try {
    const parsed: JsonValue = JSON.parse(source || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Tool arguments must be an object.");
    return parsed as JsonObject;
  } catch (error) {
    throw new Error(`Agent "${name}" received invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
}
