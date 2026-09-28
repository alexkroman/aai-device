import { requireEnv, type ToolContext, type ToolFailure, toolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { missingField, readProfile } from "./profile.ts";

// Shared by the Google environment tools (`tools/pollen.ts`,
// `tools/air_quality.ts`) and `update_profile`. It lives beside agent.ts because
// `tools/` is flat and every file there must be a tool.
//
// Both APIs take coordinates, so a named place is geocoded first with Places text
// search on the `google_places` key. No place named means home: the profile's
// home_address, whose coordinates were saved with it, so that costs no lookup.

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

export type Geocoded = { latitude: number; longitude: number; formattedAddress: string };

/** The best match for `query`, or a failure the model can read out. */
export async function geocode(query: string, ctx: ToolContext): Promise<Geocoded | ToolFailure> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": requireEnv(ctx, "GOOGLE_PLACES_API_KEY"),
      "x-goog-fieldmask": "places.location,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: query, pageSize: 1 }),
    signal: ctx.signal,
  });
  if (!res.ok) return toolFailure(`Could not look up the place: ${await googleError(res)}`);
  const found = LocateResponse.parse(await res.json()).places?.[0];
  if (!found) return toolFailure(`Could not find a place called "${query}".`);
  return { ...found.location, formattedAddress: found.formattedAddress ?? query };
}

export async function locate(
  location: string | undefined,
  ctx: ToolContext,
): Promise<Located | ToolFailure> {
  const key = requireEnv(ctx, "GOOGLE_PLACES_API_KEY");
  if (location) {
    const found = await geocode(location, ctx);
    if (isToolFailure(found)) return found;
    return {
      key,
      latitude: found.latitude,
      longitude: found.longitude,
      place: found.formattedAddress,
    };
  }

  const profile = await readProfile(ctx);
  if (!profile.home_address)
    return toolFailure(missingField("home_address", "for anything near home"));
  const [lat, lng] = (profile.home_coords ?? "").split(",").map(Number);
  if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
    // Never read the home street address back.
    return { key, latitude: lat, longitude: lng, place: "home" };
  }
  const found = await geocode(profile.home_address, ctx);
  if (isToolFailure(found)) return found;
  return { key, latitude: found.latitude, longitude: found.longitude, place: "home" };
}
