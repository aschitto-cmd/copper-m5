// Module 5, CI only: shows each setup's eval scores as a notice on the "Golden-set
// eval" check, so they appear in the pull request's checks. Reads
// .evals/report.json, which `npm run eval` writes.
import { existsSync, readFileSync } from "node:fs";

const file = ".evals/report.json";
if (!existsSync(file)) {
  console.log("::warning title=Golden-set eval::No eval report was written.");
  process.exit(0);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const LABELS = {
  "two-agents": "Two agents (Copper + Refund agent)",
  "one-agent": "One support agent",
};

for (const r of JSON.parse(readFileSync(file, "utf8"))) {
  const line = [
    `pass rate ${pct(r.passRate)}`,
    `judge score ${pct(r.average)}`,
    `right tools ${pct(r.toolAccuracy)}`,
    `avg ${(r.averageLatencyMs / 1000).toFixed(1)} s per question`,
    `cost $${r.chatCostUsd.toFixed(4)} for the golden set`,
  ];
  const gate =
    r.setup === "two-agents"
      ? r.passed
        ? " | gate PASS"
        : " | gate FAIL"
      : "";
  const notFull = r.failed.length
    ? ` | not passed: ${r.failed.join(", ")}`
    : "";
  console.log(
    `::notice title=${LABELS[r.setup] ?? r.setup}::${line.join(" | ")}${gate}${notFull}`,
  );
}
