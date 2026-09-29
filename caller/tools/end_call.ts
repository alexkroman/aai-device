import { endSession, tool } from "@alexkroman1/aai";

// Hang up. The session ends once this reply has been SPOKEN, so the goodbye is heard, and
// ending a phone session closes Twilio's stream, which ends the call (<Connect><Stream>
// with nothing after it).
export default tool({
  description:
    "End the call, after you've said goodbye in the same reply. Call report_outcome first. " +
    "Also end it if you reach voicemail (after leaving no message), if they ask you to stop " +
    "calling, or if the call has gone off track.",
  execute(_args, ctx) {
    endSession(ctx);
    return { ending: true };
  },
});
