import { describe, expect, it } from "vitest";
import {
  createEdge,
  createGraph,
  createNode,
  createState,
} from "../src/index.js";
import { reducedValue } from "../src/legacy.js";
import { MemoryCheckpointer } from "../src/testing-barrel.js";
import type { FrameworkState } from "../src/types.js";

describe("canonical graph facade", () => {
  it("builds and runs an inference-first graph", async () => {
    const graph = createGraph({
      name: "facade-linear",
      state: createState({ count: 0, answer: "" }),
    })
      .node("answer", createNode(async (state: { count: number; answer: string }) => ({
        count: state.count + 1,
        answer: "ready",
      })))
      .start("answer")
      .build();

    const result = await graph.run({});

    expect(result.stoppedReason).toBe("done");
    expect(result.state).toEqual({ count: 1, answer: "ready" });
  });

  it("applies createState options and exposes runtime framework fields without changing serialized output", async () => {
    const graph = createGraph({
      name: "facade-state-options",
      state: createState({ events: [] as string[], facts: {} as Record<string, number>, count: 0 }, {
        reducers: { events: "append", facts: "merge" },
        derived: { complete: (state) => state.count === 1 },
        validate: (state) => state.count >= 0,
        history: true,
        snapshots: true,
        recovery: true,
      }),
    })
      .node("record", createNode(async () => ({ events: ["recorded"], facts: { source: 1 }, count: 1 })))
      .start("record")
      .build();

    const result = await graph.run({}, { threadId: "state-contract-thread" });
    const state = result.state as typeof result.state & FrameworkState & { readonly complete: boolean };

    expect(state.events).toEqual(["recorded"]);
    expect(state.facts).toEqual({ source: 1 });
    expect(state.complete).toBe(true);
    expect(state.threadId).toBe("state-contract-thread");
    expect(state.runId).not.toBe("");
    expect(state.messages).toEqual([]);
    expect(Object.keys(state)).not.toContain("threadId");
    expect(graph.definition.stateOptions?.history).toBe(true);
    expect(graph.definition.stateOptions?.snapshots).toBe(true);
    expect(graph.definition.stateOptions?.recovery).toBe(true);
  });

  it("creates typed edges and pauses after the node has completed", async () => {
    const edge = createEdge<{ done: boolean }>("start", "END", "finish");
    expect(edge).toEqual({ from: "start", to: "END", label: "finish" });

    const graph = createGraph({
      name: "facade-after-interrupt",
      state: createState({ done: false }),
    })
      .node("finish", createNode(async (_state: { done: boolean }) => ({ done: true })))
      .start("finish")
      .interruptAfter("finish")
      .build();
    const checkpoint = new MemoryCheckpointer();

    const paused = await graph.run({}, { threadId: "after-thread", checkpoint });
    expect(paused.stoppedReason).toBe("interrupt");
    expect(paused.state.done).toBe(true);

    const resumed = await graph.run({}, { threadId: "after-thread", checkpoint });
    expect(resumed.stoppedReason).toBe("done");
    expect(resumed.state.done).toBe(true);
  });

  it("runs a collection fanout and reduces item updates", async () => {
    const graph = createGraph({
      name: "facade-fanout",
      state: createState({ items: [1, 2, 3], results: reducedValue<number[]>([], (prev, next) => [...prev, ...next]) }),
    })
      .node("work", createNode(async (state: { items: number[]; results: number[] }) => ({
        results: [state.items[0] * 2],
      })))
      .start("work")
      .fanout("work", "items")
      .reduce("results", (state) => ({ results: [...state.results] }))
      .build();

    const result = await graph.run({});

    expect(result.state.results).toEqual([2, 4, 6]);
  });

  it("waits for joined branches before running the target", async () => {
    const graph = createGraph({
      name: "facade-join",
      state: createState({ trace: [] as string[] }),
    })
      .node("left", createNode(async (state: { trace: string[] }) => ({ trace: [...state.trace, "left"] })))
      .node("right", createNode(async (state: { trace: string[] }) => ({ trace: [...state.trace, "right"] })))
      .node("done", createNode(async (state: { trace: string[] }) => ({ trace: [...state.trace, "done"] })))
      .start("left")
      .edge("left", "right")
      .edge("right", "done")
      .join(["left", "right"], "done")
      .build();

    const result = await graph.run({});

    expect(result.state.trace.filter((entry) => entry === "done")).toHaveLength(1);
    expect(result.state.trace).toContain("right");
  });

  it("routes node failures through an explicit error route", async () => {
    const graph = createGraph({
      name: "facade-error-route",
      state: createState({ status: "pending" as string }),
    })
      .node("fail", createNode(async () => {
        throw new Error("expected failure");
      }))
      .node("recover", createNode(async () => ({ status: "recovered" })))
      .start("fail")
      .onError({ node: "fail", route: () => "recover", targets: ["recover"] })
      .build();

    const result = await graph.run({});

    expect(result.state.status).toBe("recovered");
    expect(result.stoppedReason).toBe("done");
  });

  it("executes a bounded loop until its route reaches END", async () => {
    const graph = createGraph({
      name: "facade-loop",
      state: createState({ count: 0 }),
    })
      .node("step", createNode(async (state: { count: number }) => ({ count: state.count + 1 })))
      .start("step")
      .loop("step", {
        route: (state) => state.count < 2 ? "step" : "END",
        targets: ["step", "END"],
        maxRounds: 3,
      })
      .build();

    const result = await graph.run({});

    expect(result.state.count).toBe(2);
    expect(result.stoppedReason).toBe("done");
  });
});
