/** Framework-neutral reflection, consensus and quality-gate facade. */
import type { JsonObject, JsonValue, ValueSchema } from "./types.js";

/** Candidate supplied to a reflection operation. */
export interface ReflectionCandidate<TValue extends JsonValue = JsonValue> {
  readonly value: TValue;
  readonly score?: number;
  readonly feedback?: string;
}

/** Result returned by consensus, rewrite and quality-gate operations. */
export interface ReflectionResult<TValue extends JsonValue = JsonValue> {
  readonly accepted: boolean;
  readonly value: TValue;
  readonly score: number;
  readonly feedback?: string;
  readonly metadata?: JsonObject;
}

/** A typed quality check. */
export interface ReflectionCheck<TValue extends JsonValue = JsonValue> {
  readonly name: string;
  readonly check: (value: TValue) => boolean | Promise<boolean>;
}

/** Options for reflection operations. */
export interface ReflectionOptions {
  readonly threshold?: number;
  readonly consensus?: <TValue extends JsonValue>(candidates: readonly ReflectionCandidate<TValue>[]) => Promise<ReflectionResult<TValue>> | ReflectionResult<TValue>;
  readonly rewrite?: <TValue extends JsonValue>(draft: TValue, feedback: string) => Promise<TValue> | TValue;
}

/** Generic reflection service. */
export interface Reflection {
  consensus<TValue extends JsonValue>(candidates: readonly ReflectionCandidate<TValue>[]): Promise<ReflectionResult<TValue>>;
  rewrite<TValue extends JsonValue>(draft: TValue, feedback: string): Promise<TValue>;
  qualityGate<TValue extends JsonValue>(value: TValue, checks?: readonly ReflectionCheck<TValue>[]): Promise<ReflectionResult<TValue>>;
}

/** Create a deterministic reflection facade that can be replaced by a model-backed implementation. */
export function createReflection(options: ReflectionOptions = {}): Reflection {
  const threshold = options.threshold ?? 0.7;
  return {
    consensus: async <TValue extends JsonValue>(candidates: readonly ReflectionCandidate<TValue>[]) => {
      if (candidates.length === 0) throw new Error("Reflection consensus requires at least one candidate.");
      if (options.consensus) return options.consensus(candidates);
      const selected = candidates.reduce((best, candidate) => (candidate.score ?? 0) > (best.score ?? 0) ? candidate : best, candidates[0]);
      return { accepted: (selected.score ?? 0) >= threshold, value: selected.value, score: selected.score ?? 0, feedback: selected.feedback };
    },
    rewrite: async <TValue extends JsonValue>(draft: TValue, feedback: string) => options.rewrite ? options.rewrite(draft, feedback) : draft,
    qualityGate: async <TValue extends JsonValue>(value: TValue, checks: readonly ReflectionCheck<TValue>[] = []) => {
      const results = await Promise.all(checks.map((check) => check.check(value)));
      const passed = results.every(Boolean);
      return { accepted: passed, value, score: checks.length === 0 ? 1 : results.filter(Boolean).length / checks.length, feedback: passed ? undefined : "One or more reflection checks failed." };
    },
  };
}

/** Create a schema-based reflection check. */
export function reflectionCheck<TValue extends JsonValue>(name: string, schema: ValueSchema<TValue>): ReflectionCheck<TValue> {
  return { name, check: (value) => { schema.parse(value); return true; } };
}
