import { TEXTBELT_MAX_MESSAGE_CHARS } from "@alexkroman1/aai/channels";
import {
  citedSources,
  type DeepResearchSource,
  deepResearchWorkflow,
} from "@alexkroman1/aai/experimental";
import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS, stepSayOnClient } from "@alexkroman1/aai/step";
import { spokenErrorReason } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { BRIEF_SYSTEM, reportSystem, SPOKEN_SUMMARY_SYSTEM } from "./research-prompts.ts";
import { TEXT_STEP, type Texted, textOwner } from "./text.ts";

// Deep research: the SDK's deepResearchWorkflow (brief, plan, one researcher per angle,
// gaps, second wave, report), with a speaker's prompts and delivery. Minutes of work, so
// it can't happen in the conversation: the session hangs up FOLLOWUP_MS after the reply
// and a tool call has 30 s. deep_research starts this run and answers at once; the run
// says a summary on the speaker when it lands, and texts the report only when they asked
// for it. A failure is said on the speaker too, then still fails the run, so the page's
// Running panel shows it with its reason.
//
//   writeBrief … writeReport   the SDK's steps, under the SDK's names
//   text, announce             delivery: the phone if asked, then the speaker
//   announceFailure            when any of it throws

/**
 * The report body the model is asked for. One text is TEXTBELT_MAX_MESSAGE_CHARS (the
 * channel cuts past it), and the title and source URLs share it, so the body gets most
 * of it and withSources drops trailing sources rather than let a URL be cut in half.
 */
export const REPORT_BODY_CHARS = 650;

export const ResearchInputSchema = z.object({
  topic: z.string().describe("What to research, as they asked it"),
  clientId: z.string().optional().describe("The speaker to announce it on, if any"),
  phone: z.string().optional().describe("The number the client reported; else SMS_TO_PHONE"),
  text: z.boolean().optional().describe("Whether they asked for the report by text"),
});

export type ResearchInput = z.infer<typeof ResearchInputSchema>;

export const researchWorkflow = deepResearchWorkflow({
  description: "Research a topic in depth, say it on the speaker, and text it if asked",
  input: ResearchInputSchema,
  // brave_search rather than the keyless web_search: this agent has the key, and the
  // answers it finds are what the speaker says. The budget is the SDK's default.
  researcher: { builtinTools: ["brave_search", "visit_webpage"] },
  prompts: {
    brief: BRIEF_SYSTEM,
    report: reportSystem(REPORT_BODY_CHARS),
    summary: SPOKEN_SUMMARY_SYSTEM,
  },
  deliver: async (result, input, ctx) => {
    const report = withSources(input.topic, result.report, result.sources);
    const texted: Texted = input.text
      ? await ctx.step("text", () => textOwner(input.phone, report), TEXT_STEP)
      : { sent: false };
    const { runId } = ctx;
    if (input.clientId) {
      await ctx.step("announce", () => announce(runId, input, result.summary, texted), {
        maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
      });
    }
    return {
      topic: input.topic,
      summary: result.summary,
      sources: result.sources.length,
      texted,
      announced: Boolean(input.clientId),
    };
  },
  // A job that was promised minutes ago must not just go quiet.
  onFailure: async (err, input, ctx) => {
    if (!input.clientId) return;
    const { runId } = ctx;
    const why = spokenErrorReason(err);
    await ctx.step("announceFailure", () => announceFailure(runId, input, why), {
      maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
    });
  },
});

/**
 * Title, the report, and the sources it cites, within one text. The URLs are ours, never
 * retyped by a model; the ones that don't fit are dropped whole, last first.
 */
export function withSources(
  topic: string,
  body: string,
  sources: readonly DeepResearchSource[],
  max = TEXTBELT_MAX_MESSAGE_CHARS,
): string {
  const text = `Research: ${topic}\n\n${body.trim()}`;
  const cited = citedSources(body, sources).map((one) => `[${one.number}] ${one.url}`);
  while (cited.length > 0) {
    const full = `${text}\n\nSources:\n${cited.join("\n")}`;
    if (full.length <= max) return full;
    cited.pop();
  }
  return text;
}

/** Say on the speaker that the research did not finish, and why. */
export async function announceFailure(
  id: string,
  input: ResearchInput,
  why: string,
): Promise<void> {
  if (!input.clientId) return;
  await stepSayOnClient(input.clientId, {
    id: `${id}:failed`,
    event: "research",
    text: `Sorry, the research on ${input.topic} didn't finish. ${why}`,
    data: { topic: input.topic, failed: true },
  });
}

/** The run id as the notice id makes a redelivery after a lost ack a repeat. */
export async function announce(
  id: string,
  input: ResearchInput,
  summary: string,
  texted: Texted,
): Promise<void> {
  if (!input.clientId) return;
  const delivery = texted.sent
    ? " I've texted you the full report."
    : texted.why
      ? ` I couldn't text you the full report: ${texted.why}`
      : "";
  await stepSayOnClient(input.clientId, {
    id,
    event: "research",
    text: `Your research on ${input.topic} is ready. ${summary}${delivery}`,
    data: { topic: input.topic },
  });
}
