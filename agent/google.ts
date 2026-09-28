import { requireEnv, type ToolContext, type ToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";

// Shared by the Google environment tools (`tools/pollen.ts`,
// `tools/air_quality.ts`). It lives beside agent.ts because `tools/` is flat and
// every file there must be a tool.
//
// Both APIs take coordinates, so the place is geocoded first with Places text
// search on the `google_places` key. Custom tools cannot read the device's
// `?location=` (only the builtins can), so no place named falls back to
// HOME_LOCATION in `.env`.

const LocateResponse = z.object({
  places: z
    .array(
      z.object({
        location: z.object({ latitude: z.number(), longitude: z.number() }),
        formattedAddress: z.string().optional(),
      }),
    )
    .optional(),
});

export const locationField = z
  .string()
  .optional()
  .describe("A city or place name, e.g. 'Austin, TX'. Omit for the caller's home.");

export type Located = { key: string; latitude: number; longitude: number; place: string };

/** Google's own message, first sentence only: the model reads it aloud. */
export async function googleError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message?.split(". ")[0] ?? `HTTP ${res.status}`;
}

export async function locate(
  location: string | undefined,
  ctx: ToolContext,
): Promise<Located | ToolFailure> {
  const key = requireEnv(ctx, "GOOGLE_PLACES_API_KEY");
  const query = location ?? ctx.env.HOME_LOCATION;
  if (!query) return toolFailure("No location given and no home location is set: ask where.");

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": key,
      "x-goog-fieldmask": "places.location,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: query, pageSize: 1 }),
    signal: ctx.signal,
  });
  if (!res.ok) return toolFailure(`Could not look up the place: ${await googleError(res)}`);
  const found = LocateResponse.parse(await res.json()).places?.[0];
  if (!found) return toolFailure(`Could not find a place called "${query}".`);
  return {
    key,
    ...found.location,
    // Never read the home street address back; a named place is fine.
    place: location ? (found.formattedAddress ?? location) : "home",
  };
}
