/**
 * Framework-neutral reasoning and planning facades.
 *
 * Intent classification delegates to an injected LLM analyzer or Model. This
 * module intentionally has no lexical or regular-expression intent fallback.
 */
import type { Model } from "./model-api.js";
import type { IntentAnalyzer, IntentClassification, JsonObject, JsonValue, LLMSession, ReasoningEffort, ValueSchema } from "./types.js";

/** Options passed to one reasoning operation. */
export interface ReasoningRunOptions {
  readonly model?: Model;
  readonly signal?: AbortSignal;
  readonly threadId?: string;
  readonly context?: JsonObject;
  readonly reasoningEffort?: ReasoningEffort;
}

/** One executable planning task. */
export interface ReasoningTask {
  readonly id: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly input?: JsonObject;
}

/** A dependency edge between planning tasks. */
export interface ReasoningDependency {
  readonly from: string;
  readonly to: string;
}

/** A typed plan produced by the reasoning facade. */
export interface ReasoningPlan {
  readonly goal: string;
  readonly tasks: readonly ReasoningTask[];
  readonly dependencies: readonly ReasoningDependency[];
  readonly metadata?: JsonObject;
}

/** Result supplied to a replan operation. */
export interface ReasoningResult {
  readonly success: boolean;
  readonly output?: JsonValue;
  readonly feedback?: string;
  readonly metadata?: JsonObject;
}

/** Options for the generic reasoning facade. */
export interface ReasoningOptions<TIntent extends string = string> {
  readonly name?: string;
  readonly model?: Model;
  readonly intents?: readonly TIntent[];
  readonly analyzer?: IntentAnalyzer<JsonObject, TIntent>;
  readonly classify?: (input: JsonObject, options?: ReasoningRunOptions) => Promise<IntentClassification<TIntent>>;
  readonly plan?: (input: JsonObject, options?: ReasoningRunOptions) => Promise<ReasoningPlan> | ReasoningPlan;
  readonly advanced?: (input: JsonObject, options?: ReasoningRunOptions) => Promise<ReasoningPlan> | ReasoningPlan;
  readonly replan?: (plan: ReasoningPlan, result: ReasoningResult) => Promise<ReasoningPlan> | ReasoningPlan;
}

/** Advanced reasoning options. */
export interface AdvancedReasoningOptions extends ReasoningRunOptions {
  readonly candidates?: number;
  readonly beamWidth?: number;
}

/** Dependency graph returned by planning analysis. */
export interface DependencyGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly ReasoningDependency[];
}

/** Generic reasoning service. */
export interface Reasoning<TIntent extends string = string> {
  classify<TInput extends object>(input: TInput, options?: ReasoningRunOptions): Promise<IntentClassification<TIntent>>;
  plan<TInput extends object>(input: TInput, options?: ReasoningRunOptions): Promise<ReasoningPlan>;
  analyzeDependencies(plan: ReasoningPlan): DependencyGraph;
  generateSubtasks(plan: ReasoningPlan): readonly ReasoningTask[];
  advanced<TInput extends object>(input: TInput, options?: AdvancedReasoningOptions): Promise<ReasoningPlan>;
  replan(plan: ReasoningPlan, result: ReasoningResult): Promise<ReasoningPlan>;
}

/** Create an LLM-backed, domain-neutral reasoning facade. */
export function createReasoning<TIntent extends string = string>(options: ReasoningOptions<TIntent> = {}): Reasoning<TIntent> {
  const name = options.name ?? "reasoning";
  const model = options.model;
  const classify = async <TInput extends object>(input: TInput, runOptions?: ReasoningRunOptions): Promise<IntentClassification<TIntent>> => {
    const value = toJsonObject(input);
    if (options.classify) return options.classify(value, runOptions);
    if (options.analyzer) {
      const activeModel = runOptions?.model ?? model;
      if (!activeModel) throw new Error(`Reasoning "${name}" requires a Model for its IntentAnalyzer.`);
      return options.analyzer.analyze(value, createIntentContext(activeModel, runOptions));
    }
    const activeModel = runOptions?.model ?? model;
    if (!activeModel) throw new Error(`Reasoning "${name}" requires a Model or classify callback.`);
    const response = await activeModel.structured(classificationSchema<TIntent>(options.intents)).generate({
      messages: [{ role: "system", content: "Classify the input into one intent and return the requested JSON shape." }, { role: "user", content: JSON.stringify(value) }],
      reasoningEffort: runOptions?.reasoningEffort,
      signal: runOptions?.signal,
    });
    return response;
  };
  const plan = async <TInput extends object>(input: TInput, runOptions?: ReasoningRunOptions): Promise<ReasoningPlan> => {
    const value = toJsonObject(input);
    if (options.plan) return options.plan(value, runOptions);
    const activeModel = runOptions?.model ?? model;
    if (activeModel) return activeModel.structured(reasoningPlanSchema).generate({ messages: [{ role: "system", content: "Create a typed execution plan with independent tasks and dependencies." }, { role: "user", content: JSON.stringify(value) }], reasoningEffort: runOptions?.reasoningEffort, signal: runOptions?.signal });
    return singleTaskPlan(value);
  };
  return {
    classify,
    plan,
    analyzeDependencies: (currentPlan) => ({ nodes: currentPlan.tasks.map((task) => task.id), edges: currentPlan.dependencies }),
    generateSubtasks: (currentPlan) => currentPlan.tasks,
    advanced: async (input, runOptions) => options.advanced ? options.advanced(toJsonObject(input), runOptions) : plan(input, runOptions),
    replan: async (currentPlan, result) => options.replan ? options.replan(currentPlan, result) : ({ ...currentPlan, metadata: { ...(currentPlan.metadata ?? {}), replanned: true, success: result.success } }),
  };
}

const reasoningPlanSchema: ValueSchema<ReasoningPlan> = {
  name: "ReasoningPlan",
  parse: parsePlan,
};

function classificationSchema<TIntent extends string>(intents: readonly TIntent[] | undefined): ValueSchema<IntentClassification<TIntent>> {
  return {
    name: "IntentClassification",
    parse: (value) => parseClassification(value, intents),
  };
}

function parseClassification<TIntent extends string>(value: JsonValue, intents: readonly TIntent[] | undefined): IntentClassification<TIntent> {
  const record = asObject(value, "Intent classification");
  const intent = record.intent;
  if (typeof intent !== "string") throw new Error("Intent classification must contain a string intent.");
  if (intents && !intents.includes(intent as TIntent)) throw new Error(`Intent "${intent}" is not in the configured intent list.`);
  const details = isObject(record.details) ? record.details : {};
  const analysisValue = isObject(record.analysis) ? record.analysis : {};
  const confidence = typeof analysisValue.confidence === "number" ? analysisValue.confidence : 0;
  const language = typeof analysisValue.language === "string" ? analysisValue.language : "und";
  const needsClarification = analysisValue.needsClarification === true;
  return { value: intent as TIntent, details, analysis: { confidence, language, needsClarification } };
}

function parsePlan(value: JsonValue): ReasoningPlan {
  const record = asObject(value, "Reasoning plan");
  const goal = typeof record.goal === "string" ? record.goal : "Execute the requested workflow.";
  const taskValues = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks = taskValues.map((task, index) => {
    const item = asObject(task, `Reasoning task ${index}`);
    const id = typeof item.id === "string" ? item.id : `task-${index + 1}`;
    const description = typeof item.description === "string" ? item.description : id;
    const dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.filter((entry): entry is string => typeof entry === "string") : [];
    return { id, description, dependsOn, input: isObject(item.input) ? item.input : undefined };
  });
  const dependencies = tasks.flatMap((task) => task.dependsOn.map((from) => ({ from, to: task.id })));
  return { goal, tasks, dependencies, metadata: isObject(record.metadata) ? record.metadata : undefined };
}

function singleTaskPlan(input: JsonObject): ReasoningPlan {
  const goal = typeof input.goal === "string" ? input.goal : "Execute the requested workflow.";
  return { goal, tasks: [{ id: "task-1", description: goal, dependsOn: [], input }], dependencies: [] };
}

function createIntentContext(model: Model, options?: ReasoningRunOptions): { readonly model: LLMSession; readonly threadId: string; readonly runId: string; readonly actor?: undefined; readonly emitAnalysis: (analysis: { readonly confidence: number; readonly language: string; readonly needsClarification: boolean }) => void; readonly emitToken: (value: string, index: number) => void; readonly emitReasoning: (value: string, index: number) => void; readonly emitUsage: (value: { readonly inputTokens: number; readonly outputTokens: number }) => void } {
  return {
    model: { chat: async (messages, chatOptions) => model.generate({ messages, signal: chatOptions?.signal, tools: chatOptions?.tools, toolChoice: chatOptions?.toolChoice, responseFormat: chatOptions?.responseFormat, temperature: chatOptions?.temperature, maxTokens: chatOptions?.maxTokens, reasoningEffort: chatOptions?.reasoningEffort }) },
    threadId: options?.threadId ?? "reasoning",
    runId: `reasoning-${Date.now()}`,
    emitAnalysis: () => undefined,
    emitToken: () => undefined,
    emitReasoning: () => undefined,
    emitUsage: () => undefined,
  };
}

function toJsonObject(value: object): JsonObject {
  return value as JsonObject;
}

function asObject(value: JsonValue, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
