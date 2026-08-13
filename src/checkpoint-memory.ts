/**
 * MemoryCheckpointer: in-memory checkpoint store for dev and tests (Rule P2).
 * Not durable: use SqlCheckpointer/RedisCheckpointer/MongoCheckpointer from
 * @langgraph-toolkit/adapter-checkpointers in production. Same interface.
 */
import type { Checkpoint, Checkpointer } from "./types.js";

/**
 * In-memory checkpoint store. One thread -> ordered checkpoint history;
 * get() returns the latest, list() returns the full history.
 */
export class MemoryCheckpointer implements Checkpointer {
  private store = new Map<string, Checkpoint[]>();

  async get(threadId: string): Promise<Checkpoint | null> {
    const list = this.store.get(threadId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  async put(checkpoint: Checkpoint): Promise<void> {
    const list = this.store.get(checkpoint.threadId) ?? [];
    list.push(checkpoint);
    this.store.set(checkpoint.threadId, list);
  }

  async list(threadId: string): Promise<Checkpoint[]> {
    return [...(this.store.get(threadId) ?? [])];
  }
}
