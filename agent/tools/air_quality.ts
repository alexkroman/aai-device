import { tool, toolFailure } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { airQualityApi, askGoogle, locate, locationField } from "../google.ts";

// Google's Air Quality API, on the `google_places` key (the project needs the
// Air Quality API enabled). Current conditions only.

const AirResponse = z.object({
  indexes: z
    .array(
      z.object({
        code: z.string(),
        aqi: z.number().optional(),
        category: z.string().optional(),
        dominantPollutant: z.string().optional(),
      }),
    )
    .optional(),
  healthRecommendations: z.object({ generalPopulation: z.string().optional() }).optional(),
});

/** Pollutant codes as something worth saying aloud. */
const POLLUTANTS: Record<string, string> = {
  o3: "ozone",
  pm25: "fine particles",
  pm10: "coarse particles",
  no2: "nitrogen dioxide",
  co: "carbon monoxide",
  so2: "sulfur dioxide",
};

export default tool({
  description:
    "Current air quality: the AQI, its category, and the main pollutant. " +
    "Leave location out when they did not name a place, to use their home.",
  inputSchema: z.object({ location: locationField }),
  async execute({ location }, ctx) {
    const at = await locate(location, ctx);
    if (isToolFailure(at)) return at;

    const res = await askGoogle("Air quality lookup", () =>
      airQualityApi(ctx, "POST", "/currentConditions:lookup", {
        location: { latitude: at.latitude, longitude: at.longitude },
        // LOCAL_AQI adds the region's own scale (US EPA here) beside Google's universal one.
        extraComputations: ["LOCAL_AQI", "HEALTH_RECOMMENDATIONS"],
        languageCode: "en",
      }),
    );
    if (isToolFailure(res)) return res;
    const air = AirResponse.parse(res);
    // The local index is the number people know (US AQI); universal is the fallback.
    const index = air.indexes?.find((i) => i.code !== "uaqi") ?? air.indexes?.[0];
    if (!index) return toolFailure("No air quality data for that place.");

    return {
      place: at.place,
      aqi: index.aqi,
      scale: index.code === "usa_epa" ? "US AQI" : index.code,
      category: index.category,
      mainPollutant:
        index.dominantPollutant && (POLLUTANTS[index.dominantPollutant] ?? index.dominantPollutant),
      tip: air.healthRecommendations?.generalPopulation,
    };
  },
});
