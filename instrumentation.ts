// Runs once when the Next.js server starts (Module 5): starts sending every
// AI call to Langfuse. Without the Langfuse keys it does nothing.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTracing } = await import("@/lib/ai/langfuse");
    startTracing();
  }
}
