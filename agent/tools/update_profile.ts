import { tool, toolFailure } from "@alexkroman1/aai";
import { errorMessage, isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { geocode } from "../google.ts";
import {
  CODE_TTL_MS,
  PROFILE_FIELDS,
  type ProfileField,
  spokenPhone,
  startPhoneVerification,
  writeProfile,
} from "../profile.ts";

// "My address is …", "call me Sam", "text me at … instead", "forget my number". The one
// way profile fields change (profile.ts). A home address is checked against Places and
// saved as Google formats it, with its coordinates; a phone number is only texted a code
// here, and confirm_phone saves it once the code comes back.
export default tool({
  description:
    "Save, change or clear something in their profile: their name, home street address, " +
    "or mobile number for texts. Use it whenever they tell you one of these, or when " +
    "another tool says it needs one and they have just told you. A new phone number is " +
    "texted a code that they must read back to you for confirm_phone.",
  inputSchema: z.object({
    field: z.enum(Object.keys(PROFILE_FIELDS) as [ProfileField, ...ProfileField[]]).describe(
      Object.entries(PROFILE_FIELDS)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; "),
    ),
    value: z
      .string()
      .max(200)
      .nullable()
      .describe(
        "What they said, e.g. '123 Main St, Springfield' or '555 555 0123'; null to clear it",
      ),
  }),
  async execute({ field, value }, ctx) {
    const said = value?.trim();
    if (!said) {
      await writeProfile(
        ctx,
        field === "home_address" ? { home_address: null, home_coords: null } : { [field]: null },
      );
      return { cleared: field };
    }

    if (field === "name") {
      await writeProfile(ctx, { name: said });
      return { saved: "name", name: said };
    }

    if (field === "home_address") {
      const found = await geocode(said, ctx);
      if (isToolFailure(found)) return found;
      await writeProfile(ctx, {
        home_address: found.formattedAddress,
        home_coords: `${found.latitude},${found.longitude}`,
      });
      // The formatted address, so a wrong match ("Springfield, IL" for Oregon) is heard.
      return { saved: "home_address", address: found.formattedAddress };
    }

    const started = await startPhoneVerification(ctx, said).catch((err: unknown) =>
      toolFailure(`Could not text a code: ${errorMessage(err)}`),
    );
    if (isToolFailure(started)) return started;
    switch (started.status) {
      case "invalid":
        return toolFailure(
          "That isn't a phone number I can text. Ask them to say it again with the area code.",
        );
      case "unchanged":
        return { saved: "phone", note: "That is already the number on file." };
      case "rate_limited":
        return toolFailure("I've texted too many codes today. Ask them to try again tomorrow.");
      default: // sent
        return {
          verification: "code_texted",
          to: spokenPhone(started.phone),
          expiresInMinutes: CODE_TTL_MS / 60_000,
          next: "Ask them to read the six-digit code back, then call confirm_phone with it.",
        };
    }
  },
});
