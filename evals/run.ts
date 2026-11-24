// Module 5: runs the golden set on Ask Copper and grades every answer with the
// AI judge. With the Langfuse keys, the questions are a Langfuse dataset
// ("ask-copper-golden-set"), each run is a dataset run named after its setup,
// and every answer is a trace with its scores. Open the dataset in Langfuse to
// compare runs side by side: scores, cost and time per question.
// Without the keys it runs the same questions and prints the scores here.
import { LangfuseClient } from "@langfuse/client";
import { onAiCall } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import {
  flushTracing,
  isLangfuseConfigured,
  startTracing,
} from "@/lib/ai/langfuse";
import { askCopper } from "@/lib/copper/assistant/ask";
import {
  AGENT_NAMES,
  type Setup,
  toolCallsOf,
} from "@/lib/copper/assistant/progress";
import { DEFAULT_LIMIT_USD } from "@/lib/copper/orders";
import { GOLDEN_SET, type GoldenItem } from "./golden-set";
import { judge, VERDICT_SCORE, type Verdict } from "./judge";

export const DATASET_NAME = "ask-copper-golden-set";

/** The merge gate: the average judge score must reach this... */
export const PASS_AVERAGE = 0.8;
/** ...and every safety question (mustPass) must pass. */

export const SETUP_LABELS: Record<Setup, string> = {
  "two-agents": "Two agents (Copper + Refund agent)",
  "one-agent": "One support agent",
};

type Input = { question: string };
type Expected = { expected: string; tools: string[] };
type Output = {
  reply: string;
  tools: string[];
  agent: string;
  latencyMs: number;
};

export type ItemReport = {
  id: string;
  question: string;
  verdict: Verdict["verdict"];
  reason: string;
  rightTools: boolean;
  mustPass: boolean;
  latencyMs: number;
};

export type SetupReport = {
  setup: Setup;
  runName: string;
  url?: string;
  items: ItemReport[];
  /** Share of questions the judge passed outright. */
  passRate: number;
  /** Average judge score: pass 1, partial 0.5, fail 0. */
  average: number;
  toolAccuracy: number;
  /** What Ask Copper's own AI calls cost for the whole golden set (not the judge). */
  chatCostUsd: number;
  averageLatencyMs: number;
  failedMustPass: string[];
  passed: boolean;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A free Gemini key allows about 15 requests a minute. When a call hits that,
 * wait as long as Google asks (20 seconds if it doesn't say) and try again. A
 * daily limit isn't retried: it won't clear for hours.
 */
async function patiently<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || /per day/i.test(message)) throw error;
      const seconds = Number(/retry in ([\d.]+)s/i.exec(message)?.[1] ?? 20);
      console.warn(`[eval] waiting ${Math.ceil(seconds)} s for the rate limit`);
      await sleep((seconds + 1) * 1000);
    }
  }
}

/** Asks Ask Copper one golden question, the way the Support page does. */
async function ask(question: string, setup: Setup): Promise<Output> {
  let started = performance.now();
  const progress = await patiently(async () => {
    // Time only the last try, not the waiting.
    started = performance.now();
    const result = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: question }],
          useTools: true,
          desk: { limitUsd: DEFAULT_LIMIT_USD, refunds: [] },
          setup,
        })
      ).progress,
    );
    // The chat turns errors into "Sorry, something went wrong"; usually
    // that's the rate limit, so wait and ask again.
    if (result.status === "error")
      throw new Error("Ask Copper hit an error (usually the rate limit).");
    return result;
  });
  return {
    reply: progress.reply,
    tools: toolCallsOf(progress).map((t) => t.name),
    agent: AGENT_NAMES[progress.agent ?? "copper"],
    latencyMs: Math.round(performance.now() - started),
  };
}

function usedRightTools(output: Output, expected: Expected) {
  return expected.tools.every((tool) => output.tools.includes(tool));
}

/** Writes the golden set to the Langfuse dataset (same ids, so it updates). */
async function syncDataset(langfuse: LangfuseClient) {
  try {
    await langfuse.api.datasets.create({
      name: DATASET_NAME,
      description:
        "Module 5 golden set: customer questions for Ask Copper, each with what a good answer says. Source: evals/golden-set.ts.",
    });
  } catch {
    // Already there.
  }
  for (const item of GOLDEN_SET) {
    await langfuse.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: `${DATASET_NAME}-${item.id}`,
      input: { question: item.question } satisfies Input,
      expectedOutput: {
        expected: item.expected,
        tools: item.tools,
      } satisfies Expected,
      metadata: {
        goldenId: item.id,
        category: item.category,
        mustPass: Boolean(item.mustPass),
      },
    });
  }
  const dataset = await langfuse.dataset.get(DATASET_NAME);
  const ids = new Set(GOLDEN_SET.map((i) => `${DATASET_NAME}-${i.id}`));
  return dataset.items.filter((item) => ids.has(item.id));
}

function summarize(
  setup: Setup,
  runName: string,
  results: { item: GoldenItem; output: Output; verdict: Verdict }[],
  url: string | undefined,
  chatCostUsd: number,
): SetupReport {
  // A question with no graded answer (the chat or the judge failed) counts as
  // a fail, so an error can never sneak past the gate.
  const items: ItemReport[] = GOLDEN_SET.map((item) => {
    const done = results.find((r) => r.item.id === item.id);
    return {
      id: item.id,
      question: item.question,
      verdict: done?.verdict.verdict ?? "fail",
      reason: done?.verdict.reason ?? "No graded answer: the run hit an error.",
      rightTools: done ? usedRightTools(done.output, item) : false,
      mustPass: Boolean(item.mustPass),
      latencyMs: done?.output.latencyMs ?? 0,
    };
  });
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const average = mean(items.map((i) => VERDICT_SCORE[i.verdict]));
  const failedMustPass = items
    .filter((i) => i.mustPass && i.verdict !== "pass")
    .map((i) => i.id);
  return {
    setup,
    runName,
    url,
    items,
    passRate: mean(items.map((i) => (i.verdict === "pass" ? 1 : 0))),
    average,
    chatCostUsd,
    toolAccuracy: mean(items.map((i) => (i.rightTools ? 1 : 0))),
    averageLatencyMs: Math.round(mean(items.map((i) => i.latencyMs))),
    failedMustPass,
    passed: average >= PASS_AVERAGE && failedMustPass.length === 0,
  };
}

/** Runs the whole golden set on one setup and grades each answer. */
export async function runGoldenSet(setup: Setup): Promise<SetupReport> {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const where = process.env.GITHUB_SHA
    ? ` ${process.env.GITHUB_SHA.slice(0, 7)}`
    : "";
  const runName = `${SETUP_LABELS[setup]} · ${stamp}${where}`;
  const byQuestion = new Map(GOLDEN_SET.map((i) => [i.question, i]));
  const graded: { item: GoldenItem; output: Output; verdict: Verdict }[] = [];

  // Add up what the chat itself costs. The judge's calls aren't counted, so
  // both setups are compared on what customers' questions would cost.
  let chatCostUsd = 0;
  const stopListening = onAiCall((row) => {
    if (row.feature !== "ai-judge") chatCostUsd += row.cost_usd ?? 0;
  });
  try {
    return await runSetup();
  } finally {
    stopListening();
  }

  async function runSetup(): Promise<SetupReport> {
    const grade = async (question: string, output: Output) => {
      const item = byQuestion.get(question)!;
      const verdict = await patiently(() =>
        judge({
          question,
          expected: item.expected,
          reply: output.reply,
          tools: output.tools,
        }),
      );
      graded.push({ item, output, verdict });
      return [
        {
          name: "correctness",
          value: VERDICT_SCORE[verdict.verdict],
          comment: `${verdict.verdict}: ${verdict.reason}`,
        },
        {
          name: "right_tools",
          value: usedRightTools(output, item) ? 1 : 0,
          comment: `Used: ${output.tools.join(", ") || "none"}. Expected: ${item.tools.join(", ") || "any"}.`,
        },
      ];
    };

    if (!isLangfuseConfigured()) {
      // A question that errors counts as a fail (see summarize) and the run
      // goes on, the same as in a Langfuse experiment.
      for (const item of GOLDEN_SET) {
        try {
          await grade(item.question, await ask(item.question, setup));
        } catch (error) {
          console.warn(`[eval] ${item.id} failed:`, (error as Error).message);
        }
      }
      return summarize(setup, runName, graded, undefined, chatCostUsd);
    }

    startTracing();
    const langfuse = new LangfuseClient();
    const data = await syncDataset(langfuse);
    const result = await langfuse.experiment.run<Input, Expected>({
      name: "Ask Copper golden set",
      runName,
      description: `${SETUP_LABELS[setup]}, graded by the AI judge (evals/judge.ts).`,
      metadata: { setup, commit: process.env.GITHUB_SHA ?? "local" },
      data,
      // Two at a time keeps under the free Gemini key's requests per minute.
      maxConcurrency: 2,
      task: async ({ input }) => ask((input as Input).question, setup),
      evaluators: [
        async ({ input, output }) => grade((input as Input).question, output),
      ],
      runEvaluators: [
        async ({ itemResults }) => {
          const scores = itemResults.flatMap((r) =>
            r.evaluations.filter((e) => e.name === "correctness"),
          );
          const avg =
            scores.reduce((s, e) => s + Number(e.value), 0) /
            Math.max(scores.length, 1);
          return {
            name: "average_correctness",
            value: avg,
            comment: `Merge gate: ${PASS_AVERAGE} or higher, and every safety question passes.`,
          };
        },
      ],
    });
    await flushTracing();
    await langfuse.flush();
    return summarize(setup, runName, graded, result.experimentUrl, chatCostUsd);
  }
}

/** A Markdown table of one or more runs, for the terminal and GitHub. */
export function reportMarkdown(reports: SetupReport[]): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    "## Ask Copper golden set",
    "",
    "| Setup | Pass rate | Judge score | Right tools | Avg time | Cost (all questions) | Safety | Gate |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...reports.map(
      (r) =>
        `| ${r.url ? `[${SETUP_LABELS[r.setup]}](${r.url})` : SETUP_LABELS[r.setup]} | ${pct(r.passRate)} | ${pct(r.average)} | ${pct(r.toolAccuracy)} | ${(r.averageLatencyMs / 1000).toFixed(1)} s | $${r.chatCostUsd.toFixed(4)} |${r.failedMustPass.length ? `failed: ${r.failedMustPass.join(", ")}` : "all pass"} | ${r.passed ? "✅ pass" : "❌ fail"} |`,
    ),
    "",
    `Gate (two agents, what ships): judge score ${pct(PASS_AVERAGE)} or higher, and every safety question passes. Cost counts Ask Copper's own AI calls, not the judge's. Every run is in Langfuse: Datasets > ${DATASET_NAME} > Runs.`,
  ];
  const icon = { pass: "✅", partial: "🟡", fail: "❌" };
  for (const r of reports) {
    lines.push(
      "",
      `### ${SETUP_LABELS[r.setup]}`,
      "",
      "| Question | Verdict | Why |",
      "| --- | --- | --- |",
      ...r.items.map(
        (i) =>
          `| ${i.id}${i.mustPass ? " (safety)" : ""} | ${icon[i.verdict]} ${i.verdict} | ${i.reason.replace(/\|/g, "/")} |`,
      ),
    );
  }
  return lines.join("\n");
}
