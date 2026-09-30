import { requireEnv, type ToolContext, type ToolFailure, toolFailure } from "@alexkroman1/aai";
import type { EnvContext } from "@alexkroman1/aai/step";
import { HttpError, isRecord, isToolFailure, jsonClient } from "@alexkroman1/aai/utils";
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

export type Located = { latitude: number; longitude: number; place: string };

/** Google's own message in a refused body, first sentence only: the model reads it aloud. */
function googleSentence(body: unknown): string | undefined {
  return isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
    ? body.error.message.split(". ")[0]
    : undefined;
}

const googleKey = (env: Readonly<Partial<Record<string, string>>>) => ({
  "x-goog-api-key": requireEnv({ env }, "GOOGLE_PLACES_API_KEY"),
});

const places = jsonClient({
  label: "Google Places",
  baseUrl: "https://places.googleapis.com/v1",
  headers: googleKey,
  errorMessage: googleSentence,
});

// The environment APIs, on the same key. jsonClient, not the SDK's fetchJson: that one takes
// the builtins' screened fetch, which is for model-chosen URLs and which an eval's network
// cannot see, so an eval's lookups went to the real Google with a fake key.
export const pollenApi = jsonClient({
  label: "Google Pollen",
  baseUrl: "https://pollen.googleapis.com/v1",
  headers: googleKey,
  errorMessage: googleSentence,
});

export const airQualityApi = jsonClient({
  label: "Google Air Quality",
  baseUrl: "https://airquality.googleapis.com/v1",
  headers: googleKey,
  errorMessage: googleSentence,
});

/** A Google API call, with a refusal answered as a failure the model can read out. */
export async function askGoogle(
  what: string,
  call: () => Promise<unknown>,
): Promise<unknown | ToolFailure> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return toolFailure(`${what} failed: ${googleSentence(err.body) ?? `HTTP ${err.status}`}`);
  }
}

export type Geocoded = { latitude: number; longitude: number; formattedAddress: string };

/** The best match for `query`, or a failure the model can read out. */
export async function geocode(query: string, ctx: EnvContext): Promise<Geocoded | ToolFailure> {
  let body: unknown;
  try {
    body = await places(
      ctx,
      "POST",
      "/places:searchText",
      { textQuery: query, pageSize: 1 },
      { headers: { "x-goog-fieldmask": "places.location,places.formattedAddress" } },
    );
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const why = googleSentence(err.body) ?? `HTTP ${err.status}`;
    return toolFailure(`Could not look up the place: ${why}`);
  }
  const found = LocateResponse.parse(body).places?.[0];
  if (!found) return toolFailure(`Could not find a place called "${query}".`);
  return { ...found.location, formattedAddress: found.formattedAddress ?? query };
}

export async function locate(
  location: string | undefined,
  ctx: ToolContext,
): Promise<Located | ToolFailure> {
  if (location) {
    const found = await geocode(location, ctx);
    if (isToolFailure(found)) return found;
    return { latitude: found.latitude, longitude: found.longitude, place: found.formattedAddress };
  }

  const profile = await readProfile(ctx);
  if (!profile.home_address)
    return toolFailure(missingField("home_address", "for anything near home"));
  const [lat, lng] = (profile.home_coords ?? "").split(",").map(Number);
  if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
    // Never read the home street address back.
    return { latitude: lat, longitude: lng, place: "home" };
  }
  const found = await geocode(profile.home_address, ctx);
  if (isToolFailure(found)) return found;
  return { latitude: found.latitude, longitude: found.longitude, place: "home" };
}
