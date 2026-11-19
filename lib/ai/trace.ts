// Module 5: named spans in the Langfuse trace (a chat turn, each agent). The
// Langfuse code is loaded only when the Langfuse keys are set, so without them
// (and in the tests) nothing extra loads and nothing is traced.

type Update = (attributes: {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
}) => void;

function langfuseKeysSet() {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/**
 * Runs `fn` inside a Langfuse observation: an "agent" span for each agent, or
 * a plain span. Model calls and tool calls made inside nest under it.
 */
export async function traced<T>(
  name: string,
  type: "agent" | "span",
  fn: (update: Update) => Promise<T>,
): Promise<T> {
  if (!langfuseKeysSet()) return fn(() => {});
  const { startActiveObservation } = await import("@langfuse/tracing");
  return startActiveObservation(
    name,
    (observation) => fn((a) => observation.update(a)),
    { asType: type as "agent" },
  );
}

/**
 * Starts a whole trace (one chat turn): its name, tags and metadata apply to
 * every span inside.
 */
export async function trace<T>(
  attributes: {
    traceName: string;
    tags?: string[];
    metadata?: Record<string, string>;
  },
  fn: (update: Update) => Promise<T>,
): Promise<T> {
  if (!langfuseKeysSet()) return fn(() => {});
  const { propagateAttributes } = await import("@langfuse/tracing");
  return propagateAttributes(attributes, () =>
    traced(attributes.traceName, "span", fn),
  );
}
