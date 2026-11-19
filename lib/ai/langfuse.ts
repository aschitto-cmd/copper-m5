// Module 5: observability. Every AI call is traced in Langfuse: which agent
// answered, each model step, each tool call (what went in and came out), the
// tokens, the cost and how long it took.
//
// How it works: the AI SDK reports each call as OpenTelemetry "spans"
// (@ai-sdk/otel). LangfuseSpanProcessor sends them to Langfuse. CostSpans adds
// the cost of each model step, worked out from lib/ai/pricing.ts, so Langfuse
// shows the same cost as the [ai_calls] log line.
//
// Started once, when the server starts (instrumentation.ts) or when the evals
// start (evals/setup.ts). Without the Langfuse keys it does nothing, and the
// app works the same.
import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { MODELS } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";

export function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** "ci" in GitHub Actions, "production" or "preview" on Vercel, else "development". */
export function tracingEnvironment(): string {
  if (process.env.CI) return "ci";
  return process.env.VERCEL_ENV ?? "development";
}

/** Google's model name (as the spans report it) to the app's model id. */
function modelIdFor(name: unknown) {
  if (typeof name !== "string") return undefined;
  return MODELS.find(
    (m) =>
      m.googleId === name || m.id === name || `models/${m.googleId}` === name,
  )?.id;
}

/**
 * Adds the cost to each model step ("chat" span) just before it ends, from the
 * app's own price list. Only the steps get a cost, so Langfuse adds each
 * step up once.
 */
export class CostSpans implements SpanProcessor {
  onStart(): void {}
  onEnding(span: Span): void {
    const a = span.attributes;
    if (a["gen_ai.operation.name"] !== "chat") return;
    const model = modelIdFor(
      a["gen_ai.response.model"] ?? a["gen_ai.request.model"],
    );
    const input = a["gen_ai.usage.input_tokens"];
    const output = a["gen_ai.usage.output_tokens"];
    if (!model || typeof input !== "number" || typeof output !== "number")
      return;
    const inputUsd = costUsd(model, input, 0);
    const outputUsd = costUsd(model, 0, output);
    span.setAttribute(
      "langfuse.observation.cost_details",
      JSON.stringify({
        input: inputUsd,
        output: outputUsd,
        total: inputUsd + outputUsd,
      }),
    );
  }
  onEnd(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

let provider: NodeTracerProvider | undefined;

/** Starts sending traces to Langfuse. Safe to call more than once. */
export function startTracing(): boolean {
  if (provider) return true;
  if (!isLangfuseConfigured()) return false;
  provider = new NodeTracerProvider({
    spanProcessors: [
      new CostSpans(),
      new LangfuseSpanProcessor({ environment: tracingEnvironment() }),
    ],
  });
  // register() also keeps track of the current trace across awaits, so tool
  // calls and agents nest under the chat turn that made them.
  provider.register();
  setLangfuseTracerProvider(provider);
  registerTelemetry(
    new OpenTelemetry({ tracer: provider.getTracer("ask-copper") }),
  );
  return true;
}

/** Sends any traces still waiting. Call before a script or test run exits. */
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush();
}
