/** Framework-neutral guardrail and risk classification facade. */
import type { JsonValue } from "./types.js";

/** Risk class used by generic guardrails. */
export type RiskLevel = "low" | "medium" | "high";

/** Result of a guardrail validation. */
export interface GuardrailResult<TValue extends JsonValue = JsonValue> {
  readonly allowed: boolean;
  readonly value: TValue;
  readonly reason?: string;
  readonly risk?: RiskLevel;
}

/** Guardrail callback. */
export type GuardrailCheck<TValue extends JsonValue = JsonValue> = (value: TValue) => boolean | Promise<boolean>;

/** Guardrail construction options. */
export interface GuardrailOptions {
  readonly input?: GuardrailCheck;
  readonly output?: GuardrailCheck;
  readonly classifyRisk?: (value: JsonValue) => RiskLevel | Promise<RiskLevel>;
  readonly denyReason?: string;
}

/** Generic input, output and risk guardrail service. */
export interface Guardrails {
  input<TValue extends JsonValue>(value: TValue): Promise<GuardrailResult<TValue>>;
  output<TValue extends JsonValue>(value: TValue): Promise<GuardrailResult<TValue>>;
  classifyRisk(value: JsonValue): Promise<RiskLevel>;
}

/** Create a framework-neutral guardrail service. */
export function createGuardrails(options: GuardrailOptions = {}): Guardrails {
  const check = async <TValue extends JsonValue>(value: TValue, validator: GuardrailCheck | undefined): Promise<GuardrailResult<TValue>> => {
    const allowed = validator ? await validator(value) : true;
    return allowed ? { allowed, value } : { allowed, value, reason: options.denyReason ?? "Guardrail rejected the value." };
  };
  return {
    input: (value) => check(value, options.input),
    output: (value) => check(value, options.output),
    classifyRisk: async (value) => options.classifyRisk ? options.classifyRisk(value) : "low",
  };
}
