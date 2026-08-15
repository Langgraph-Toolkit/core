/**
 * Core-owned zero-config capability facades.
 *
 * These factories provide deterministic in-process defaults and accept explicit
 * implementations when an application needs a vendor, durable store, or
 * policy-specific behavior. Concrete provider drivers remain outside Core.
 */
import { createMemory, type Memory, type MemoryOptions } from "./agent-api.js";
import { createCache, type Cache, type CacheOptions } from "./runtime-features.js";
import { createEvaluation, type Evaluation, type EvaluationOptions } from "./runtime-features.js";
import { createObservability, type Observability, type ObservabilityOptions } from "./runtime-features.js";
import { createReliability, type Reliability, type ReliabilityOptions } from "./runtime-features.js";
import { createGuardrails, type Guardrails, type GuardrailOptions } from "./safety-api.js";
import type {
  ChatMessage,
  ChatResult,
  ChatStreamOptions,
  LLMProvider,
  ModelRegistry,
} from "./types.js";
import { ModelProviderNotConfiguredError } from "./types.js";

/** Options for Core's provider-neutral model resolver. */
export interface AutoModelOptions {
  /** Use an already constructed provider when one is available. */
  readonly provider?: LLMProvider;
  /** Resolve a tier from an application-owned model registry. */
  readonly registry?: ModelRegistry;
  /** Registry tier to resolve when `registry` is supplied. */
  readonly tier?: string;
}

/** Resolve a model without coupling Core to an SDK or a provider vendor. */
export function autoModel(options: AutoModelOptions = {}): LLMProvider {
  const provider = options.provider ?? (options.registry ? options.registry.tier(options.tier ?? "strong") : undefined);
  if (provider) return provider;

  const unavailable = async (): Promise<ChatResult> => {
    throw new ModelProviderNotConfiguredError();
  };
  const unavailableStream = async function* (_messages: readonly ChatMessage[], _opts?: ChatStreamOptions): AsyncIterable<string> {
    await unavailable();
  };
  return {
    name: "core:auto-model",
    chat: unavailable,
    stream: unavailableStream,
  };
}

/** Create the in-process memory implementation used by zero-config graphs. */
export function autoMemory(options: MemoryOptions = {}): Memory {
  return createMemory(options);
}

/** Create the Core cache with deterministic process-local storage by default. */
export function autoCache(options: CacheOptions = {}): Cache {
  return createCache(options);
}

/** Create permissive guardrails that can be replaced with application policy. */
export function autoGuardrails(options: GuardrailOptions = {}): Guardrails {
  return createGuardrails(options);
}

/** Create bounded retry, fallback, timeout, recovery, and compensation behavior. */
export function autoReliability(options: ReliabilityOptions = {}): Reliability {
  return createReliability(options);
}

/** Create an in-process observability sink suitable for local runs and tests. */
export function autoObservability(options: ObservabilityOptions = {}): Observability {
  return createObservability(options);
}

/** Create the deterministic evaluation facade used by local checks and tests. */
export function autoEvaluation(options: EvaluationOptions = {}): Evaluation {
  return createEvaluation(options);
}
