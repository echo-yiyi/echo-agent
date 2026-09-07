// `ask_user`：模型菜单上的提问工具（2026-09-05）。工具本身不认识壳子——它只拿到一个 `ask` 口，
// 由 Agent 接到自己的 QuestionLedger 与 lifecycle 通道上（`agent.ts` 的 `askQuestion`）。
// 常驻工具（不延迟）：要问的时候模型得当场看得见它。

import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import type { QuestionAsk, QuestionOption, QuestionSettlement } from "./types.ts";

export const ASK_USER_NAME = "ask_user";
/** 选项上限：一屏摆得下、数字键直选得到。 */
const MAX_OPTIONS = 8;

export type AskUserDeps = {
  ask: (input: Omit<QuestionAsk, "questionId">, signal: AbortSignal | undefined) => Promise<QuestionSettlement>;
};

type Params = { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

export function makeAskUserTool(deps: AskUserDeps): ModelTool<Params> {
  return {
    kind: "model",
    name: ASK_USER_NAME,
    label: "问用户",
    description:
      "Ask the user a question when you need a decision you cannot make yourself (which approach, which of several " +
      "things they meant, whether to proceed with something irreversible). Give 2-8 short, concrete options when " +
      "there are natural choices; the user can also answer in free text. The run pauses until they answer, then " +
      "continues in the same turn. In a non-interactive run nobody can answer: the tool returns an error and you " +
      "must decide yourself or stop and state the question in your reply. Do not ask what you can find out from " +
      "the code or the conversation.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, one or two sentences" },
        options: {
          type: "array",
          description: "Up to 8 choices; omit for a free-text answer",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short choice text, distinct from the others" },
              description: { type: "string", description: "What choosing it means" },
            },
            required: ["label"],
          },
        },
        multiSelect: { type: "boolean", description: "Allow choosing several options (default false)" },
      },
      required: ["question"],
    },
    async execute({ question, options, multiSelect }, ctx) {
      const q = typeof question === "string" ? question.trim() : "";
      if (q === "") return toolError("question must be a non-empty string");
      const normalized = normalizeOptions(options);
      if (typeof normalized === "string") return toolError(normalized);
      const settlement = await deps.ask({ toolCallId: ctx.toolCallId, question: q, options: normalized, multiSelect: multiSelect === true }, ctx.signal);
      if (settlement.kind === "answered") {
        const chose = settlement.selected.length > 0 ? `User chose: ${settlement.selected.join(", ")}` : "";
        const said = settlement.text !== undefined ? `User said: ${settlement.text}` : "";
        return toolOk([chose, said].filter((s) => s !== "").join("\n"), { selected: settlement.selected, text: settlement.text });
      }
      switch (settlement.reason) {
        case "no-responder":
          return toolError(
            "Nobody can answer questions in this run (non-interactive): make a reasonable decision yourself, or stop and state the question in your reply.",
          );
        case "timed-out":
          return toolError("The user did not answer in time: decide yourself, or stop and state the question in your reply.");
        case "run-aborted":
          return toolError("The run was aborted before the user answered.");
        case "runtime-disposed":
          return toolError("The agent is shutting down; the question was not answered.");
      }
    },
  };
}

function normalizeOptions(raw: unknown): readonly QuestionOption[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "options must be an array of { label, description? }";
  if (raw.length > MAX_OPTIONS) return `options: at most ${MAX_OPTIONS} choices`;
  const out: QuestionOption[] = [];
  const seen = new Set<string>();
  for (const o of raw as { label?: unknown; description?: unknown }[]) {
    const label = typeof o?.label === "string" ? o.label.trim() : "";
    if (label === "") return "options: every choice needs a non-empty label";
    if (seen.has(label)) return `options: duplicate label '${label}'`;
    seen.add(label);
    const description = typeof o.description === "string" && o.description.trim() !== "" ? o.description.trim() : undefined;
    out.push(description === undefined ? { label } : { label, description });
  }
  return out;
}
