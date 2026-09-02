import { z } from "zod";

export const openTripMapAccommodationResponseSchema = z.array(z.object({
  xid: z.string().min(1).max(256),
  name: z.string().max(512),
  kinds: z.string().min(1).max(2_000),
  dist: z.number().finite().nonnegative().optional(),
  // OpenTripMap documents 1–3 and then returns 7 for anything it treats as
  // cultural heritage — Asakusa Shrine comes back rated 7. Capping at 3
  // failed the element, and because this is an array parse one heritage
  // listing failed the whole response: the richest neighbourhoods were the
  // ones that looked like a provider outage.
  rate: z.number().int().min(0).max(100).optional(),
  point: z.object({
    lon: z.number().finite().min(-180).max(180),
    lat: z.number().finite().min(-90).max(90),
  }).strict(),
}).passthrough()).max(1_000);

