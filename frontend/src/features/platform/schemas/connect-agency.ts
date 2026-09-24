import { z } from 'zod';

/**
 * Mirrors the backend `connectAgencySchema`. The backend cannot know whether a
 * token is *valid* - only GoHighLevel can - so this deliberately checks shape
 * and length only, and the real verification happens server-side.
 */
export const connectAgencySchema = z.object({
  privateToken: z
    .string()
    .trim()
    .min(1, 'Paste the agency Private Integration Token')
    .min(20, 'That looks too short to be a GoHighLevel token'),
  relationshipNumber: z
    .string()
    .trim()
    .min(1, 'Enter the relationship number')
    .max(64, 'That is too long for a relationship number'),
});

export type ConnectAgencyInput = z.infer<typeof connectAgencySchema>;
