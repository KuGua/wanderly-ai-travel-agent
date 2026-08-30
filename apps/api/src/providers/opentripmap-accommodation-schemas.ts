import { z } from "zod";

export const openTripMapAccommodationResponseSchema = z.array(z.object({
  xid: z.string().min(1).max(256),
  name: z.string().max(512),
  kinds: z.string().min(1).max(2_000),
  dist: z.number().finite().nonnegative().optional(),
  rate: z.number().int().min(0).max(3).optional(),
  point: z.object({
    lon: z.number().finite().min(-180).max(180),
    lat: z.number().finite().min(-90).max(90),
  }).strict(),
}).passthrough()).max(1_000);

