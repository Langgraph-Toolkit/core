/** Framework-neutral reliability, cache, streaming, observability, evaluation and execution facades. */
import type { JsonObject, JsonValue, StepEvent, TokenUsage } from "./types.js";

/** Retry and timeout controls. */
export interface RetryOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly backoff?: number;
  readonly signal?: AbortSignal;
}

/** Recovery result that preserves failure details without exposing provider types. */
export interface RecoveryResult<TValue> {
  readonly ok: boolean;
  readonly value?: TValue;
  readonly error?: Error;
  readonly attempts: number;
}

/** Reliability transaction step. */
export interface TransactionStep<TValue> {
  readonly run: () => Promise<TValue>;
  readonly compensate?: (value: TValue) => Promise<void>;
}

/** Reliability facade. */
export interface Reliability {
  retry<TValue>(operation: () => Promise<TValue>, options?: RetryOptions): Promise<TValue>;
  fallback<TValue>(operations: readonly (() => Promise<TValue>)[], options?: RetryOptions): Promise<TValue>;
  timeout<TValue>(operation: () => Promise<TValue>, timeoutMs: number): Promise<TValue>;
  transaction<TValue>(steps: readonly TransactionStep<TValue>[]): Promise<readonly TValue[]>;
  recover<TValue>(operation: () => Promise<TValue>, options?: RetryOptions): Promise<RecoveryResult<TValue>>;
}

/** Reliability construction options. */
export interface ReliabilityOptions extends RetryOptions {
  readonly onRetry?: (error: Error, attempt: number) => void | Promise<void>;
}

/** Create a retry, fallback, timeout and recovery facade. */
export function createReliability(options: ReliabilityOptions = {}): Reliability {
  const retry = async <TValue>(operation: () => Promise<TValue>, retryOptions: RetryOptions = {}): Promise<TValue> => {
    const attempts = Math.max(1, retryOptions.attempts ?? options.attempts ?? 3);
    const delayMs = retryOptions.delayMs ?? options.delayMs ?? 0;
    const backoff = retryOptions.backoff ?? options.backoff ?? 1;
    let attempt = 0;
    while (attempt < attempts) {
      if (retryOptions.signal?.aborted || options.signal?.aborted) throw new Error("Reliability operation was aborted.");
      try {
        return await operation();
      } catch (cause) {
        attempt += 1;
        const error = new Error(String(cause));
        if (attempt >= attempts) throw error;
        await options.onRetry?.(error, attempt);
        const wait = delayMs * Math.pow(backoff, attempt - 1);
        if (wait > 0) await sleep(wait);
      }
    }
    throw new Error("Reliability operation did not execute.");
  };
  return {
    retry,
    fallback: async <TValue>(operations: readonly (() => Promise<TValue>)[], retryOptions?: RetryOptions) => {
      let lastError = new Error("All fallback operations failed.");
      for (const operation of operations) {
        try { return await retry(operation, retryOptions); } catch (cause) { lastError = new Error(String(cause)); }
      }
      throw lastError;
    },
    timeout: async <T>(operation: () => Promise<T>, timeoutMs: number) => Promise.race([operation(), new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms.`)), timeoutMs))]),
    transaction: async <TValue>(steps: readonly TransactionStep<TValue>[]) => {
      const completed: Array<{ readonly step: TransactionStep<TValue>; readonly value: TValue }> = [];
      try {
        const values: TValue[] = [];
        for (const step of steps) {
          const value = await step.run();
          values.push(value);
          completed.push({ step, value });
        }
        return values;
      } catch (cause) {
        await Promise.all([...completed].reverse().map(({ step, value }) => step.compensate?.(value)));
        throw new Error(String(cause));
      }
    },
    recover: async <TValue>(operation: () => Promise<TValue>, retryOptions?: RetryOptions) => {
      try { return { ok: true, value: await retry(operation, retryOptions), attempts: Math.max(1, retryOptions?.attempts ?? options.attempts ?? 3) }; }
      catch (cause) { return { ok: false, error: new Error(String(cause)), attempts: Math.max(1, retryOptions?.attempts ?? options.attempts ?? 3) }; }
    },
  };
}

/** Cache entry options. */
export interface CacheSetOptions { readonly ttlMs?: number; }

/** JSON-safe cache facade. */
export interface Cache {
  get<TValue extends JsonValue>(key: string): Promise<TValue | undefined>;
  set<TValue extends JsonValue>(key: string, value: TValue, options?: CacheSetOptions): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

/** Cache construction options. */
export interface CacheOptions {
  readonly namespace?: string;
  readonly ttlMs?: number;
}

/** Create an in-process JSON-safe cache. */
export function createCache(options: CacheOptions = {}): Cache {
  const namespace = options.namespace ? `${options.namespace}:` : "";
  const values = new Map<string, { readonly value: JsonValue; readonly expiresAt?: number }>();
  const keyOf = (key: string) => `${namespace}${key}`;
  const active = (key: string) => {
    const entry = values.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) { values.delete(key); return false; }
    return true;
  };
  return {
    get: async <TValue extends JsonValue>(key: string) => active(keyOf(key)) ? values.get(keyOf(key))?.value as TValue : undefined,
    set: async (key, value, setOptions) => { const ttlMs = setOptions?.ttlMs ?? options.ttlMs; values.set(keyOf(key), { value, expiresAt: ttlMs === undefined ? undefined : Date.now() + ttlMs }); },
    has: async (key) => active(keyOf(key)),
    delete: async (key) => values.delete(keyOf(key)),
    clear: async () => { values.clear(); },
  };
}

/** Streaming callbacks. */
export interface StreamingOptions {
  readonly onEvent?: (event: JsonValue) => void | Promise<void>;
  readonly onToken?: (value: string) => void | Promise<void>;
  readonly onReasoning?: (value: string) => void | Promise<void>;
}

/** Event stream facade for graph, model and tool events. */
export interface Streaming {
  observe<TEvent extends JsonValue>(source: AsyncIterable<TEvent>): AsyncIterable<TEvent>;
  collect<TEvent extends JsonValue>(source: AsyncIterable<TEvent>): Promise<readonly TEvent[]>;
  tokens(source: AsyncIterable<StepEvent>): AsyncIterable<string>;
  reasoning(source: AsyncIterable<StepEvent>): AsyncIterable<string>;
}

/** Create a streaming observer without changing source event values. */
export function createStreaming(options: StreamingOptions = {}): Streaming {
  async function* observe<TEvent extends JsonValue>(source: AsyncIterable<TEvent>): AsyncIterable<TEvent> {
    for await (const event of source) { await options.onEvent?.(event); yield event; }
  }
  return {
    observe,
    collect: async <TEvent extends JsonValue>(source: AsyncIterable<TEvent>) => { const events: TEvent[] = []; for await (const event of observe(source)) events.push(event); return events; },
    tokens: filterEvents("token", options.onToken),
    reasoning: filterEvents("reasoning", options.onReasoning),
  };
}

/** Trace span returned by observability. */
export interface TraceSpan {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  end(status?: "ok" | "error"): TraceRecord;
}

/** JSON-safe trace record. */
export interface TraceRecord {
  readonly id: string;
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: "ok" | "error";
  readonly attributes?: JsonObject;
}

/** Observability construction options. */
export interface ObservabilityOptions {
  readonly onTrace?: (record: TraceRecord) => void | Promise<void>;
  readonly attributes?: JsonObject;
}

/** Trace and usage facade. */
export interface Observability {
  start(name: string, attributes?: JsonObject): TraceSpan;
  record(event: JsonValue): Promise<void>;
  usage(usage: TokenUsage, attributes?: JsonObject): Promise<void>;
}

/** Create an in-process observability facade. */
export function createObservability(options: ObservabilityOptions = {}): Observability {
  return {
    start: (name, attributes) => {
      const id = `trace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const startedAt = Date.now();
      let ended = false;
      return { id, name, startedAt, end: (status = "ok") => { const record = { id, name, startedAt, endedAt: Date.now(), status, attributes: { ...(options.attributes ?? {}), ...(attributes ?? {}) } }; if (!ended) { ended = true; void options.onTrace?.(record); } return record; } };
    },
    record: async (event) => { await options.onTrace?.({ id: `event-${Date.now()}`, name: "event", startedAt: Date.now(), endedAt: Date.now(), status: "ok", attributes: isObject(event) ? event : { value: event } }); },
    usage: async (usage, attributes) => { await options.onTrace?.({ id: `usage-${Date.now()}`, name: "usage", startedAt: Date.now(), endedAt: Date.now(), status: "ok", attributes: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(attributes ?? {}) } }); },
  };
}

/** Evaluation case. */
export interface EvaluationCase<TInput extends JsonObject = JsonObject, TExpected extends JsonValue = JsonValue> { readonly id: string; readonly input: TInput; readonly expected?: TExpected; }

/** Evaluation result. */
export interface EvaluationResult { readonly id: string; readonly passed: boolean; readonly score: number; readonly actual?: JsonValue; readonly reason?: string; }

/** Evaluation report. */
export interface EvaluationReport { readonly results: readonly EvaluationResult[]; readonly score: number; readonly passed: boolean; }

/** Evaluation construction options. */
export interface EvaluationOptions { readonly threshold?: number; readonly score?: (actual: JsonValue, expected: JsonValue | undefined) => number | Promise<number>; }

/** Online and dataset evaluation facade. */
export interface Evaluation {
  online<TInput extends JsonObject>(input: TInput, actual: JsonValue, expected?: JsonValue): Promise<EvaluationResult>;
  run<TInput extends JsonObject>(cases: readonly EvaluationCase<TInput>[], execute: (input: TInput) => Promise<JsonValue>): Promise<EvaluationReport>;
}

/** Create an evaluation facade for online quality checks and datasets. */
export function createEvaluation(options: EvaluationOptions = {}): Evaluation {
  const score = async (actual: JsonValue, expected: JsonValue | undefined) => options.score ? options.score(actual, expected) : expected === undefined ? 1 : JSON.stringify(actual) === JSON.stringify(expected) ? 1 : 0;
  return {
    online: async (_input, actual, expected) => { const value = await score(actual, expected); return { id: `online-${Date.now()}`, passed: value >= (options.threshold ?? 0.7), score: value, actual, reason: value >= (options.threshold ?? 0.7) ? undefined : "Evaluation score is below threshold." }; },
    run: async (cases, execute) => { const results: EvaluationResult[] = []; for (const item of cases) { const actual = await execute(item.input); const value = await score(actual, item.expected); results.push({ id: item.id, passed: value >= (options.threshold ?? 0.7), score: value, actual }); } const average = results.length === 0 ? 0 : results.reduce((sum, item) => sum + item.score, 0) / results.length; return { results, score: average, passed: average >= (options.threshold ?? 0.7) }; },
  };
}

/** Execution runtime options. */
export interface ExecutionRuntimeOptions { readonly concurrency?: number; }

/** Generic scheduling runtime for async work. */
export interface ExecutionRuntime {
  run<TValue>(operation: () => Promise<TValue>): Promise<TValue>;
  parallel<TValue>(operations: readonly (() => Promise<TValue>)[]): Promise<readonly TValue[]>;
}

/** Create a lightweight async execution runtime. */
export function createExecutionRuntime(options: ExecutionRuntimeOptions = {}): ExecutionRuntime {
  const concurrency = Math.max(1, options.concurrency ?? Number.POSITIVE_INFINITY);
  return {
    run: async (operation) => operation(),
    parallel: async <TValue>(operations: readonly (() => Promise<TValue>)[]) => {
      if (!Number.isFinite(concurrency) || operations.length <= concurrency) return Promise.all(operations.map((operation) => operation()));
      const values: TValue[] = []; let cursor = 0;
      const worker = async () => { while (cursor < operations.length) { const index = cursor; cursor += 1; values[index] = await operations[index](); } };
      await Promise.all(Array.from({ length: concurrency }, worker));
      return values;
    },
  };
}

function filterEvents(kind: "token" | "reasoning", callback?: (value: string) => void | Promise<void>): (source: AsyncIterable<StepEvent>) => AsyncIterable<string> {
  return async function* (source) { for await (const event of source) { if (event.type !== kind) continue; const value = event.data.value; await callback?.(value); yield value; } };
}

function asError(cause: Error | JsonValue): Error { return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : JSON.stringify(cause)); }
function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function isObject(value: JsonValue): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
