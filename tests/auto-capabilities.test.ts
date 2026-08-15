import { describe, expect, it } from "vitest";
import {
  autoCache,
  autoEvaluation,
  autoGuardrails,
  autoMemory,
  autoModel,
  autoObservability,
  autoReliability,
  ModelProviderNotConfiguredError,
} from "../src/index.js";

describe("Core auto capabilities", () => {
  it("provides deterministic local defaults and defers missing model configuration until use", async () => {
    const cache = autoCache();
    await cache.set("answer", 42);
    expect(await cache.get<number>("answer")).toBe(42);

    const guardrails = autoGuardrails();
    expect((await guardrails.input("safe")).allowed).toBe(true);
    expect(await autoReliability({ attempts: 1 }).retry(async () => "ok")).toBe("ok");
    expect((await autoEvaluation().online({ query: "q" }, "a", "a")).passed).toBe(true);
    expect(autoMemory()).toBeDefined();
    expect(autoObservability().start("contract").name).toBe("contract");

    await expect(autoModel().chat([{ role: "user", content: "hello" }])).rejects.toBeInstanceOf(ModelProviderNotConfiguredError);
  });
});
