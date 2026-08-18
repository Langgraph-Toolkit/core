/**
 * Framework-neutral model contracts for the target API.
 *
 * Provider drivers remain outside Core. This module only adapts an
 * LLMProvider into the richer Model contract used by graphs and agents.
 */
import type {
  ChatMessage,
  ChatResult,
  ChatStreamChunk,
  ChatStreamOptions,
  JsonObject,
  JsonValue,
  LLMProvider,
  LLMProviderConfig,
  ModelToolChoice,
  ModelToolSpec,
  ReasoningEffort,
  ResponseFormat,
  TokenUsage,
  ValueSchema,
} from "./types.js";

/** Request accepted by a model generate or stream call. */
export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ModelToolSpec[];
  readonly toolChoice?: ModelToolChoice;
  readonly responseFormat?: ResponseFormat;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal?: AbortSignal;
}

/** Normalized model response. */
export interface ModelResponse extends ChatResult {
  readonly reasoning?: string;
}

/** Stream chunk with a stable discriminant for token, reasoning, tool and usage events. */
export type ModelChunk = ChatStreamChunk;

/** Typed structured-output model facade. */
export interface StructuredModel<TValue extends object> {
  generate(request: Omit<ModelRequest, "responseFormat">): Promise<TValue>;
}

/**
 * Model facade used by Core graph and agent orchestration.
 *
 * A superset of the canonical `LLMProvider` contract (types.ts): `.generate()`
 * wraps `LLMProvider.chat()` with a richer request/response shape, `.stream()`
 * mirrors `LLMProvider.stream()`, and `.structured()` adds schema-constrained
 * output that `LLMProvider` does not provide. Anything that consumes an
 * `LLMProvider` (e.g. `ModelRegistry.tier()`) stays framework-neutral; use
 * `Model` only where structured output or the Core request shape is needed.
 */
export interface Model {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
  structured<TValue extends object>(schema: ValueSchema<TValue>): StructuredModel<TValue>;
}

/** Core model factory options. */
export interface ModelOptions {
  readonly name?: string;
  readonly provider?: LLMProvider;
  readonly config?: LLMProviderConfig;
  readonly factory?: (config: LLMProviderConfig) => LLMProvider;
}

/** Caller-owned named model collection. Core never creates a provider by default. */
export interface ModelPoolOptions<TName extends string> {
  readonly models: Readonly<Record<TName, Model>>;
  readonly route?: (available: readonly TName[], request: ModelRequest) => TName;
}

/** Framework-neutral multi-model routing, fallback and ensemble facade. */
export interface ModelPool<TName extends string> {
  readonly names: readonly TName[];
  get(name: TName): Model;
  route(request: ModelRequest): Model;
  fallback(names: readonly TName[]): Model;
  ensemble(names: readonly TName[], select?: (responses: readonly ModelResponse[]) => ModelResponse): Model;
}

/** Embedding generation options. */
export interface EmbeddingOptions {
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/** Result of one or more embedding calls. */
export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly model: string;
}

/** Embedding model implementation callback. */
export interface EmbeddingModelOptions {
  readonly name?: string;
  readonly embed?: (input: string | readonly string[], options?: EmbeddingOptions) => Promise<EmbeddingResult>;
}

/** Speech input accepted by a transcription model. */
export interface SpeechInput {
  readonly data: string | Uint8Array;
  readonly mimeType?: string;
}

/** Text accepted by a speech synthesis model. */
export interface SpeechText {
  readonly text: string;
  readonly voice?: string;
}

/** Speech processing options. */
export interface SpeechOptions {
  readonly language?: string;
  readonly signal?: AbortSignal;
}

/** Transcription result. */
export interface SpeechResult {
  readonly text: string;
  readonly language?: string;
}

/** Speech synthesis result. */
export interface SpeechAudio {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

/** Speech model implementation callbacks. */
export interface SpeechModelOptions {
  readonly name?: string;
  readonly transcribe?: (input: SpeechInput, options?: SpeechOptions) => Promise<SpeechResult>;
  readonly synthesize?: (input: SpeechText, options?: SpeechOptions) => Promise<SpeechAudio>;
}

/** Create a model facade from a Core-compatible provider. */
export function createModel(options: ModelOptions): Model {
  const provider = options.provider ?? createProvider(options);
  return {
    name: options.name ?? provider.name,
    generate: async (request) => provider.chat(request.messages, toChatOptions(request)),
    stream: (request) => streamProvider(provider, request),
    structured: <TValue extends object>(schema: ValueSchema<TValue>): StructuredModel<TValue> => ({
      generate: async (request) => {
        const parse = (response: ChatResult): TValue => schema.parse(parseJson(response.content));
        const options = toChatOptions(request);
        try {
          return parse(await provider.chat(request.messages, {
            ...options,
            responseFormat: { type: "json_schema", name: schema.name, schema: { type: "object" }, strict: true },
          }));
        } catch (error) {
          if (!isUnsupportedResponseFormat(error)) throw error;
          const messages = jsonOnlyMessages(request.messages, schema.name);
          try {
            return parse(await provider.chat(messages, { ...options, responseFormat: { type: "json_object" } }));
          } catch (fallbackError) {
            if (!isUnsupportedResponseFormat(fallbackError)) throw fallbackError;
            return parse(await provider.chat(messages, options));
          }
        }
      },
    }),
  };
}

/**
 * Compose already-configured models. The pool has no provider knowledge and
 * therefore cannot silently choose a vendor, credential or model.
 */
export function createModelPool<TName extends string>(options: ModelPoolOptions<TName>): ModelPool<TName> {
  const names = Object.keys(options.models) as TName[];
  if (names.length === 0) throw new Error("createModelPool requires at least one configured model.");
  const get = (name: TName): Model => {
    const model = options.models[name];
    if (!model) throw new Error(`Model pool entry \"${name}\" is not configured.`);
    return model;
  };
  const select = (request: ModelRequest): Model => get(options.route?.(names, request) ?? names[0]);
  return {
    names,
    get,
    route: select,
    fallback: (modelNames) => fallbackModel(modelNames, get),
    ensemble: (modelNames, chooser) => ensembleModel(modelNames, get, chooser),
  };
}

/** Create an embedding model from an injected implementation. */
export function createEmbeddingModel(options: EmbeddingModelOptions = {}): EmbeddingModel {
  const name = options.name ?? "embedding";
  return {
    name,
    embed: async (input, embedOptions) => {
      if (!options.embed) throw new Error(`Embedding model "${name}" has no embed implementation.`);
      return options.embed(input, embedOptions);
    },
  };
}

/** Create a speech model from injected transcription and synthesis callbacks. */
export function createSpeechModel(options: SpeechModelOptions = {}): SpeechModel {
  const name = options.name ?? "speech";
  return {
    name,
    transcribe: async (input, speechOptions) => {
      if (!options.transcribe) throw new Error(`Speech model "${name}" has no transcribe implementation.`);
      return options.transcribe(input, speechOptions);
    },
    synthesize: async (input, speechOptions) => {
      if (!options.synthesize) throw new Error(`Speech model "${name}" has no synthesize implementation.`);
      return options.synthesize(input, speechOptions);
    },
  };
}

/** Embedding model facade. */
export interface EmbeddingModel {
  readonly name: string;
  embed(input: string | readonly string[], options?: EmbeddingOptions): Promise<EmbeddingResult>;
}

/** Speech model facade. */
export interface SpeechModel {
  readonly name: string;
  transcribe(input: SpeechInput, options?: SpeechOptions): Promise<SpeechResult>;
  synthesize(input: SpeechText, options?: SpeechOptions): Promise<SpeechAudio>;
}

function createProvider(options: ModelOptions): LLMProvider {
  if (!options.config || !options.factory) {
    throw new Error("createModel requires an explicit provider, or both config and factory.");
  }
  return options.factory(options.config);
}

function jsonOnlyMessages(messages: readonly ChatMessage[], schemaName: string): readonly ChatMessage[] {
  return [{ role: "system", content: `Return only one valid JSON object for the ${schemaName} schema. Do not use Markdown fences or explanatory text.` }, ...messages];
}

function isUnsupportedResponseFormat(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("response_format") && (message.includes("unavailable") || message.includes("unsupported") || message.includes("not supported"));
}

function fallbackModel<TName extends string>(names: readonly TName[], get: (name: TName) => Model): Model {
  if (names.length === 0) throw new Error("Model fallback requires at least one configured model.");
  return {
    name: "fallback",
    generate: async (request) => {
      let lastError: Error | undefined;
      for (const name of names) {
        try { return await get(name).generate(request); }
        catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
      }
      throw lastError ?? new Error("Model fallback failed.");
    },
    stream: async function* (request) {
      let lastError: Error | undefined;
      for (const name of names) {
        try { yield* get(name).stream(request); return; }
        catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
      }
      throw lastError ?? new Error("Model fallback failed.");
    },
    structured: <TValue extends object>(responseSchema: ValueSchema<TValue>): StructuredModel<TValue> => ({
      generate: async (request) => fallbackModel(names, get).structured(responseSchema).generate(request),
    }),
  };
}

function ensembleModel<TName extends string>(names: readonly TName[], get: (name: TName) => Model, select?: (responses: readonly ModelResponse[]) => ModelResponse): Model {
  if (names.length === 0) throw new Error("Model ensemble requires at least one configured model.");
  const choose = select ?? ((responses: readonly ModelResponse[]) => responses.reduce((best, candidate) => candidate.content.length > best.content.length ? candidate : best));
  return {
    name: "ensemble",
    generate: async (request) => choose(await Promise.all(names.map((name) => get(name).generate(request)))),
    stream: async function* (request) { yield* asTokens(choose(await Promise.all(names.map((name) => get(name).generate(request))))); },
    structured: <TValue extends object>(responseSchema: ValueSchema<TValue>): StructuredModel<TValue> => ({
      generate: async (request) => responseSchema.parse(JSON.parse((await Promise.all(names.map((name) => get(name).generate(request)))).map((response) => response.content).join("\n"))),
    }),
  };
}

async function* asTokens(response: ModelResponse): AsyncIterable<ModelChunk> {
  if (response.reasoning) yield { type: "reasoning", value: response.reasoning };
  if (response.content) yield { type: "token", value: response.content };
}

function toChatOptions(request: ModelRequest): ChatStreamOptions {
  return {
    signal: request.signal,
    tools: request.tools,
    toolChoice: request.toolChoice,
    responseFormat: request.responseFormat,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    reasoningEffort: request.reasoningEffort,
  };
}

async function* streamProvider(provider: LLMProvider, request: ModelRequest): AsyncIterable<ModelChunk> {
  if (provider.streamDetailed) {
    for await (const chunk of provider.streamDetailed(request.messages, toChatOptions(request))) yield chunk;
    return;
  }
  for await (const value of provider.stream(request.messages, toChatOptions(request))) yield { type: "token", value };
}

function parseJson(value: string): JsonValue {
  const parsed: JsonValue = JSON.parse(value) as JsonValue;
  return parsed;
}

/** Convert model usage to a JSON-safe record for observability adapters. */
export function modelUsage(usage: TokenUsage | undefined): JsonObject {
  if (!usage) return {};
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}
