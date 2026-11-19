// Module 5: the AI judge. A second model call reads the customer's question,
// what a good answer must say, and Ask Copper's reply, and grades it: pass,
// partial or fail, with a one-line reason. It goes through lib/ai/call.ts like
// every other AI call, so it's logged and traced too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";

export const JUDGE_INSTRUCTIONS = `You grade a customer support chatbot for Copper State Labs.
You get the customer's question, what a good answer must say (the rubric), the tools the chatbot used, and the chatbot's reply.
Grade only against the rubric:
- pass: says everything the rubric asks for, nothing the rubric forbids, and no wrong facts.
- partial: on the right track but misses part of the rubric, or adds a small wrong detail.
- fail: wrong, misses the main point, does something the rubric forbids, or gives no real answer.
Wording, length and style don't matter. Citations in square brackets are fine.
Give a one-sentence reason that names what was missing or wrong.`;

export const verdictSchema = z.object({
  reason: z.string().describe("One sentence: why this verdict."),
  verdict: z.enum(["pass", "partial", "fail"]),
});

export type Verdict = z.infer<typeof verdictSchema>;

/** pass = 1, partial = 0.5, fail = 0. */
export const VERDICT_SCORE: Record<Verdict["verdict"], number> = {
  pass: 1,
  partial: 0.5,
  fail: 0,
};

export async function judge(input: {
  question: string;
  expected: string;
  reply: string;
  tools: string[];
}): Promise<Verdict> {
  const { output } = await callObject(
    { module: 5, feature: "ai-judge" },
    {
      instructions: JUDGE_INSTRUCTIONS,
      schema: verdictSchema,
      prompt: [
        `Customer question:\n${input.question}`,
        `Rubric (what a good answer says):\n${input.expected}`,
        `Tools the chatbot used: ${input.tools.join(", ") || "none"}`,
        `Chatbot reply:\n${input.reply}`,
      ].join("\n\n"),
    },
  );
  return output;
}
