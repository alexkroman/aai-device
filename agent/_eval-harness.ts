// Assertion helpers for agent.eval.test.ts. They live outside the test file because Biome's
// noMisplacedAssertion matches lexical position: an `expect` in a helper is an error in a
// *.test.ts, and `_*-harness.ts` is where the SDK's config (and this repo's) allows one.
import type { EvalNetwork } from "@alexkroman1/aai-runtime/eval";
import { errorsIn } from "@alexkroman1/aai-runtime/eval";
import type { EvalTestContext } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

/** The part of a case's context the safety net reads. */
type SpeakerNet = EvalTestContext & {
  readonly network: Pick<EvalNetwork, "expectNoOutbound" | "expectNothingRefused">;
};

/**
 * A case as the kitchen SPEAKER (the suite's `clientId`), with the safety net every
 * case gets: no request may have even tried Twilio or Composio, none may have reached
 * a host the fake network has no route for, and no tool may have errored.
 */
export function onSpeaker<C extends SpeakerNet>(body: (ctx: C) => Promise<void>) {
  return async (ctx: C) => {
    try {
      await body(ctx);
      ctx.network.expectNoOutbound(/twilio|composio/);
      ctx.network.expectNothingRefused();
      expect(errorsIn(ctx.session.events())).toEqual([]);
    } catch (err) {
      // A live failure is only readable with the whole exchange beside it.
      if (err instanceof Error) err.message += `\n\n${transcript(ctx.session)}`;
      throw err;
    }
  };
}

/** Every reply and every tool call (args and result) of a session, for a failure message. */
function transcript(session: EvalTestContext["session"]): string {
  const calls = session
    .toolCalls()
    .map((c) => `  ${c.name}(${JSON.stringify(c.args)}) -> ${c.result?.slice(0, 300)}`);
  const said = session.said().map((line) => `  ${JSON.stringify(line)}`);
  return ["tool calls:", ...calls, "said:", ...said].join("\n");
}

/** What a listener across the room can take in: no markdown, no lists, no URLs. */
export function expectSpeakable(text: string) {
  expect(text, "a URL read aloud").not.toMatch(/https?:\/\/|www\./i);
  expect(text, "markdown or a list").not.toMatch(/[*#`_]{1,}\S|^\s*(?:[-•]|\d+\.)\s/m);
}
