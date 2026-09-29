import type {
  StepOptions,
  SubagentDef,
  SubagentToolCall,
  ToolDef,
  WorkflowContext,
} from "@alexkroman1/aai";
import { subagent, tool } from "@alexkroman1/aai";
import {
  allowedSmsRecipient,
  ChannelDeliveryError,
  sendToChannel,
  TEXTBELT_MAX_MESSAGE_CHARS,
  textbeltChannel,
} from "@alexkroman1/aai/channels";
import {
  mapConcurrent,
  requireStepEnv,
  stepDelegate,
  stepEnv,
  stepNotifyClient,
  stepReport,
  stepSpeak,
} from "@alexkroman1/aai/step";
import {
  stepGenerateJsonOrFail,
  stepGenerateOrFail,
  throwStepError,
} from "@alexkroman1/aai/step-errors";
import { isRecord, plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { stripLinks } from "../sms.ts";
import { DELIVER_ATTEMPTS, NOTICE_SAMPLE_RATE } from "./remind.ts";
import {
  allSources,
  type Brief,
  briefText,
  citedSources,
  dedupe,
  findingsText,
  type Note,
  noteText,
  type Source,
} from "./research-notes.ts";
import {
  BRIEF_SYSTEM,
  GAPS_SYSTEM,
  PLAN_SYSTEM,
  RESEARCH_OUTPUT,
  RESEARCH_SYSTEM,
  reportSystem,
  SPOKEN_SUMMARY_SYSTEM,
} from "./research-prompts.ts";

// Deep research, the SDK's research-handoff-agent template (workflows/research.ts) cut to
// what a speaker needs. Minutes of work, so it can't happen in the conversation: the
// session hangs up FOLLOWUP_MS after the reply and a tool call has 30 s. deep_research
// starts this run and answers at once; the run says a summary on the speaker when it
// lands, and texts the report only when they asked for it.
//
//   writeBrief      1 step    the spoken request as something a researcher is held to
//   planAngles      1 step    the angles worth pursuing (the fan-out's width)
//   investigate     N steps   one SUBAGENT each: search, read, cite, report
//   findGaps        1 step    the supervisor's second look
//   investigateGap  M steps   the second wave, when there is one
//   writeReport     1 step    the text-message report, then the sentences to say
//   text, announce            delivery: the phone if asked, then the speaker
//
// Dropped from the template: its review window and channel filing. The text message,
// when they ask for one, is the filing.

/** Angles investigated at once. The far side of every one is a rate limit. */
const ANGLE_CONCURRENCY = 2;
/** Most angles a wave may carry, whatever the supervisor asks for. */
const MAX_ANGLES = 4;
/** An angle is a whole delegated research pass: the expensive thing to lose. */
const ANGLE_STEP = { maxAttempts: 5 } satisfies StepOptions;
/** Tool-calling steps one researcher may take before it must answer (SubagentDef.maxSteps). */
const RESEARCH_BUDGET = 6;
/**
 * The report body the model is asked for. One text is TEXTBELT_MAX_MESSAGE_CHARS (the
 * channel cuts past it), and the title and source URLs share it, so the body gets most
 * of it and withSources drops trailing sources rather than let a URL be cut in half.
 */
export const REPORT_BODY_CHARS = 650;
/** A retried text is a second text: few attempts, unlike the announcement's. */
export const TEXT_STEP = { maxAttempts: 3 } satisfies StepOptions;

export type ResearchInput = {
  topic: string;
  /** The speaker to announce it on (its ?client= id); absent from a browser tab. */
  clientId?: string | undefined;
  /** The number the session's client reported; absent means SMS_TO_PHONE. */
  phone?: string | undefined;
  /** They asked for the report by text. Never texted otherwise. */
  text?: boolean | undefined;
};

/**
 * The run, and if it fails, saying so on the speaker before the run is marked failed: a
 * job that was promised minutes ago must not just go quiet. The failure still fails the
 * run, so the page's Running panel shows it with its reason.
 */
export async function researchFlow(input: ResearchInput, ctx: WorkflowContext) {
  try {
    return await research(input, ctx);
  } catch (err) {
    const { runId } = ctx;
    const why = failureReason(err);
    if (input.clientId) {
      await ctx.step("announceFailure", () => announceFailure(runId, input, why), {
        maxAttempts: DELIVER_ATTEMPTS,
      });
    }
    throw err;
  }
}

async function research(input: ResearchInput, ctx: WorkflowContext) {
  const brief = await ctx.step("writeBrief", () => writeBrief(input.topic));
  const angles = await ctx.step("planAngles", () => planAngles(brief));
  // One step per angle, in an order a replay reproduces: mapConcurrent hands items out
  // from a monotonic cursor, so the Nth call issued is investigate#N however they settle.
  const first = await mapConcurrent(angles, ANGLE_CONCURRENCY, (angle) =>
    ctx.step("investigate", () => investigate(brief, angle), ANGLE_STEP),
  );
  const gaps = await ctx.step("findGaps", () => findGaps(brief, first));
  const second = await mapConcurrent(gaps, ANGLE_CONCURRENCY, (angle) =>
    ctx.step("investigateGap", () => investigate(brief, angle), ANGLE_STEP),
  );
  const notes = [...first, ...second];
  const written = await ctx.step("writeReport", () => writeReport(input.topic, brief, notes));

  const texted: Texted = input.text
    ? await ctx.step("text", () => textReport(input, written.report), TEXT_STEP)
    : { sent: false };
  const { runId } = ctx;
  if (input.clientId) {
    await ctx.step("announce", () => announce(runId, input, written.summary, texted), {
      maxAttempts: DELIVER_ATTEMPTS,
    });
  }
  return {
    topic: input.topic,
    summary: written.summary,
    sources: allSources(notes).length,
    texted,
    announced: Boolean(input.clientId),
  };
}

const StringList = z
  .array(z.unknown())
  .transform((values) =>
    values.filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  )
  .catch([]);
const BriefReply = z.object({ brief: z.string().trim().optional(), criteria: StringList });
const AnglesReply = z.object({ angles: StringList });

export async function writeBrief(topic: string): Promise<Brief> {
  await stepReport(`Working out what "${topic}" is really asking.`);
  const parsed = await stepGenerateJsonOrFail(`Research request, as they said it: ${topic}`, {
    system: BRIEF_SYSTEM,
    schema: BriefReply,
  });
  return { brief: parsed.brief || topic, criteria: parsed.criteria.slice(0, MAX_ANGLES) };
}

export async function planAngles(brief: Brief): Promise<string[]> {
  const parsed = await stepGenerateJsonOrFail(briefText(brief), {
    system: PLAN_SYSTEM,
    schema: AnglesReply,
  });
  const angles = parsed.angles.slice(0, MAX_ANGLES);
  if (angles.length === 0) return [brief.brief]; // the brief itself is always an angle
  await stepReport(`Researching ${angles.length} ${plural(angles.length, "angle")}.`);
  return angles;
}

/**
 * One researcher, built per angle because `cite` closes over the list it records into.
 * brave_search rather than the template's keyless web_search: this agent has the key,
 * and the answers it finds are what the speaker says.
 */
function researcher(cited: Source[]): SubagentDef {
  return subagent({
    name: "researcher",
    systemPrompt: RESEARCH_SYSTEM,
    expectedOutput: RESEARCH_OUTPUT,
    builtinTools: ["brave_search", "visit_webpage"],
    tools: { cite: cite(cited) },
    maxSteps: RESEARCH_BUDGET,
  });
}

/** A subagent answers with text, so the sources it used come back through a tool. */
function cite(cited: Source[]): ToolDef {
  return tool({
    description:
      "Record a source you actually read and relied on. Call it as you go, once " +
      "per source, not at the end, and not for a result you only saw in a list.",
    inputSchema: z.object({
      title: z.string().max(200).describe("The page's title, as it calls itself"),
      url: z.url().describe("The page's URL"),
    }),
    execute: ({ title, url }) => {
      cited.push({ title, url });
      return "Recorded.";
    },
  });
}

export async function investigate(brief: Brief, angle: string): Promise<Note> {
  await stepReport(`Looking into: ${angle}`);
  const cited: Source[] = [];
  // The researcher has not heard the request and cannot see its siblings: the brief
  // rides in `context`.
  const result = await stepDelegate(researcher(cited), { task: angle, context: briefText(brief) });
  // What it SAID it used, falling back to what it opened: a researcher that forgot to
  // cite has still read pages, and a note with findings but no sources is the worse miss.
  return {
    angle,
    findings: result.text,
    sources: cited.length > 0 ? dedupe(cited) : dedupe(opened(result.toolCalls)),
  };
}

function opened(toolCalls: readonly SubagentToolCall[]): Source[] {
  return toolCalls.flatMap((call) => {
    if (call.name !== "visit_webpage") return [];
    const input = call.input;
    const url = typeof input === "string" ? input : isRecord(input) ? input.url : undefined;
    return typeof url === "string" && url ? [{ title: url, url }] : [];
  });
}

/** Bounded to one extra wave by construction: this is called once. */
export async function findGaps(brief: Brief, notes: readonly Note[]): Promise<string[]> {
  if (notes.length === 0) return [];
  const parsed = await stepGenerateJsonOrFail(
    `${briefText(brief)}\n\nWhat came back:\n${notes.map(noteText).join("\n\n")}`,
    { system: GAPS_SYSTEM, schema: AnglesReply },
  );
  return parsed.angles.slice(0, MAX_ANGLES - 1);
}

/**
 * The text-message report and the spoken summary, in one step: the summary is a
 * reduction OF the report, and journaled apart a resume could pair a new one with an
 * old report.
 */
export async function writeReport(
  topic: string,
  brief: Brief,
  notes: readonly Note[],
): Promise<{ report: string; summary: string }> {
  await stepReport(`Writing up ${notes.length} ${plural(notes.length, "angle")}.`);
  const sources = allSources(notes);
  const body = await stepGenerateOrFail(`${briefText(brief)}\n\n${findingsText(notes, sources)}`, {
    system: reportSystem(REPORT_BODY_CHARS),
  });
  const summary = await stepGenerateOrFail(`Topic: ${topic}\n\nReport:\n${body}`, {
    system: SPOKEN_SUMMARY_SYSTEM,
  });
  return { report: withSources(topic, body, sources), summary };
}

/**
 * Title, the report, and the sources it cites, within one text. The URLs are ours, never
 * retyped by a model; the ones that don't fit are dropped whole, last first.
 */
export function withSources(
  topic: string,
  body: string,
  sources: readonly Source[],
  max = TEXTBELT_MAX_MESSAGE_CHARS,
): string {
  const text = `Research: ${topic}\n\n${body.trim()}`;
  const cited = citedSources(body, sources);
  while (cited.length > 0) {
    const full = `${text}\n\nSources:\n${cited.join("\n")}`;
    if (full.length <= max) return full;
    cited.pop();
  }
  return text;
}

/**
 * How the report went by text. Not sent is not a failed run: the summary is written and
 * the speaker still says it, with the reason the text didn't go.
 */
export type Texted = { sent: true } | { sent: false; why?: string };

/**
 * Not sent when there is no number to text; the speaker still says the summary.
 *
 * The client's number is only a CLAIM: the server listens on the LAN for the speaker,
 * so anyone who can open a session could name any number. It is used only when it is
 * the owner's (SMS_TO_PHONE) or listed in SMS_ALLOWED_PHONES; anything else falls back
 * to the owner. The same rule text_me applies.
 */
export async function textReport(
  input: Pick<ResearchInput, "phone">,
  report: string,
): Promise<Texted> {
  const to = allowedSmsRecipient(input.phone, {
    SMS_TO_PHONE: stepEnv("SMS_TO_PHONE"),
    SMS_ALLOWED_PHONES: stepEnv("SMS_ALLOWED_PHONES"),
  });
  if (!to) return { sent: false };
  const channel = textbeltChannel({ key: requireStepEnv("TEXTBELT_KEY"), to });
  // Links out (sms.ts): Textbelt refuses a text with one until the key is verified.
  return await sendToChannel(channel, { text: stripLinks(report) }).then(
    (): Texted => ({ sent: true }),
    (err: unknown): Texted => {
      // A refusal that will refuse again (a bad number, an unverified key) is an answer;
      // a transient failure is thrown for the step to retry.
      if (err instanceof ChannelDeliveryError && !err.retryable) {
        return { sent: false, why: failureReason(err) };
      }
      return throwStepError(err);
    },
  );
}

/** Longest reason said or shown for a failure. */
const MAX_REASON_CHARS = 160;

/**
 * A failure as a short reason a person can hear: its first sentence, with anything that
 * looks like a credential in a URL taken out (a provider's refusal can quote the key).
 */
export function failureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const first = message.split(/(?<=[.!?])\s/)[0] ?? message;
  return stripLinks(first.replace(/([?&](?:key|token|secret|sig)=)[^&\s]+/gi, "$1[redacted]"))
    .slice(0, MAX_REASON_CHARS)
    .trim();
}

/** Say on the speaker that the research did not finish, and why. */
export async function announceFailure(
  id: string,
  input: ResearchInput,
  why: string,
): Promise<void> {
  if (!input.clientId) return;
  const said = `Sorry, the research on ${input.topic} didn't finish. ${why}`;
  const spoken = await stepSpeak(said, { sampleRate: NOTICE_SAMPLE_RATE });
  await stepNotifyClient(input.clientId, {
    id: `${id}:failed`,
    event: "research",
    data: { topic: input.topic, said, failed: true },
    audio: spoken.pcm,
  });
}

/**
 * Speak and push in ONE step, as reminders do (workflows/remind.ts): a retry speaks again
 * rather than the audio crossing the journal, and the run id as the notice id makes a
 * redelivery after a lost ack a repeat the device drops.
 */
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
  const said = `Your research on ${input.topic} is ready. ${summary}${delivery}`;
  const spoken = await stepSpeak(said, { sampleRate: NOTICE_SAMPLE_RATE });
  await stepNotifyClient(input.clientId, {
    id,
    event: "research",
    data: { topic: input.topic, said },
    audio: spoken.pcm,
  });
}
