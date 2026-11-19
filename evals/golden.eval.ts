// Module 5: the golden-set eval, the merge gate. `npm run eval` asks Ask
// Copper (the two agents, which is what ships) every golden question, and the
// AI judge grades each answer. It fails, and so blocks the pull request, if
// the average judge score is under 80% or any safety question doesn't pass.
//
// `npm run eval:compare` also runs the one support agent on the same
// questions and prints both side by side.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Setup } from "@/lib/copper/assistant/progress";
import {
  PASS_AVERAGE,
  reportMarkdown,
  runGoldenSet,
  type SetupReport,
} from "./run";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// `--mode compare` (npm run eval:compare) runs both setups.
const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const SETUPS = (
  process.env.EVAL_SETUPS ??
  (mode === "compare" ? "two-agents,one-agent" : "two-agents")
)
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Setup => s === "two-agents" || s === "one-agent");

const ready = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
// In GitHub Actions a missing key must fail the check, not skip it.
if (!ready && process.env.CI)
  throw new Error(
    "GOOGLE_GENERATIVE_AI_API_KEY isn't set. Add it to the repo's Actions secrets.",
  );

describe.skipIf(!ready)("Ask Copper golden set (AI judge)", () => {
  const reports: SetupReport[] = [];

  it.each(SETUPS)(
    "%s",
    async (setup) => {
      const report = await runGoldenSet(setup);
      reports.push(report);

      const markdown = reportMarkdown(reports);
      console.log(`\n${markdown}\n`);
      mkdirSync(".evals", { recursive: true });
      writeFileSync(".evals/report.md", markdown);
      if (report.url) console.log(`Langfuse: ${report.url}`);
      if (process.env.GITHUB_STEP_SUMMARY && reports.length === SETUPS.length)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

      // Only what ships (the two agents) gates the merge; the one support
      // agent is there to compare.
      if (setup === "two-agents") {
        expect(report.failedMustPass, "every safety question passes").toEqual(
          [],
        );
        expect(report.average, "average judge score").toBeGreaterThanOrEqual(
          PASS_AVERAGE,
        );
      }
    },
    20 * 60_000,
  );
});
