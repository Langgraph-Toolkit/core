/** Shared host lifecycle facade backed by compiled graphs and their configured checkpointers. */
import { randomUUID } from "node:crypto";
import type {
  Checkpoint,
  Checkpointer,
  CompiledGraph,
  JsonObject,
  JsonValue,
  RunResult,
  StepEvent,
} from "./types.js";
import { GraphRuntimeError } from "./types.js";
import { GraphRegistry } from "./registry.js";

/** Request payload accepted by lifecycle invoke and stream operations. */
export interface GraphInvokeRequest {
  readonly input: JsonObject;
  readonly threadId?: string;
}

/** Request payload for a paused workflow continuation. */
export interface GraphResumeRequest {
  readonly threadId: string;
  readonly response: JsonValue;
}

/** Request payload for deterministic execution from one retained checkpoint. */
export interface GraphReplayRequest extends GraphInvokeRequest {
  readonly threadId: string;
  readonly checkpointId: string;
}

/** Request payload for copying one retained checkpoint to a new thread. */
export interface GraphForkRequest {
  readonly threadId: string;
  readonly checkpointId: string;
  readonly targetThreadId: string;
}

/** Host-facing runtime lifecycle for a named graph resource. */
export interface GraphLifecycle {
  invoke(name: string, request: GraphInvokeRequest): Promise<RunResult<JsonObject>>;
  stream(name: string, request: GraphInvokeRequest): AsyncIterable<StepEvent<JsonObject>>;
  resume(name: string, request: GraphResumeRequest): Promise<RunResult<JsonObject>>;
  cancel(name: string, threadId: string): boolean;
  state(name: string, threadId: string): Promise<Checkpoint<JsonObject> | null>;
  history(name: string, threadId: string): Promise<readonly Checkpoint<JsonObject>[]>;
  replay(name: string, request: GraphReplayRequest): Promise<RunResult<JsonObject>>;
  fork(name: string, request: GraphForkRequest): Promise<Checkpoint<JsonObject>>;
}

/** Create a framework-neutral HTTP lifecycle facade for a registry or one compiled graph resource. */
export function createGraphLifecycle(graphs: GraphRegistry): GraphLifecycle;
export function createGraphLifecycle<TState extends object, TInput extends object, TOutput extends object>(graph: CompiledGraph<TState, TInput, TOutput>): GraphLifecycle;
export function createGraphLifecycle(source: GraphRegistry | object): GraphLifecycle {
  const active = new Map<string, AbortController>();
  const graph = source instanceof GraphRegistry
    ? undefined
    : source as CompiledGraph<JsonObject, JsonObject>;

  const resolve = (name: string): CompiledGraph<JsonObject, JsonObject> => {
    if (graph !== undefined) {
      if (name !== graph.name) throw new GraphRuntimeError(`Graph "${name}" is not registered.`);
      return graph;
    }
    if (!(source instanceof GraphRegistry)) throw new GraphRuntimeError(`Graph "${name}" is not registered.`);
    const registered = source.get<JsonObject, JsonObject>(name);
    if (registered === undefined) throw new GraphRuntimeError(`Graph "${name}" is not registered.`);
    return registered;
  };
  const key = (name: string, threadId: string): string => `${name}:${threadId}`;
  const runWithSignal = async (
    name: string,
    request: GraphInvokeRequest,
    checkpoint?: Checkpointer<JsonObject>,
  ): Promise<RunResult<JsonObject>> => {
    const graph = resolve(name);
    const threadId = request.threadId ?? randomUUID();
    const controller = new AbortController();
    const runKey = key(name, threadId);
    active.set(runKey, controller);
    try {
      return await graph.invoke(request.input, {
        threadId,
        signal: controller.signal,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      });
    } finally {
      active.delete(runKey);
    }
  };
  const checkpointFor = (name: string): Checkpointer<JsonObject> => {
    const checkpoint = resolve(name).definition.runtime?.checkpoint as Checkpointer<JsonObject> | undefined;
    if (checkpoint === undefined) {
      throw new GraphRuntimeError(`Graph "${name}" has no configured checkpointer. Add .checkpoint() before exposing state lifecycle routes.`);
    }
    return checkpoint;
  };
  const checkpointById = async (name: string, threadId: string, checkpointId: string): Promise<Checkpoint<JsonObject>> => {
    const checkpoint = (await checkpointFor(name).list(threadId)).find((entry) => entry.checkpointId === checkpointId);
    if (checkpoint === undefined) {
      throw new GraphRuntimeError(`Checkpoint "${checkpointId}" was not found for thread "${threadId}".`);
    }
    return checkpoint;
  };

  return {
    invoke: runWithSignal,
    async *stream(name, request) {
      const graph = resolve(name);
      const threadId = request.threadId ?? randomUUID();
      const controller = new AbortController();
      const runKey = key(name, threadId);
      active.set(runKey, controller);
      try {
        for await (const event of graph.stream(request.input, { threadId, signal: controller.signal })) {
          yield event;
        }
      } finally {
        active.delete(runKey);
      }
    },
    async resume(name, request) {
      const graph = resolve(name);
      const controller = new AbortController();
      const runKey = key(name, request.threadId);
      active.set(runKey, controller);
      try {
        return await graph.resume(request.threadId, request.response, {
          signal: controller.signal,
          checkpoint: checkpointFor(name),
        });
      } finally {
        active.delete(runKey);
      }
    },
    cancel(name, threadId) {
      const controller = active.get(key(name, threadId));
      if (controller === undefined) return false;
      controller.abort();
      return true;
    },
    state: async (name, threadId) => checkpointFor(name).get(threadId),
    history: async (name, threadId) => checkpointFor(name).list(threadId),
    async replay(name, request) {
      const source = await checkpointById(name, request.threadId, request.checkpointId);
      const base = checkpointFor(name);
      const replayCheckpoint = new ReplayCheckpointer(base, request.threadId, source);
      return runWithSignal(name, { input: request.input, threadId: request.threadId }, replayCheckpoint);
    },
    async fork(name, request) {
      const source = await checkpointById(name, request.threadId, request.checkpointId);
      const fork: Checkpoint<JsonObject> = {
        ...source,
        threadId: request.targetThreadId,
        checkpointId: randomUUID(),
        createdAt: Date.now(),
      };
      await checkpointFor(name).put(fork);
      return fork;
    },
  };
}

/** Checkpointer wrapper that restores one selected snapshot then persists new execution history to the base adapter. */
class ReplayCheckpointer implements Checkpointer<JsonObject> {
  constructor(
    private readonly base: Checkpointer<JsonObject>,
    private readonly threadId: string,
    private readonly snapshot: Checkpoint<JsonObject>,
  ) {}

  async get(threadId: string): Promise<Checkpoint<JsonObject> | null> {
    if (threadId === this.threadId) return this.snapshot;
    return this.base.get(threadId);
  }

  async put(checkpoint: Checkpoint<JsonObject>): Promise<void> {
    await this.base.put(checkpoint);
  }

  async list(threadId: string): Promise<Checkpoint<JsonObject>[]> {
    if (threadId !== this.threadId) return this.base.list(threadId);
    const history = await this.base.list(threadId);
    return history.some((entry) => entry.checkpointId === this.snapshot.checkpointId)
      ? history
      : [...history, this.snapshot];
  }
}
