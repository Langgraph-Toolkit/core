import { createModel } from "../src/model-api.js";
import { createReasoning } from "../src/reasoning-api.js";
import type { LLMProvider } from "../src/types.js";
import { describe, expect, it } from "vitest";

describe("LLM-backed intent policy", () => {
  it("enumerates the only allowed intent labels in the model prompt", async () => {
    let systemPrompt = "";
    const provider: LLMProvider = {
      name: "policy-aware",
      async chat(messages) {
        systemPrompt = messages[0]?.content ?? "";
        return { content: '{"intent":"query"}' };
      },
      async *stream() { yield ""; },
    };

    const result = await createReasoning({ model: createModel({ provider }), intents: ["query", "help"] as const }).classify({ query: "show available information" });

    expect(result.value).toBe("query");
    expect(systemPrompt).toContain('"query"');
    expect(systemPrompt).toContain('"help"');
    expect(systemPrompt).toContain("Do not invent");
  });
});
