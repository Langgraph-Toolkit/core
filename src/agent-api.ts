/**
 * Generic agent, supervisor, bus, memory and context facades.
 *
 * These contracts deliberately operate on objects and typed callbacks. They
 * do not assume SQL, MCP, chat, rows, approval terminology or a host
 * framework.
 */
import type { CompiledGraph, JsonObject, JsonValue, RunOptions, StepEvent } from "./types.js";

/** Options accepted by an agent execution. */
export interface AgentRunOptions extends RunOptions {
  readonly signal?: AbortSignal;
}

/** Result returned from an agent run. */
export interface AgentResult<TOutput extends object> {
  readonly output: TOutput;
  readonly state?: object;
}

/** Typed event emitted by an agent stream. */
export interface AgentEvent<TOutput extends object = JsonObject> {
  readonly type: "step" | "output" | "error";
  readonly event?: StepEvent<object>;
  readonly output?: TOutput;
  readonly error?: Error;
}

/** Generic agent contract usable for workflows beyond chat. */
export interface Agent<TInput extends object = JsonObject, TOutput extends object = JsonObject> {
  readonly name: string;
  run(input: TInput, options?: AgentRunOptions): Promise<AgentResult<TOutput>>;
  stream(input: TInput, options?: AgentRunOptions): AsyncIterable<AgentEvent<TOutput>>;
}

/** Agent construction options. */
export interface AgentOptions<TInput extends object, TOutput extends object> {
  readonly name?: string;
  readonly graph?: CompiledGraph<TInput, TInput, TOutput>;
  readonly run?: (input: TInput, options?: AgentRunOptions) => Promise<AgentResult<TOutput>>;
  readonly stream?: (input: TInput, options?: AgentRunOptions) => AsyncIterable<AgentEvent<TOutput>>;
}

/** Create a generic agent from a compiled graph or injected implementation. */
export function createAgent<TInput extends object, TOutput extends object>(options: AgentOptions<TInput, TOutput>): Agent<TInput, TOutput> {
  const name = options.name ?? options.graph?.name ?? "agent";
  return {
    name,
    run: async (input, runOptions) => {
      if (options.run) return options.run(input, runOptions);
      if (!options.graph) throw new Error(`Agent "${name}" has no graph or run implementation.`);
      const result = await options.graph.run(input, runOptions);
      return { output: result.output ?? copyOutput<TOutput>(result.state), state: result.state };
    },
    stream: (input, runOptions) => {
      if (options.stream) return options.stream(input, runOptions);
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
