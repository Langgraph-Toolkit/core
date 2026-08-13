import type {
  CompiledGraph,
  DefaultGraphContracts,
  GraphContracts,
  GraphDefinition,
  JsonObject,
  RunOptions,
  RunResult,
  StepEvent,
} from "./types.js";
import { GraphRuntimeError } from "./types.js";
import { compile } from "./compile.js";
import { attachExecutor } from "./executor.js";

/** A named graph registry that preserves types at registration and execution boundaries. */
export class GraphRegistry {
  private graphs = new Map<string, CompiledGraph<object>>();

  /** Compile, attach the runtime, and register a graph resource. */
  register<
    TState extends object,
    TInput extends object = Partial<TState>,
    TOutput extends object = TState,
    C extends GraphContracts = DefaultGraphContracts,
    TVariables extends JsonObject = JsonObject,
    TGlobal extends JsonObject = JsonObject,
  >(
    definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>,
  ): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal> {
    const compiled = attachExecutor(compile(definition as never) as never) as CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>;
    if (this.graphs.has(compiled.name)) throw new GraphRuntimeError(`Graph "${compiled.name}" is already registered.`);
    this.graphs.set(compiled.name, compiled as never);
    return compiled;
  }

  /** Register a graph that was compiled by another package. */
  add<
    TState extends object,
    TInput extends object = Partial<TState>,
    TOutput extends object = TState,
    C extends GraphContracts = DefaultGraphContracts,
    TVariables extends JsonObject = JsonObject,
    TGlobal extends JsonObject = JsonObject,
  >(
    compiled: CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>,
  ): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal> {
    if (this.graphs.has(compiled.name)) throw new GraphRuntimeError(`Graph "${compiled.name}" is already registered.`);
    this.graphs.set(compiled.name, compiled as never);
    return compiled;
  }

  /** Retrieve a graph with an application-provided contract. */
  get<
    TState extends object,
    TInput extends object = Partial<TState>,
    TOutput extends object = TState,
    C extends GraphContracts = DefaultGraphContracts,
    TVariables extends JsonObject = JsonObject,
    TGlobal extends JsonObject = JsonObject,
  >(
    name: string,
  ): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal> | undefined {
    return this.graphs.get(name) as never;
  }

  /** Return true when a graph name is registered. */
  has(name: string): boolean { return this.graphs.has(name); }

  /** List registered graph names. */
  list(): string[] { return Array.from(this.graphs.keys()); }

  /** Register definitions in order. */
  registerAll(definitions: readonly GraphDefinition<object>[]): void {
    for (const definition of definitions) this.register(definition);
  }

  /** Execute a named resource with explicit application contracts. */
  async run<
    TState extends object,
    TInput extends object,
    TOutput extends object = TState,
    C extends GraphContracts = DefaultGraphContracts,
    TVariables extends JsonObject = JsonObject,
    TGlobal extends JsonObject = JsonObject,
  >(
    name: string,
    input: TInput,
    opts?: RunOptions<C, TVariables, TGlobal>,
  ): Promise<RunResult<TState, TOutput, C["interrupt"], TVariables>> {
    const graph = this.get<TState, TInput, TOutput, C, TVariables, TGlobal>(name);
    if (!graph) throw new GraphRuntimeError(`Graph "${name}" is not registered.`);
    return graph.run(input, opts);
  }

  /** Stream a named resource with explicit application contracts. */
  stream<
    TState extends object,
    TInput extends object,
    TOutput extends object = TState,
    C extends GraphContracts = DefaultGraphContracts,
    TVariables extends JsonObject = JsonObject,
    TGlobal extends JsonObject = JsonObject,
  >(
    name: string,
    input: TInput,
    opts?: RunOptions<C, TVariables, TGlobal>,
  ): AsyncIterable<StepEvent<TState, C>> {
    const graph = this.get<TState, TInput, TOutput, C, TVariables, TGlobal>(name);
    if (!graph) throw new GraphRuntimeError(`Graph "${name}" is not registered.`);
    return graph.stream(input, opts);
  }
}
