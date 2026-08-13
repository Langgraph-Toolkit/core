/**
 * dispatchToQueue: run a graph as a background job without binding to a
 * specific queue implementation. Hosts provide a QueueAdapter:
 * - StruxJS app        -> Strux Queue (built-in QueueAdapter in adapter-struxjs)
 * - Express/Fastify    -> BullMQ (in adapter packages)
 * - NestJS             -> @nestjs/bull or SQS client
 */
import type { CompiledGraph, QueuedJob, QueueAdapter } from "./types.js";
import { GraphRuntimeError } from "./types.js";
import type { GraphRegistry } from "./registry.js";

const ADAPTERS = new Map<string, QueueAdapter<object>>();

/**
 * Register a queue transport (e.g. BullMQ, Strux Queue, in-memory). The host
 * adapter normally does this; application code only needs it for custom
 * transports.
 */
export function registerQueueAdapter(name: string, adapter: QueueAdapter<object>): void {
  ADAPTERS.set(name, adapter);
}

/** Look up a registered transport; undefined when none registered. */
export function getQueueAdapter(name: string): QueueAdapter<object> | undefined {
  return ADAPTERS.get(name);
}

/**
 * Enqueue a graph run as a background job. Uses the "default" transport when
 * no queue name is given. Throws when the graph or transport is missing so
 * misconfiguration fails loudly instead of silently dropping jobs.
 */
export async function dispatchToQueue<TState extends object>(
  registry: GraphRegistry,
  graphName: string,
  input: TState,
  opts: { queue?: string; delayMs?: number; threadId?: string } = {},
): Promise<string> {
  if (!registry.has(graphName)) {
    throw new GraphRuntimeError(`Graph "${graphName}" is not registered. compile() and register it first.`);
  }
  const adapter = getQueueAdapter(opts.queue ?? "default");
  if (!adapter) {
    throw new GraphRuntimeError(
      `No QueueAdapter registered for queue "${opts.queue ?? "default"}". Register one with registerQueueAdapter() or host adapter (e.g. adapter-struxjs / BullMQ).`,
    );
  }
  const job: QueuedJob<object> = {
    graphName,
    input,
    opts: { threadId: opts.threadId },
    queue: opts.queue,
  };
  return adapter.enqueue(job, { delayMs: opts.delayMs });
}

/**
 * Create a worker handler: feed it jobs from your queue consumer
 * (BullMQ process, Strux Queue listener...) to execute them via the
 * registry. One worker per host process; scale horizontally by running
 * more processes.
 */
export function createGraphRunnerWorker<TState extends object>(
  registry: GraphRegistry,
): (job: QueuedJob<TState>) => Promise<void> {
  return async (job) => {
    const compiled = registry.get(job.graphName);
    if (!compiled) {
      throw new GraphRuntimeError(`Graph "${job.graphName}" is not registered at worker time.`);
    }
    await compiled.run(job.input, {
      threadId: job.opts.threadId,
      ...job.opts,
    });
  };
}
