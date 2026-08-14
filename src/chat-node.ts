import type {
  ChatMessage,
  ModelToolCall,
  GraphContracts,
  DefaultGraphContracts,
  NodeFunction,
  NodeContext,
} from "./types.js";

/** Options for a model-backed node that streams public answer events. */
export interface StreamChatNodeOptions<
  TState extends object,
  C extends GraphContracts = DefaultGraphContracts,
> {
  readonly messages: (state: TState) => readonly ChatMessage[];
  readonly thinking: C["thinking"];
  readonly toAnswer: (value: string) => C["answer"];
  readonly update: (state: TState, answer: string) => Partial<TState>;
}

/**
 * Build a typed model node with the common stream lifecycle already handled.
 * The helper emits token, reasoning and answer events and falls back to chat()
 * when the selected provider does not expose detailed streaming.
 */
export function streamChatNode<
  TState extends object,
  C extends GraphContracts = DefaultGraphContracts,
>(options: StreamChatNodeOptions<TState, C>): NodeFunction<TState, C> {
  return async (state, ctx) => {
    ctx.think(options.thinking, "Generate answer");
    const messages = options.messages(state);
    const detailedStream = ctx.model.streamDetailed?.(messages, { signal: ctx.signal });
    if (detailedStream !== undefined) {
      let answer = "";
      let tokenIndex = 0;
      let reasoningIndex = 0;
      for await (const chunk of detailedStream) {
        if (ctx.cancelled()) return options.update(state, answer);
        if (chunk.type === "token") {
          answer += chunk.value;
          ctx.emit({
            graph: ctx.graph,
            threadId: ctx.threadId,
            runId: ctx.runId,
            type: "token",
            ts: Date.now(),
            data: { value: chunk.value, index: tokenIndex },
          });
          tokenIndex += 1;
        } else if (chunk.type === "reasoning") {
          ctx.emit({
            graph: ctx.graph,
            threadId: ctx.threadId,
            runId: ctx.runId,
            type: "reasoning",
            ts: Date.now(),
            data: { value: chunk.value, index: reasoningIndex },
          });
          reasoningIndex += 1;
        } else if (chunk.type === "tool_call") {
          ctx.emit({
            graph: ctx.graph,
            threadId: ctx.threadId,
            runId: ctx.runId,
            type: "model_tool_call",
            ts: Date.now(),
            data: chunk.value,
          });
        } else if (chunk.type === "usage") {
          ctx.emit({
            graph: ctx.graph,
            threadId: ctx.threadId,
            runId: ctx.runId,
            type: "usage",
            ts: Date.now(),
            data: { tier: "model", value: chunk.value },
          });
        }
      }
      const finalAnswer = options.toAnswer(answer);
      ctx.emit({
        graph: ctx.graph,
        threadId: ctx.threadId,
        runId: ctx.runId,
        type: "answer",
        ts: Date.now(),
        data: { value: finalAnswer },
      });
      return options.update(state, answer);
    }

    const result = await ctx.model.chat(messages);
    for (const toolCall of result.toolCalls ?? []) {
      emitToolCall(ctx, toolCall);
    }
    const finalAnswer = options.toAnswer(result.content);
    ctx.emit({
      graph: ctx.graph,
      threadId: ctx.threadId,
      runId: ctx.runId,
      type: "answer",
      ts: Date.now(),
      data: { value: finalAnswer },
    });
    return options.update(state, result.content);
  };
}

function emitToolCall<TState extends object, C extends GraphContracts>(ctx: NodeContext<TState, C>, call: ModelToolCall): void {
  ctx.emit({
    graph: ctx.graph,
    threadId: ctx.threadId,
    runId: ctx.runId,
    type: "model_tool_call",
    ts: Date.now(),
    data: { id: call.id, index: 0, name: call.name, arguments: JSON.stringify(call.arguments) },
  });
}
