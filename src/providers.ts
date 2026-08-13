/**
 * Model registry + LLM provider drivers.
 *
 * Rule T3: nodes bind a tier alias, never a vendor. Switching from a hosted
 * vendor to an open-source model on Hugging Face is a config change.
 *
 * Built-in drivers:
 * - openai-compatible: OpenAI API, HF router (router.huggingface.co/v1),
 *   Ollama, vLLM, TGI, LiteLLM proxies
 * - huggingface: @huggingface/inference Inference Providers (serverless),
 *   with provider routing (auto/fastest/cheapest)
 * - mock: deterministic test double
 */
import type {
  Actor,
  ChatMessage,
  ChatResult,
  JsonObject,
  JsonValue,
  LLMProvider,
  LLMProviderConfig,
  ModelRegistry,
  RunPolicy,
} from "./types.js";

/** Options for ToolkitModelRegistry: tier map plus optional usage meter (Rule T4). */
export interface ModelRegistryOptions {
  /** Tier alias -> vendor config. E.g. { cheap: { driver: "huggingface", model: "..." } }. */
  tiers: Record<string, LLMProviderConfig>;
  /** Token usage meter (Rule T4): cost measured per node before shipping topology. */
  meter?: (tier: string, usage: { input: number; output: number }) => void;
}

/**
 * Build a role-based RunPolicy (Rule A1). Roles are matched against
 * actor.roles; graphs with an empty allow-list deny everyone. Combine
 * multiple policies with combinePolicies().
 */
export function rolePolicy(allowedByGraph: Record<string, string[]>): RunPolicy {
  return (actor, graphName) => {
    const roles = actor.roles ?? [];
    const allowed = allowedByGraph[graphName] ?? [];
    if (allowed.length === 0) return "deny";
    return roles.some((r) => allowed.includes(r)) ? "allow" : "deny";
  };
}

/**
 * Combine policies: all must return "allow"; a "deny" denies; "interrupt"
 * (dangerous action awaiting approval) is preserved when no deny.
 */
export function combinePolicies(...policies: RunPolicy[]): RunPolicy {
  return async (actor, graphName, opts) => {
    let interrupted = false;
    for (const p of policies) {
      const d = await p(actor, graphName, opts);
      if (d === "deny") return "deny";
      if (d === "interrupt") interrupted = true;
    }
    return interrupted ? "interrupt" : "allow";
  };
}

/**
 * Build a plan-based TierResolver (Rule A2): downgrades node bindings for
 * actors on a cheaper plan. E.g. { free: { strong: "cheap" } } routes free
 * users to "cheap" whenever a node asks for "strong".
 */
export function planTierResolver(planMap: Record<string, Record<string, string>>) {
  return (
    actor: Actor,
    binding: { tier: string },
    _graphName: string,
  ): string => {
    const plan = String(actor.claims?.plan ?? "free");
    return planMap[plan]?.[binding.tier] ?? binding.tier;
  };
}

/**
 * Tier-to-provider registry (Rule T3): nodes bind tier aliases, hosts map
 * each alias to a vendor config. recordUsage() feeds the meter; reconfigure()
 * swaps models live without restart (e.g. promote a fine-tuned model).
 */
export class ToolkitModelRegistry implements ModelRegistry {
  /** Cumulative token usage per tier alias. */
  tokenUsage = new Map<string, { input: number; output: number }>();
  private tiers: Map<string, LLMProvider>;
  private configByTier = new Map<string, LLMProviderConfig>();
  private factory: (cfg: LLMProviderConfig) => LLMProvider;
  private meter?: ModelRegistryOptions["meter"];

  constructor(opts: ModelRegistryOptions) {
    this.factory = defaultProviderFactory;
    this.meter = opts.meter;
    this.tiers = new Map();
    for (const [alias, cfg] of Object.entries(opts.tiers)) {
      this.configByTier.set(alias, cfg);
      this.tiers.set(alias, this.factory(cfg));
    }
  }

  tier(alias: string): LLMProvider {
    const provider = this.tiers.get(alias);
    if (!provider) {
      throw new Error(`Unregistered model tier "${alias}". Declare it in the registry (Rule T3).`);
    }
    return provider;
  }

  reconfigure(
    tiers: Record<string, LLMProviderConfig>,
    factory: (cfg: LLMProviderConfig) => LLMProvider = defaultProviderFactory,
  ): void {
    this.factory = factory;
    this.tiers.clear();
    this.configByTier.clear();
    for (const [alias, cfg] of Object.entries(tiers)) {
      this.configByTier.set(alias, cfg);
      this.tiers.set(alias, factory(cfg));
    }
  }

  /** Called by executor after each LLM call. */
  recordUsage(tier: string, usage: { input: number; output: number }): void {
    const current = this.tokenUsage.get(tier) ?? { input: 0, output: 0 };
    current.input += usage.input;
    current.output += usage.output;
    this.tokenUsage.set(tier, current);
    this.meter?.(tier, usage);
  }
}

/**
 * Default provider factory (Rule T3): dispatches on driver name to the
 * built-in implementations (openai-compatible, huggingface, mock).
 */
export function defaultProviderFactory(cfg: LLMProviderConfig): LLMProvider {
  switch (cfg.driver) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider(cfg);
    case "huggingface":
      return new HuggingFaceProvider(cfg);
    case "mock":
      return new MockProvider(cfg);
    default:
      throw new Error(`Unregistered LLM driver "${(cfg as LLMProviderConfig).driver}"`);
  }
}

/**
 * OpenAI-compatible driver: covers OpenAI, HF router (https://router.huggingface.co/v1),
 * Ollama (http://localhost:11434/v1), vLLM, TGI, LiteLLM proxies.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly name: string;
  constructor(private cfg: LLMProviderConfig) {
    this.name = `openai-compatible:${cfg.model}`;
  }

  private async fetchJson(messages: ChatMessage[], opts?: { signal?: AbortSignal; stream?: boolean }): Promise<JsonValue | Response> {
    const url = `${(this.cfg.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      max_tokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
      stream: opts?.stream ?? false,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey ?? ""}`,
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed (${res.status}): ${text}`);
    }
    if (opts?.stream) return res;
    return res.json();
  }

  async chat(messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<ChatResult> {
    const json = (await this.fetchJson(messages, opts)) as {
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: json.choices[0]?.message?.content ?? "",
      finishReason: json.choices[0]?.finish_reason,
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
        : undefined,
    };
  }

  async *stream(messages: ChatMessage[], opts?: { signal?: AbortSignal }): AsyncIterable<string> {
    const res = (await this.fetchJson(messages, { ...opts, stream: true })) as Response;
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}

/**
 * Hugging Face Inference Providers driver (serverless): one HF token,
 * 18+ providers routed automatically (auto/fastest/cheapest), open-source
 * models like Qwen3, Llama, DeepSeek, Mistral, Gemma, Phi.
 */
export class HuggingFaceProvider implements LLMProvider {
  readonly name: string;
  constructor(private cfg: LLMProviderConfig) {
    this.name = `huggingface:${cfg.model}`;
  }

  private async post(path: string, body: JsonObject, opts?: { signal?: AbortSignal }): Promise<JsonValue> {
    const url = `https://router.huggingface.co${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey ?? ""}`,
        "X-Provider": this.cfg.provider ?? "auto",
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HF Inference failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  async chat(messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<ChatResult> {
    const json = (await this.post("/v1/chat/completions", {
      model: this.cfg.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      ...(this.cfg.maxTokens === undefined ? {} : { max_tokens: this.cfg.maxTokens }),
      ...(this.cfg.temperature === undefined ? {} : { temperature: this.cfg.temperature }),
      stream: false,
    }, opts)) as {
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: json.choices[0]?.message?.content ?? "",
      finishReason: json.choices[0]?.finish_reason,
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
        : undefined,
    };
  }

  async *stream(messages: ChatMessage[], opts?: { signal?: AbortSignal }): AsyncIterable<string> {
    const res = await fetch(`https://router.huggingface.co/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey ?? ""}`,
        "X-Provider": this.cfg.provider ?? "auto",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        max_tokens: this.cfg.maxTokens,
        temperature: this.cfg.temperature,
        stream: true,
      }),
      signal: opts?.signal,
    });
    if (!res.ok) {
      throw new Error(`HF Inference stream failed (${res.status})`);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore
        }
      }
    }
  }
}

/** Mock provider for tests: deterministic, no network. */
export class MockProvider implements LLMProvider {
  readonly name: string;
  constructor(private cfg: LLMProviderConfig) {
    this.name = `mock:${cfg.model}`;
  }
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    return { content: `mock:${this.cfg.model}:${messages.length}`, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async *stream(): AsyncIterable<string> {
    yield "mock-stream";
  }
}
