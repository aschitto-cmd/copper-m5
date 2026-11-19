// @vitest-environment node
// Module 5: what one chat turn looks like in Langfuse. The spans are caught in
// memory instead of sent to Langfuse: one "ask-copper" trace, an agent span
// for each agent (Copper, then the Refund agent after the handoff), and inside
// them each model step with its tokens and cost, and each tool call. Mock
// model, so no AI or Langfuse key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { CostSpans } from "@/lib/ai/langfuse";
import { finalValue } from "@/lib/ai/live";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 500,
      noCache: 500,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
});
const calls = (toolName: string, input: unknown): StreamPart[] => [
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

describe("tracing a chat turn (Langfuse)", () => {
  it("nests each agent's model steps and tool calls under one trace", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new CostSpans(),
        // Langfuse's own processor, sending to memory instead of Langfuse.
        new LangfuseSpanProcessor({
          exporter,
          publicKey: "pk-lf-test",
          secretKey: "sk-lf-test",
          mediaUploadEnabled: false,
          shouldExportSpan: () => true,
        }),
      ],
    });
    provider.register();
    setLangfuseTracerProvider(provider);
    registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer("t") }));

    let step = 0;
    const steps = [
      calls("transfer_to_refund_agent", { reason: "refund order 1001" }),
      calls("request_refund", { orderId: "1001" }),
      says("Order 1001 is refunded."),
    ];
    model = new MockLanguageModelV4({
      modelId: "gemini-3.5-flash-lite",
      doStream: async () => ({
        stream: convertArrayToReadableStream(steps[step++] ?? says("")),
      }),
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    const { askCopper } = await import("@/lib/copper/assistant/ask");

    const progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order 1001" }],
          useTools: true,
          desk: { limitUsd: 50, refunds: [] },
        })
      ).progress,
    );
    expect(progress.reply).toBe("Order 1001 is refunded.");
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.filter((s) => s.name === name);
    const parentOf = (span: ReadableSpan) =>
      spans.find(
        (s) => s.spanContext().spanId === span.parentSpanContext?.spanId,
      );

    // One trace for the whole turn.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const [turn] = byName("ask-copper");
    expect(turn.attributes["langfuse.trace.name"]).toBe("ask-copper");

    // Both agents, as agent spans under the turn.
    const copper = byName("Copper")[0];
    const refund = byName("Refund agent")[0];
    for (const agent of [copper, refund]) {
      expect(agent.attributes["langfuse.observation.type"]).toBe("agent");
      expect(parentOf(agent)).toBe(turn);
    }

    // Each tool call sits inside the agent that made it.
    const ancestors = (span: ReadableSpan) => {
      const chain: ReadableSpan[] = [];
      for (let p = parentOf(span); p; p = parentOf(p)) chain.push(p);
      return chain;
    };
    const tool = (name: string) =>
      spans.find((s) => s.attributes["gen_ai.tool.name"] === name)!;
    expect(ancestors(tool("transfer_to_refund_agent"))).toContain(copper);
    expect(ancestors(tool("request_refund"))).toContain(refund);

    // Every model step has its tokens and a cost.
    const modelSteps = spans.filter(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(modelSteps).toHaveLength(3);
    for (const s of modelSteps) {
      expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(500);
      expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(50);
      expect(
        JSON.parse(s.attributes["langfuse.observation.cost_details"] as string)
          .total,
      ).toBeGreaterThan(0);
    }
    await provider.shutdown();
  });
});
