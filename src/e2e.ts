/**
 * E2E testing harness for contributors.
 *
 * Spin up a host (Express/Fastify/NestJS), mount the registry, and run real
 * HTTP assertions against /run and /stream. The harness stays dependency-
 * free: hosts are created by factories the contributor injects.
 *
 * @example
 *   import { GraphRegistry } from "@langgraph/toolkit";
 *   import { e2eRun, e2eStream, expectDone } from "@langgraph/toolkit/e2e";
 *
 *   const result = await e2eRun("http://localhost:3000/agents/chat/run", {
 *     input: { messages: [{ role: "user", content: "hi" }] },
 *   });
 *   expectDone(result);
 */
import type { Actor, Checkpoint, CompiledGraph, JsonObject, JsonValue, RunResult } from "./types.js";

/** JSON body sent to a host's /run endpoint (same shape for /stream). */
export interface E2eRunRequest<TInput extends object = object, TOptions extends object = object> {
  input: TInput;
  opts?: TOptions;
}

/** Parsed /run HTTP response: status code plus decoded body. */
export interface E2eRunResponse<
  TState extends object = object,
  TOutput extends object = TState,
  TInterrupt extends JsonValue = JsonValue,
  TVariables extends JsonObject = JsonObject,
> {
  status: number;
  body: RunResult<TState, TOutput, TInterrupt, TVariables> | null;
}

/** A single SSE event parsed from a /stream response. */
export interface ParsedSseEvent<TData extends object = object> {
  type: string;
  node?: string;
  data?: TData;
}

const TERMINAL_TYPES = new Set(["done", "interrupt", "safety", "cancelled", "error"]);

/**
 * POST /run against a host and return the parsed JSON result.
 */
export async function e2eRun<
  TInput extends object = object,
  TState extends object = object,
  TOutput extends object = TState,
  TInterrupt extends JsonValue = JsonValue,
  TVariables extends JsonObject = JsonObject,
>(url: string, req: E2eRunRequest<TInput>): Promise<E2eRunResponse<TState, TOutput, TInterrupt, TVariables>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => null) as RunResult<TState, TOutput, TInterrupt, TVariables> | null;
  return { status: res.status, body };
}

/**
 * GET /stream and parse the SSE events until the terminal event.
 * Returns the ordered list of event types plus the terminal event type.
 */
export async function e2eStream<TInput extends object = object, TData extends object = object>(url: string, req: E2eRunRequest<TInput>): Promise<{
  events: ParsedSseEvent<TData>[];
  types: string[];
  terminal: string | null;
}> {
  const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
  const text = await res.text();
  const events: ParsedSseEvent<TData>[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n");
    const data = lines.find((l) => l.startsWith("data:"));
    if (!data) continue;
    try {
      const payload = JSON.parse(data.slice(5).trim()) as { type: string; node?: string; data?: TData };
      events.push({ type: payload.type, node: payload.node, data: payload.data });
    } catch {
      // keep-alive comment or malformed chunk; ignore
    }
  }
  const types = events.map((e) => e.type);
  let terminal: string | null = null;
  for (let i = types.length - 1; i >= 0; i--) {
    if (TERMINAL_TYPES.has(types[i])) {
      terminal = types[i];
      break;
    }
  }
  return { events, types, terminal };
}

/** Assert a /run result finished normally (stoppedReason done). */
export function expectDone<
  TState extends object,
  TOutput extends object = TState,
  TInterrupt extends JsonValue = JsonValue,
  TVariables extends JsonObject = JsonObject,
>(result: E2eRunResponse<TState, TOutput, TInterrupt, TVariables> | RunResult<TState, TOutput, TInterrupt, TVariables>): asserts result is E2eRunResponse<TState, TOutput, TInterrupt, TVariables> | RunResult<TState, TOutput, TInterrupt, TVariables> {
  if ("body" in result && result.status !== 200) {
    throw new Error(`E2E assertion failed: expected status 200, got ${result.status}`);
  }
  const body = "body" in result ? result.body : result;
  if (!body || body.stoppedReason !== "done") {
    throw new Error(`E2E assertion failed: expected stoppedReason "done", got ${body?.stoppedReason ?? "missing"}`);
  }
}

/** Assert a /run result was interrupted (stoppedReason interrupt). */
export function expectInterrupted<
  TState extends object,
  TOutput extends object = TState,
  TInterrupt extends JsonValue = JsonValue,
  TVariables extends JsonObject = JsonObject,
>(result: E2eRunResponse<TState, TOutput, TInterrupt, TVariables> | RunResult<TState, TOutput, TInterrupt, TVariables>): asserts result is E2eRunResponse<TState, TOutput, TInterrupt, TVariables> | RunResult<TState, TOutput, TInterrupt, TVariables> {
  if ("body" in result && result.status !== 200) {
    throw new Error(`E2E assertion failed: expected status 200, got ${result.status}`);
  }
  const body = "body" in result ? result.body : result;
  if (!body || body.stoppedReason !== "interrupt") {
    throw new Error(`E2E assertion failed: expected stoppedReason "interrupt", got ${body?.stoppedReason ?? "missing"}`);
  }
}

/** Assert the SSE stream ends with a terminal event. */
export function expectTerminal(stream: { types: string[]; terminal: string | null }): void {
  if (!stream.terminal) {
    throw new Error(`E2E assertion failed: SSE stream has no terminal event; types=[${stream.types.join(",")}]`);
  }
}

// ---------- In-memory E2E scenario runner (no HTTP server needed) ----------

/**
 * Run a compiled graph through a realistic checkpoint persist/resume cycle
 * entirely in memory: first run pauses at an interrupt, second run resumes
 * with a human response, third run verifies completion. This is the minimal
 * E2E test every contributor should add when writing a new graph.
 */
export async function e2eScenarioResume<TState extends object, TAnswer extends import("./types.js").JsonValue = import("./types.js").JsonValue>(opts: {
  graph: CompiledGraph<TState>;
  input: Partial<TState>;
  checkpoint: import("./types.js").Checkpointer;
  response: TAnswer;
}): Promise<{ resumed: RunResult<TState> }> {
  const threadId = "e2e-scenario";
  const cp = opts.checkpoint;
  await opts.graph.run(opts.input, { threadId, checkpoint: cp });
  const resumed = await opts.graph.run(opts.input, {
    threadId,
    checkpoint: cp,
    resumeFrom: undefined,
    humanResponse: opts.response,
  });
  return { resumed };
}

/** Build an actor for permission E2E scenarios. */
export function e2eActor(id: string, roles?: string[], claims?: import("./types.js").JsonObject): Actor {
  return { id, roles, claims };
}
