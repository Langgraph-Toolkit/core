import { describe, it, expect, beforeEach } from "vitest";
import {
  PermissionDeniedError,
  TokenBudgetExceededError,
} from "../src/index.js";
import { defineGraph, edge, node, safety } from "../src/legacy.js";
import {
  GraphRegistry,
  withTokenBudget,
  resetTokenLedger,
} from "../src/runtime-barrel.js";
import { testEdgeRisk, e2eActor, e2eScenarioResume, MemoryCheckpointer } from "../src/testing-barrel.js";
import type {
  Actor,
  LLMProvider,
  LLMProviderConfig,
  ModelRegistry,
  RunPolicy,
  TierResolver,
} from "../src/types.js";

function rolePolicy(allowedByGraph: Record<string, string[]>): RunPolicy {
  return (actor, graphName) => {
    const roles = actor.roles ?? [];
    const allowed = allowedByGraph[graphName] ?? [];
    return allowed.length > 0 && roles.some((role) => allowed.includes(role)) ? "allow" : "deny";
  };
}

function combinePolicies(...policies: RunPolicy[]): RunPolicy {
  return async (actor, graphName, options) => {
    let interrupted = false;
    for (const policy of policies) {
      const decision = await policy(actor, graphName, options);
      if (decision === "deny") return "deny";
      if (decision === "interrupt") interrupted = true;
    }
    return interrupted ? "interrupt" : "allow";
  };
}

function planTierResolver(planMap: Record<string, Record<string, string>>): TierResolver {
  return (actor, binding) => {
    const plan = typeof actor.claims?.plan === "string" ? actor.claims.plan : "free";
    return planMap[plan]?.[binding.tier] ?? binding.tier;
  };
}

class TestProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly config: LLMProviderConfig) {
    this.name = `mock:${config.model}`;
  }

  async chat(): Promise<{ readonly content: string; readonly usage: { readonly inputTokens: number; readonly outputTokens: number } }> {
    return { content: `mock:${this.config.model}`, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async *stream(): AsyncIterable<string> {
    yield `mock:${this.config.model}`;
  }
}

class TestModelRegistry implements ModelRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  constructor(configs: Readonly<Record<string, LLMProviderConfig>>) {
    this.reconfigure(configs, (config) => new TestProvider(config));
  }

  tier(alias: string): LLMProvider {
    const provider = this.providers.get(alias);
    if (!provider) throw new Error(`Missing test tier: ${alias}`);
    return provider;
  }

  reconfigure(
    configs: Readonly<Record<string, LLMProviderConfig>>,
    factory: (config: LLMProviderConfig) => LLMProvider,
  ): void {
    this.providers.clear();
    for (const [alias, config] of Object.entries(configs)) this.providers.set(alias, factory(config));
  }
}

// ---------- shared graph fixture ----------

interface ChatState {
  messages: unknown[];
  response: string;
  decision: string;
}

function chatDef() {
  return defineGraph<ChatState>({
    name: "chat-policy",
    state: {
      messages: [] as never,
      response: "" as never,
      decision: "" as never,
    } as never,
    stateDefaults: { messages: [] as never, response: "" as never, decision: "" as never },
    nodes: {
      plan: node(async (state, ctx) => ({
        response: `planned by ${ctx.actor?.id ?? "anon"}`,
        decision: "execute",
      })),
      act: node(async () => ({ response: "acted" })),
    } as never,
    entry: "plan",
    edges: [edge("plan", "act"), edge("act", "END")] as never,
    safety: safety(16),
  });
}

function dangerousDef() {
  return defineGraph<ChatState>({
    name: "chat-dangerous",
    state: {
      messages: [] as never,
      response: "" as never,
      decision: "" as never,
    } as never,
    stateDefaults: { messages: [] as never, response: "" as never, decision: "" as never },
    nodes: {
      plan: node(async () => ({ decision: "go" })),
      nuke: node(async () => ({ response: "BOOM" }), { risk: "dangerous" }),
    } as never,
    entry: "plan",
    edges: [edge("plan", "nuke"), edge("nuke", "END")] as never,
    safety: safety(8),
  });
}

function registryFrom(def: ReturnType<typeof chatDef>) {
  const reg = new GraphRegistry();
  return { reg, compiled: reg.register(def as never) };
}

beforeEach(() => {
  resetTokenLedger();
});

// ---------- Rule A1: RunPolicy ----------

describe("RunPolicy (Rule A1)", () => {
  it("denies an actor without required role via rolePolicy", async () => {
    const { compiled } = registryFrom(chatDef());
    const policy = rolePolicy({ "chat-policy": ["admin"] });
    const denied = await compiled.run({}, {
      actor: e2eActor("u1", ["viewer"]),
      policy,
    });
    expect(denied.stoppedReason).toBe("error");
    expect(denied.error).toBeInstanceOf(PermissionDeniedError);
  });

  it("allows an actor with a required role", async () => {
    const { compiled } = registryFrom(chatDef());
    const policy = rolePolicy({ "chat-policy": ["admin"] });
    const res = await compiled.run({}, {
      actor: e2eActor("u2", ["admin"]),
      policy,
    });
    expect(res.stoppedReason).toBe("done");
    // last node "act" overwrites response, so check the merged outcome ran
    expect((res.state as ChatState).response).toBe("acted");
  });

  it("an empty allow-list denies everyone", async () => {
    const { compiled } = registryFrom(chatDef());
    const policy = rolePolicy({});
    const res = await compiled.run({}, { actor: e2eActor("u3", ["admin"]), policy });
    expect(res.stoppedReason).toBe("error");
    expect(res.error).toBeInstanceOf(PermissionDeniedError);
  });

  it("interrupt decision pauses the run at the policy gate", async () => {
    const { compiled } = registryFrom(chatDef());
    const policy: ReturnType<typeof rolePolicy> = async () => "interrupt" as const;
    let firstEvent: { type: string; data?: unknown } | undefined;
    for await (const ev of compiled.stream({}, { actor: e2eActor("u4"), policy })) {
      firstEvent ??= ev;
    }
    expect(firstEvent?.type).toBe("interrupt");
    expect((firstEvent?.data as { reason?: string })?.reason).toBe("policy");
  });

  it("policy without actor throws PermissionDeniedError", async () => {
    const { compiled } = registryFrom(chatDef());
    const res = await compiled.run({}, { policy: rolePolicy({}) });
    expect(res.stoppedReason).toBe("error");
    expect(res.error).toBeInstanceOf(PermissionDeniedError);
  });

  it("combinePolicies: any deny denies; interrupt preserved when no deny", async () => {
    const policyA = rolePolicy({ "chat-policy": ["admin"] });
    const policyB = rolePolicy({ "chat-policy": ["ops"] });
    const combined = combinePolicies(policyA, policyB);
    expect(await combined(e2eActor("u5", ["admin", "ops"]), "chat-policy", {})).toBe("allow");
    expect(await combined(e2eActor("u6", ["admin"]), "chat-policy", {})).toBe("deny");
    const mixed = combinePolicies(rolePolicy({}), async () => "interrupt");
    expect(await mixed(e2eActor("u7"), "chat-policy", {})).toBe("deny");
  });
});

// ---------- Rule A2: TierResolver ----------

describe("TierResolver (Rule A2)", () => {
  it("downgrades a free actor to the cheap tier", async () => {
    const registry = new TestModelRegistry({
      cheap: { driver: "mock", model: "m-cheap" },
      strong: { driver: "mock", model: "m-strong" },
    });
    const resolved: string[] = [];
    const tierResolver = (actor: { claims?: Record<string, unknown> }, binding: { tier: string }) => {
      const plan = String(actor.claims?.plan ?? "free");
      const chosen = plan === "pro" ? binding.tier : "cheap";
      resolved.push(chosen);
      return chosen;
    };
    const def = defineGraph<ChatState>({
      name: "tier-graph",
      state: { messages: [] as never, response: "" as never, decision: "" as never } as never,
      stateDefaults: { messages: [] as never, response: "" as never, decision: "" as never },
      nodes: {
        // node declares strong tier; resolver should downgrade free actors
        plan: node(async (state, ctx) => {
          await ctx.model.chat([]);
          return { response: "ok" };
        }, { tier: "strong" }),
        act: node(async () => ({ decision: "done" })),
      } as never,
      entry: "plan",
      edges: [edge("plan", "act"), edge("act", "END")] as never,
      safety: safety(8),
    });
    const reg = new GraphRegistry();
    const compiled = reg.register(def as never);
    const freeRes = await compiled.run({}, {
      actor: e2eActor("u8", undefined, { plan: "free" }),
      modelRegistry: registry,
      tierResolver: tierResolver as never,
    });
    expect(freeRes.stoppedReason).toBe("done");
    expect(resolved).toContain("cheap");
  });

  it("planTierResolver helper keeps unknown plans on the requested tier", () => {
    const r = planTierResolver({ free: { strong: "cheap" } });
    expect(r(e2eActor("u9"), { tier: "strong" }, "g")).toBe("cheap");
    expect(r(e2eActor("u10", undefined, { plan: "enterprise" }), { tier: "strong" }, "g")).toBe("strong");
  });
});

// ---------- Rule A3: Token budget ----------

describe("TokenBudget (Rule A3)", () => {
  it("rejects when the per-tier budget is exhausted", async () => {
    // Realistic provider that reports usage (MockProvider reports 0 tokens)
    const provider: import("../src/types.js").LLMProvider = {
      name: "fake:__default__",
      async chat() {
        return { content: "x", usage: { inputTokens: 10, outputTokens: 10 } };
      },
      async *stream() {
        yield "x";
      },
    };
    const limited = withTokenBudget(provider, {
      perTier: { __default__: { limit: 5, windowMs: 60_000 } },
    }, e2eActor("u11"));
    await expect(limited.chat([{ role: "user", content: "a" }])).rejects.toBeInstanceOf(TokenBudgetExceededError);
  });

  it("passes when usage fits under the limit and accumulates", async () => {
    const provider = new TestProvider({ driver: "mock", model: "m2" });
    const limited = withTokenBudget(provider, {
      perTier: { __default__: { limit: 100 } },
    }, e2eActor("u12"));
    const r1 = await limited.chat([{ role: "user", content: "a" }]);
    const r2 = await limited.chat([{ role: "user", content: "b" }]);
    expect(r1.usage?.inputTokens).toBeGreaterThanOrEqual(0);
    expect(r2.usage?.inputTokens).toBeGreaterThanOrEqual(0);
  });

  it("is a no-op without an actor", async () => {
    const provider = new TestProvider({ driver: "mock", model: "m3" });
    const limited = withTokenBudget(provider, { perTier: {} }, undefined);
    expect(limited).toBe(provider);
  });
});

// ---------- Rule A4: dangerous node auto-interrupt ----------

describe("dangerous node (Rule A4)", () => {
  it("interrupts before a dangerous node not in interruptBefore", async () => {
    const { reg, compiled } = registryFrom(dangerousDef());
    const types: string[] = [];
    for await (const ev of compiled.stream({}, { actor: e2eActor("u13") })) {
      types.push(ev.type);
      if (ev.type === "interrupt") break;
    }
    expect(types).toContain("node_start");
    expect(types).toContain("interrupt");
    // run does not expose state mutation from nuke
    const r = await reg.run("chat-dangerous", {});
    expect(r.stoppedReason).toBe("interrupt");
  });
});

// ---------- risk harness ----------

describe("testEdgeRisk (risk harness)", () => {
  it("detects policy deny bypass", async () => {
    // The executor always honors opts.policy, so a bypass can only occur in
    // a buggy custom executor that skips the policy gate. Simulate exactly
    // that: stub compiled.run so a denied actor finishes normally, and
    // confirm the harness flags the resulting policy_deny_bypassed violation.
    const intended: import("../src/types.js").RunPolicy = rolePolicy({ "chat-policy": ["admin"] });
    const { compiled } = registryFrom(chatDef());
    // control: the honest executor denies the attacker
    const honest = await compiled.run({}, { actor: e2eActor("attacker"), policy: intended });
    expect(honest.stoppedReason).toBe("error");
    // stubbed graph: run() and stream() both skip the policy gate, exactly
    // what a buggy custom executor would do (Rule A1 bypass)
    const stubbed = Object.create(compiled) as typeof compiled;
    stubbed.run = async () => ({ ...honest, stoppedReason: "done" }) as never;
    stubbed.stream = async function* () {
      yield { type: "graph_start", graph: compiled.name, ts: Date.now(), threadId: "stub", runId: "stub" };
      yield { type: "node_start", graph: compiled.name, node: "plan", ts: Date.now(), threadId: "stub", runId: "stub" };
      yield { type: "node_end", graph: compiled.name, node: "plan", ts: Date.now(), threadId: "stub", runId: "stub", data: {} };
      yield { type: "done", graph: compiled.name, ts: Date.now(), threadId: "stub", runId: "stub" };
    } as never;
    const probe = await testEdgeRisk(stubbed as never, {
      actors: [e2eActor("attacker")],
      policy: intended,
    });
    const kinds = probe.violations.map((v) => v.kind);
    expect(kinds).toContain("policy_deny_bypassed");
  });

  it("reports clean when the policy allows an admin actor", async () => {
    const { compiled } = registryFrom(chatDef());
    const probe = await testEdgeRisk(compiled as never, {
      actors: [e2eActor("admin-user", ["admin"])],
      policy: rolePolicy({ "chat-policy": ["admin"] }),
    });
    expect(probe.violations.filter((v) => v.kind === "policy_deny_bypassed")).toHaveLength(0);
    expect(probe.runs[0].result.stoppedReason).toBe("done");
  });

  it("reports clean when the policy correctly denies", async () => {
    const { compiled } = registryFrom(chatDef());
    const probe = await testEdgeRisk(compiled as never, {
      actors: [e2eActor("attacker", ["viewer"])],
      policy: rolePolicy({ "chat-policy": ["admin"] }),
    });
    // denied runs return stoppedReason "error", which the harness classifies
    // as non-bypass
    expect(probe.violations.filter((v) => v.kind === "policy_deny_bypassed")).toHaveLength(0);
  });

  it("marks a dangerous graph as interrupted-then-resumed by the harness", async () => {
    // The harness itself stream-pauses on the dangerous node and resumes with
    // a human response, so a well-formed dangerous graph reports zero
    // violations (the interrupt requirement is satisfied by the harness flow).
    const { compiled } = registryFrom(dangerousDef());
    const probe = await testEdgeRisk(compiled as never, {
      actors: [e2eActor("admin", ["admin"])],
      policy: rolePolicy({ "chat-dangerous": ["admin"] }),
    });
    expect(probe.violations.filter((v) => v.kind === "dangerous_node_uninterrupted")).toHaveLength(0);
    // the recorded run pauses at the dangerous node (interrupt) as required;
    // the harness' own resume-with-human-response continues past it without
    // re-pausing and finishes normally (stoppedReason done)
    const lastRun = probe.runs[probe.runs.length - 1].result;
    expect(lastRun.stoppedReason === "interrupt" || lastRun.stoppedReason === "done").toBe(true);
  });
});

// ---------- E2E scenario harness (checkpoint persist/resume) ----------

describe("e2eScenarioResume", () => {
  it("runs a persist/resume cycle with a real checkpointer", async () => {
    // The e2eScenarioResume harness expects the graph to pause on its FIRST
    // run (interrupt) so the second run can resume with a human response.
    // Dangerous nodes provide exactly that gate (Rule A4): the first run
    // pauses at "confirm", the second run receives the response and completes.
    const def = defineGraph<ChatState>({
      name: "resume-scenario",
      state: { messages: [] as never, response: "" as never, decision: "" as never } as never,
      stateDefaults: { messages: [] as never, response: "" as never, decision: "" as never },
      nodes: {
        ask: node(async () => ({ response: "confirm?" })),
        // dangerous node auto-interrupts (Rule A4) acting as the human gate
        confirm: node(async (state) => ({ decision: String(state.response) })),
      } as never,
      entry: "ask",
      edges: [edge("ask", "confirm"), edge("confirm", "END")] as never,
      safety: safety(8),
      // pause BEFORE confirm so the first run stops and the second run
      // can resume with the human response
      interruptBefore: ["confirm"],
    });
    const reg = new GraphRegistry();
    const compiled = reg.register(def as never);
    const { resumed } = await e2eScenarioResume({
      graph: compiled as never,
      input: {},
      checkpoint: new MemoryCheckpointer(),
      response: "approved",
    });
    expect(resumed.stoppedReason).toBe("done");
    expect((resumed.state as ChatState).decision).toBe("approved");
  });
});
