import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import * as legacy from "../src/legacy.js";
import * as lowLevel from "../src/low-level.js";

describe("public entrypoints", () => {
  it("keeps canonical fluent factories at the root entrypoint", () => {
    expect(core.createWorkflow).toBeTypeOf("function");
    expect(core.createGraph).toBeTypeOf("function");
    expect(core.createState).toBeTypeOf("function");
    expect(core.createNode).toBeTypeOf("function");
    expect(core.createEdge).toBeTypeOf("function");
  });

  it("isolates the former definition DSL in the legacy entrypoint", () => {
    expect("defineGraph" in core).toBe(false);
    expect("buildGraph" in core).toBe(false);
    expect("messagesValue" in core).toBe(false);
    expect(legacy.defineGraph).toBeTypeOf("function");
    expect(legacy.buildGraph).toBeTypeOf("function");
    expect(legacy.messagesValue).toBeTypeOf("function");
  });

  it("exposes exact graph primitives from the explicit low-level entrypoint", () => {
    expect(lowLevel.defineGraph).toBeTypeOf("function");
    expect(lowLevel.conditional).toBeTypeOf("function");
    expect(lowLevel.buildGraph).toBeTypeOf("function");
  });
});
