import { requireSessionClient, tool, toolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { approveCall } from "../calls.ts";
import { call } from "../shared.ts";

// Step two: dial a call prepare_call drafted, after they said yes to its read-back. The
// server checks the draft is this session's, still fresh and under the day's cap, so a
// call can't be placed from a draft nobody here heard.
export default tool({
  description:
    "Place a call prepared with prepare_call, ONLY after they clearly said yes to its " +
    "read-back. Afterwards say you're calling now and will tell them how it went.",
  inputSchema: z.object({
    call_id: z.string().max(64).describe("The call_id prepare_call returned"),
  }),
  async execute({ call_id }, ctx) {
    const clientId = requireSessionClient(
      ctx,
      "Calls can only be placed from a speaker or the page.",
    );
    if (isToolFailure(clientId)) return clientId;
    const approved = await approveCall(ctx, call_id, { sessionId: ctx.sessionId, clientId });
    if (approved.status === "refused") return toolFailure(approved.why);
    await ctx.workflows.start(
      call,
      { callId: call_id, clientId },
      { key: clientId, label: `Call ${approved.call.callee}: ${approved.call.goal}` },
    );
    return { calling: approved.call.callee };
  },
});
