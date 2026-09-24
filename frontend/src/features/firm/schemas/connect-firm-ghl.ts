import { z } from 'zod';

/**
 * Mirrors the backend `connectFirmSchema`. Only shape/length is checked here -
 * whether the token actually works, and whether it belongs to *this*
 * sub-account, is decided by GoHighLevel server-side.
 */
export const connectFirmGhlSchema = z.object({
  privateToken: z
    .string()
    .trim()
    .min(1, 'Paste the sub-account Private Integration Token')
    .min(20, 'That looks too short to be a GoHighLevel token'),
});

export type ConnectFirmGhlInput = z.infer<typeof connectFirmGhlSchema>;
