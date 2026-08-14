/**
 * verify: adversarial/panel verifier gates (Rule E3 / P1).
 *
 * A verifier result MUST declare its anchors. An anchor is a non-LLM proof:
 * a linter exit code, a passing test suite, an HTTP 200, a DB row. Pure
 * "another LLM said it is fine" is NOT an anchor. compile() can enforce at
 * least one non-llm anchor per gate.
 */
import type { VerifySpec, VerifierResult, VerifierFn, CompiledGraph } from "./types.js";
import { CompileRuleViolationError, GraphRuntimeError } from "./types.js";

/** Verifier spec with functions wired (full object form of the verify DSL option). */
export interface WiredVerifySpec<TState extends object> {
  nodes: string[];
  fns: VerifySpec<TState>["fns"];
}

/** Options for runVerifiers(); requireNonLlmAnchor enforces Rule E3 at runtime. */
export interface RunVerifierOptions {
  /** At least one non-LLM anchor required across the panel. */
  requireNonLlmAnchor?: boolean;
  maxRetries?: number;
}

const NON_LLM_ANCHORS = ["code", "test", "http", "db"] as const;

/** True when the result carries at least one code/test/http/db anchor (Rule E3). */
export function hasAnchor(result: VerifierResult): boolean {
  return result.anchors.some((a) => NON_LLM_ANCHORS.includes(a as (typeof NON_LLM_ANCHORS)[number]));
}

/**
 * Compile-time verifier validation (Rule E3): every referenced node must
 * exist in the graph. Hosts call this after compile().
 */
export function validateVerifiers<TState extends object>(
  graph: CompiledGraph<TState>,
  _requireNonLlmAnchor = true,
): void {
  const spec = graph.definition.verify;
  if (!spec || spec.nodes.length === 0) return;
  for (const node of spec.nodes) {
    if (!graph.definition.nodes[node]) {
      throw new CompileRuleViolationError(
        `Verifier references an undeclared node "${node}".`,
        "E3",
      );
    }
  }
}

/**
 * Run the verifier panel over a state snapshot. Hosts typically call this on
 * the state returned by graph.run() before responding to the user (Rule E3).
 * Falls back to defaultVerifierPanel when no fns are wired; that panel
 * fails loudly unless the developer wires real verifiers.
 */
export async function runVerifiers<TState extends object>(
  graph: CompiledGraph<TState>,
  state: TState,
  opts: RunVerifierOptions = {},
): Promise<VerifierResult> {
  const spec = graph.definition.verify;
  if (!spec || spec.nodes.length === 0) {
    return { pass: true, anchors: [] };
  }
  const fns = spec.fns && spec.fns.length > 0 ? spec.fns : defaultVerifierPanel<TState>();
  const results = await Promise.all(fns.map((fn: VerifierFn<TState>) => fn(state)));
  const failing = results.filter((r: VerifierResult) => !r.pass);
  const panel = {
    pass: failing.length === 0,
    reason: failing.length > 0 ? failing.map((r: VerifierResult) => r.reason).filter(Boolean).join("; ") : undefined,
    anchors: Array.from(new Set(results.flatMap((r: VerifierResult) => r.anchors))),
  } satisfies VerifierResult;
  if (opts.requireNonLlmAnchor && !hasAnchor(panel)) {
    return {
      pass: false,
      reason: "Verifier panel has no non-LLM anchor (Rule E3): wire at least one code/test/http/db verifier.",
      anchors: panel.anchors,
    };
  }
  if (opts.maxRetries && !panel.pass) {
    void opts.maxRetries; // host/executor drives retries by looping the graph
  }
  return panel;
}

/**
 * Default panel: code/test/http/db verifiers as skeletons the developer fills.
 * Pure LLM re-checks alone are intentionally not included (Rule E3).
 */
function defaultVerifierPanel<TState extends object>(): VerifySpec<TState>["fns"] {
  return [
    async () => ({
      pass: false,
      reason: "No verifier wired. Provide verify: { nodes, fns } with at least one non-LLM anchor.",
      anchors: [],
    }),
  ];
}

/**
 * Convenience: deterministic code anchor (Rule E3). Wrap a linter/type-check
 * decision so the panel has a non-LLM proof.
 */
export function codeAnchor(fn: () => boolean): () => Promise<VerifierResult> {
  return async () => ({
    pass: fn(),
    anchors: ["code"],
  });
}

/**
 * Convenience: run an external test command (vitest, jest, pytest...) and
 * treat exit code 0 as pass (test anchor, Rule E3). Timeout 60s.
 */
export function testAnchor(cmd: string, args: string[]): () => Promise<VerifierResult> {
  return async () => {
    const { execFile } = await import("node:child_process");
    return new Promise<VerifierResult>((resolve) => {
      execFile(cmd, args, { timeout: 60_000 }, (error) => {
        resolve({ pass: error === null, reason: error?.message, anchors: ["test"] });
      });
    }).catch(() => ({ pass: false, reason: "Test runner threw", anchors: ["test"] }));
  };
}

/** Ensure a verifier panel throws rather than silently passing (Rule P1). */
export async function verifyOrThrow<TState extends object>(
  graph: CompiledGraph<TState>,
  state: TState,
): Promise<VerifierResult> {
  const result = await runVerifiers(graph, state, { requireNonLlmAnchor: true });
  if (!result.pass) {
      throw new GraphRuntimeError(`Verifier gate failed: ${result.reason ?? "unspecified reason"}`);
  }
  return result;
}
