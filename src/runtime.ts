import type {
  Actor,
  DefaultGraphContracts,
  GraphContracts,
  JsonObject,
  ModelRegistry,
  RunOptions,
  RunResult,
  StepEvent,
} from "./types.js";
import { GraphRegistry } from "./registry.js";

/** Default resources inherited by every run from an application runtime. */
export interface ToolkitRuntimeOptions {
  /** Model registry used when a call does not provide one explicitly. */
  readonly modelRegistry?: ModelRegistry;
  /** Actor inherited by host routes unless a request overrides it. */
  readonly actor?: Actor;
}

/** Configure a runtime with graph definitions or compiled graph resources. */
export type ToolkitRuntimeConfigurator = (runtime: ToolkitRuntime) => void;

/**
 * A small application-level registry facade. It keeps the framework-agnostic
 * GraphRegistry as the execution primitive while adding shared host defaults.
 */
export class ToolkitRuntime extends GraphRegistry {
  readonly modelRegistry?: ToolkitRuntimeOptions["modelRegistry"];
  readonly actor?: Actor;

  constructor(options: ToolkitRuntimeOptions = {}) {
    super();
    this.modelRegistry = options.modelRegistry;
    this.actor = options.actor;
  }

  override async run<
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
    return super.run(name, input, {
      ...opts,
      modelRegistry: opts?.modelRegistry ?? this.modelRegistry,
      actor: opts?.actor ?? this.actor,
    });
  }

  override stream<
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
    return super.stream(name, input, {
      ...opts,
      modelRegistry: opts?.modelRegistry ?? this.modelRegistry,
      actor: opts?.actor ?? this.actor,
    });
  }
}

/** Create a reusable graph runtime for any backend host. */
export function createToolkitRuntime(configure?: ToolkitRuntimeConfigurator): ToolkitRuntime;
export function createToolkitRuntime(options?: ToolkitRuntimeOptions, configure?: ToolkitRuntimeConfigurator): ToolkitRuntime;
export function createToolkitRuntime(
  optionsOrConfigure: ToolkitRuntimeOptions | ToolkitRuntimeConfigurator = {},
  configure?: ToolkitRuntimeConfigurator,
): ToolkitRuntime {
  const options = typeof optionsOrConfigure === "function" ? {} : optionsOrConfigure;
  const callback = typeof optionsOrConfigure === "function" ? optionsOrConfigure : configure;
  const runtime = new ToolkitRuntime(options);
  callback?.(runtime);
  return runtime;
}
