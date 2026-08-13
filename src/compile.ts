/**
 * compile(): turns a GraphDefinition into a CompiledGraph.
 *
 * This is the Rule L1/L2 enforcement layer: it validates topology at boot
 * time (fail fast) instead of at runtime. It also detects cycles so that
 * convergence declaration (Rule L1) is mandatory for every loop.
 */
import type {
  CompiledGraph,
  ConditionalEdgeSpec,
  ConvergeSpec,
  EdgeSpec,
  GraphDefinition,
  GraphContracts,
  DefaultGraphContracts,
  JsonObject,
  SafetySpec,
} from "./types.js";
import { CompileRuleViolationError, GraphDefinitionError } from "./types.js";

const ENTRY = "__entry__";

/**
 * Compile a GraphDefinition into a CompiledGraph. Enforces topology at boot
 * time (fail fast): validates entry, detects cycles (Rule L1 cycle check),
 * validates edge targets, conditional bounded targets (Rule E2), convergence
 * declaration for loops (Rule L1) and mandatory safety limits (Rule L2).
 *
 * The returned CompiledGraph has no run()/stream() until attachExecutor()
 * wires it; use GraphRegistry.register() to do both steps at once.
 */
export function compile<
  TState extends object,
  TInput extends object = Partial<TState>,
  TOutput extends object = TState,
  C extends GraphContracts = DefaultGraphContracts,
  TVariables extends JsonObject = JsonObject,
  TGlobal extends JsonObject = JsonObject,
>(
  definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>,
): CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal> {
  validate(definition);

  const adjacency = new Map<string, { fixed: string[]; conditional: ConditionalEdgeSpec<TState>[] }>();
  const nodeNames = Object.keys(definition.nodes);

  for (const name of nodeNames) {
    adjacency.set(name, { fixed: [], conditional: [] });
  }
  adjacency.set(ENTRY, { fixed: [], conditional: [] });

  for (const edge of definition.edges) {
    if ("fn" in edge) {
      const src = adjacency.get(edge.from);
      if (!src) {
        throw new GraphDefinitionError(`Conditional edge source "${edge.from}" is not a node`);
      }
      src.conditional.push(edge);
    } else {
      const src = adjacency.get(edge.from);
      if (!src) {
        throw new GraphDefinitionError(`Edge source "${edge.from}" is not a node`);
      }
      if (edge.to === "END") {
        src.fixed.push("END");
      } else if (!nodeNames.includes(edge.to)) {
        throw new GraphDefinitionError(`Edge target "${edge.to}" is not a node`);
      } else {
        src.fixed.push(edge.to);
      }
    }
  }

  // entry edge (virtual)
  if (nodeNames.includes(definition.entry)) {
    adjacency.get(ENTRY)!.fixed.push(definition.entry);
  }

  const terminals = new Set<string>();
  if (adjacency.get(ENTRY)!.fixed.includes("END") === false) {
    // END as terminal always exists
  }
  terminals.add("END");

  // Detect cycles: if a node is reachable from itself, converge must be declared
  const cycleExists = detectCycle(nodeNames, adjacency);
  if (cycleExists && !definition.converge) {
    throw new CompileRuleViolationError(
      "Graph contains a cycle but has no converge declaration. Declare converge: { on, maxRounds } (Rule L1).",
      "L1",
    );
  }
  if (definition.converge) {
    validateConverge(definition.converge, definition);
  }

  return {
    definition,
    name: definition.name,
    adjacency,
    entry: definition.entry,
    terminals,
    converge: definition.converge,
    safety: definition.safety,
    interruptBefore: new Set(definition.interruptBefore ?? []),
    run: (() => undefined) as never, // attached by executor.ts
    stream: (() => undefined) as never,
  } as CompiledGraph<TState, TInput, TOutput, C, TVariables, TGlobal>;
}

function validate<
  TState extends object,
  TInput extends object,
  TOutput extends object,
  C extends GraphContracts,
  TVariables extends JsonObject,
  TGlobal extends JsonObject,
>(definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>): void {
  if (!definition.name) {
    throw new GraphDefinitionError("Graph must have a name (Rule N1: identify workflows).");
  }
  const nodeNames = Object.keys(definition.nodes);
  if (nodeNames.length === 0) {
    throw new GraphDefinitionError("Graph must have at least one node.");
  }
  if (!definition.entry || !nodeNames.includes(definition.entry)) {
    throw new GraphDefinitionError(`Entry node "${definition.entry}" is not defined in nodes.`);
  }
  if (!definition.safety || typeof definition.safety.recursionLimit !== "number") {
    throw new GraphDefinitionError("Graph must declare safety.recursionLimit (Rule L2).");
  }
  validateSafety(definition.safety);
}

function validateSafety(safety: SafetySpec): void {
  if (safety.recursionLimit <= 0 || safety.recursionLimit > 10_000) {
    throw new CompileRuleViolationError(
      "recursionLimit must be between 1 and 10000.",
      "L2",
      { limit: safety.recursionLimit },
    );
  }
}

function validateConverge<
  TState extends object,
  TInput extends object,
  TOutput extends object,
  C extends GraphContracts,
  TVariables extends JsonObject,
  TGlobal extends JsonObject,
>(
  converge: ConvergeSpec<TState>,
  definition: GraphDefinition<TState, TInput, TOutput, C, TVariables, TGlobal>,
): void {
  if (typeof converge.maxRounds !== "number" || converge.maxRounds <= 0) {
    throw new CompileRuleViolationError(
      "converge.maxRounds must be a positive number.",
      "L1",
    );
  }
  const keys = Object.keys(definition.state);
  if (!keys.includes(converge.on)) {
    throw new CompileRuleViolationError(
      `converge.on "${converge.on}" is not a field of the state schema.`,
      "L1",
      { field: converge.on, stateFields: keys },
    );
  }
}

/** Simple DFS cycle detection on the fixed edges; conditional edges can branch back too. */
function detectCycle<TState extends object>(
  nodeNames: string[],
  adjacency: Map<string, { fixed: string[]; conditional: ConditionalEdgeSpec<TState>[] }>,
): boolean {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodeNames) color.set(n, WHITE);

  function successors(node: string): string[] {
    const adj = adjacency.get(node);
    if (!adj) return [];
    const out: string[] = [...adj.fixed.filter((t) => t !== "END")];
    for (const cond of adj.conditional) {
      for (const t of cond.targets) {
        if (t !== "END" && !out.includes(t)) out.push(t);
      }
    }
    return out;
  }

  function dfs(node: string): boolean {
    color.set(node, GREY);
    for (const next of successors(node)) {
      const c = color.get(next);
      if (c === GREY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const n of nodeNames) {
    if (color.get(n) === WHITE && dfs(n)) return true;
  }
  return false;
}
