/**
 * @langgraph-toolkit/core/queue
 *
 * Optional queue integration surface. Queue vendors and adapters can build on
 * these contracts without making queue configuration part of the graph DSL.
 */

export {
  dispatchToQueue,
  registerQueueAdapter,
  getQueueAdapter,
  createGraphWorker,
} from "./queue.js";

