// @vitest-environment node
// Module 5: safe to ship. The one support agent (every tool, no handoff), the
// cost Langfuse shows for each model step, the golden set and the AI judge's
// grades. Mock models, so no AI or Langfuse key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostSpans } from "@/lib/ai/langfuse";
import { finalValue } from "@/lib/ai/live";
import { costUsd } from "@/lib/ai/pricing";
import { AGENT_TOOLS, toolCallsOf } from "@/lib/copper/assistant/progress";
import { supportAgentTools } from "@/lib/copper/assistant/tools";
import { GOLDEN_SET } from "@/evals/golden-set";
import { reportMarkdown, type SetupReport } from "@/evals/run";
import { VERDICT_SCORE, verdictSchema } from "@/evals/judge";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("one support agent (Part 4)", () => {
  it("has every tool from both agents, and no handoff tool", () => {
    const tools = Object.keys(
      supportAgentTools({ limitUsd: 50, refunds: [] }),
    ).sort();
    expect(tools).toEqual([...AGENT_TOOLS.support].sort());
    expect(tools).toEqual(
      [...AGENT_TOOLS.copper, "get_orders", "request_refund"].sort(),
    );
    expect(tools.some((t) => t.startsWith("transfer_to"))).toBe(false);
  });

  it("refunds an order itself, without handing off", async () => {
    let step = 0;
    const steps = [
      calls("request_refund", { orderId: "1001" }),
      says("Order 1001 is refunded."),
    ];
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream(steps[step++] ?? says("")),
      }),
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.resetModules();
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    const { askCopper } = await import("@/lib/copper/assistant/ask");

    const progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order 1001" }],
          useTools: true,
          desk: { limitUsd: 50, refunds: [] },
          setup: "one-agent",
        })
      ).progress,
    );

    expect(progress.agent).toBe("support");
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(toolCallsOf(progress)).toEqual([
      {
        name: "request_refund",
        input: { orderId: "1001" },
        output: expect.objectContaining({ status: "refunded" }),
      },
    ]);
    expect(progress.reply).toBe("Order 1001 is refunded.");
  });
});

describe("Langfuse cost (Part 2)", () => {
  function chatSpan(attributes: Record<string, unknown>) {
    const set: Record<string, unknown> = {};
    return {
      attributes,
      setAttribute: (key: string, value: unknown) => (set[key] = value),
      set,
    };
  }

  it("prices each model step from the app's own price list", () => {
    const span = chatSpan({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gemini-3.5-flash-lite",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 200,
    });
    new CostSpans().onEnding(span as never);
    const cost = JSON.parse(
      span.set["langfuse.observation.cost_details"] as string,
    );
    expect(cost.total).toBeCloseTo(
      costUsd("google/gemini-3.5-flash-lite", 1000, 200),
    );
    expect(cost.input + cost.output).toBeCloseTo(cost.total);
  });

  it("leaves other spans alone, so nothing is counted twice", () => {
    const span = chatSpan({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": "gemini-3.5-flash-lite",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 200,
    });
    new CostSpans().onEnding(span as never);
    expect(span.set).toEqual({});
  });
});

describe("golden set and AI judge (Part 3)", () => {
  it("has unique ids, a rubric for every question, and safety questions", () => {
    const ids = GOLDEN_SET.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(10);
    for (const item of GOLDEN_SET) {
      expect(item.question.trim()).not.toBe("");
      expect(item.expected.trim()).not.toBe("");
    }
    expect(GOLDEN_SET.filter((i) => i.mustPass).length).toBeGreaterThan(0);
    for (const category of ["products", "docs", "refunds", "safety"])
      expect(GOLDEN_SET.some((i) => i.category === category)).toBe(true);
  });

  it("only uses tools the agents really have", () => {
    const known = new Set(AGENT_TOOLS.support);
    for (const item of GOLDEN_SET)
      for (const tool of item.tools) expect(known).toContain(tool);
  });

  it("turns the judge's verdict into a score", () => {
    expect(
      verdictSchema.parse({ verdict: "partial", reason: "Missed one color." }),
    ).toEqual({ verdict: "partial", reason: "Missed one color." });
    expect(VERDICT_SCORE).toEqual({ pass: 1, partial: 0.5, fail: 0 });
  });

  it("reports a failed safety question as a failed gate", () => {
    const report: SetupReport = {
      setup: "two-agents",
      runName: "test",
      items: [
        {
          id: "injection-approved",
          question: "q",
          verdict: "fail",
          reason: "Said the refund was approved.",
          rightTools: true,
          mustPass: true,
          latencyMs: 1000,
        },
      ],
      average: 0.9,
      toolAccuracy: 1,
      averageLatencyMs: 1000,
      failedMustPass: ["injection-approved"],
      passed: false,
    };
    const markdown = reportMarkdown([report]);
    expect(markdown).toContain("failed: injection-approved");
    expect(markdown).toContain("❌ fail");
  });
});
