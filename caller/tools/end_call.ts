import { endSession, tool } from "@alexkroman1/aai";

// Hang up. The session ends once this reply has been SPOKEN, so the goodbye is heard, and
// ending a phone session closes Twilio's stream, which ends the call (<Connect><Stream>
// with nothing after it).
export default tool({
  description:
    "End the call, after you've said goodbye in the same reply: a silent hang-up sounds like " +
    "a dropped line. Call report_outcome first. " +
    "Not while a live person is still talking with you: not in a reply that answers their " +
    "question, and not while you're asking one. At voicemail, a recording, or an automated " +
    "menu, hang up at once: report_outcome, then end_call, in that one reply, with no message. " +
    "Also end it if they ask you to stop calling, or if the call has gone off track.",
  execute(_args, ctx) {
    endSession(ctx);
    return { ending: true };
  },
});
