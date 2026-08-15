/** Typed tool registry and orchestration facade for Core workflows. */
import type { ToolContext, ToolDefinition, JsonObject, JsonValue } from "./types.js";

/** One planned tool invocation. */
export interface ToolPlanStep {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly dependsOn?: readonly string[];
}

/** Approval callback used before side-effectful tools. */
export type ToolApproval = (tool: string, args: JsonObject, context: ToolContext) => boolean | Promise<boolean>;

/** Core tool registry and orchestration contract. */
export interface ToolRegistry {
  register<TArgs extends object, TResult extends JsonValue>(tool: ToolDefinition<TArgs, TResult>): void;
  has(name: string): boolean;
  list(): readonly string[];
  execute<TResult extends JsonValue = JsonValue>(name: string, args: JsonObject, context: ToolContext): Promise<TResult>;
  executePlan(steps: readonly ToolPlanStep[], context: ToolContext): Promise<JsonObject>;
  parallel(steps: readonly ToolPlanStep[], context: ToolContext): Promise<readonly JsonValue[]>;
  requireApproval<TArgs extends object, TResult extends JsonValue>(tool: ToolDefinition<TArgs, TResult>, args: TArgs, approval: ToolApproval, context: ToolContext): Promise<TResult>;
}

/** Create a typed in-process registry for custom tools and tool plans. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, (args: JsonObject, context: ToolContext) => Promise<JsonValue>>();
  const execute = async <TResult extends JsonValue = JsonValue>(name: string, args: JsonObject, context: ToolContext): Promise<TResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" is not registered.`);
    return tool(args, context) as Promise<TResult>;
  };
  return {
    register: (tool) => { tools.set(tool.name, createToolExecutor(tool)); },
    has: (name) => tools.has(name),
    list: () => [...tools.keys()],
    execute,
    executePlan: async (steps, context) => {
      const values: Record<string, JsonValue> = {};
      const pending = [...steps];
      while (pending.length > 0) {
        const ready = pending.filter((step) => (step.dependsOn ?? []).every((dependency) => dependency in values));
        if (ready.length === 0) throw new Error("Tool plan contains an unresolved dependency cycle.");
        for (const step of ready) { values[step.id] = await execute(step.name, step.args, context); pending.splice(pending.indexOf(step), 1); }
      }
      return values;
    },
    parallel: async (steps, context) => Promise.all(steps.map((step) => execute(step.name, step.args, context))),
    requireApproval: async (tool, args, approval, context) => { if (!await approval(tool.name, args as JsonObject, context)) throw new Error(`Tool "${tool.name}" was not approved.`); return tool.execute(args, context); },
  };
}

function createToolExecutor<TArgs extends object, TResult extends JsonValue>(tool: ToolDefinition<TArgs, TResult>): (args: JsonObject, context: ToolContext) => Promise<JsonValue> {
  return (args, context) => Promise.resolve(tool.execute(args as TArgs, context));
}
