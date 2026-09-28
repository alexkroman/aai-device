import { tool, toolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { googleError, locate, locationField } from "../google.ts";

// Google's Pollen API, on the `google_places` key (the project needs the Pollen
// API enabled). Open-Meteo has pollen too, but only for Europe.

const IndexInfo = z.object({ value: z.number().optional(), category: z.string().optional() });

const PollenResponse = z.object({
  dailyInfo: z
    .array(
      z.object({
        pollenTypeInfo: z
          .array(
            z.object({
              displayName: z.string(),
              inSeason: z.boolean().optional(),
              indexInfo: IndexInfo.optional(),
              healthRecommendations: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        plantInfo: z
          .array(
            z.object({
              displayName: z.string(),
              inSeason: z.boolean().optional(),
              indexInfo: IndexInfo.optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export default tool({
  description:
    "Today's pollen levels for grass, tree and weed pollen, and which plants are worst. " +
    "Leave location out when they did not name a place, to use their home.",
  inputSchema: z.object({ location: locationField }),
  async execute({ location }, ctx) {
    const at = await locate(location, ctx);
    if (isToolFailure(at)) return at;

    const url =
      `https://pollen.googleapis.com/v1/forecast:lookup?days=1&plantsDescription=false` +
      `&location.latitude=${at.latitude}&location.longitude=${at.longitude}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": at.key }, signal: ctx.signal });
    if (!res.ok) return toolFailure(`Pollen lookup failed: ${await googleError(res)}`);
    const today = PollenResponse.parse(await res.json()).dailyInfo?.[0];
    if (!today) return toolFailure("No pollen forecast for that place.");

    return {
      place: at.place,
      types: (today.pollenTypeInfo ?? []).map((t) => ({
        type: t.displayName,
        level: t.indexInfo?.category ?? (t.inSeason === false ? "out of season" : "none"),
      })),
      worstPlants: (today.plantInfo ?? [])
        .filter((p) => (p.indexInfo?.value ?? 0) > 0)
        .sort((a, b) => (b.indexInfo?.value ?? 0) - (a.indexInfo?.value ?? 0))
        .slice(0, 3)
        .map((p) => `${p.displayName} (${p.indexInfo?.category})`),
      tip: today.pollenTypeInfo?.flatMap((t) => t.healthRecommendations ?? [])[0],
    };
  },
});
