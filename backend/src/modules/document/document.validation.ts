import { z } from 'zod';

export const createRequestSchema = z.object({
  body: z.object({
    clientId: z.string().min(1, 'A client is required'),
    title: z.string().min(1, 'Describe the document you need'),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    dueDate: z.coerce.date().optional(),
  }),
});

export const clientIdParamSchema = z.object({
  params: z.object({ clientId: z.string() }),
});

export const requestIdParamSchema = z.object({
  params: z.object({ requestId: z.string() }),
});

export const reviewRequestSchema = z.object({
  params: z.object({ requestId: z.string() }),
  body: z.object({
    status: z.enum(['RECEIVED', 'REJECTED']),
    reason: z.string().optional(),
  }),
});

/**
 * Upload metadata arrives as multipart text fields alongside the file, so every
 * value is a string here - `isRequired`-style coercion is deliberate.
 */
export const uploadSchema = z.object({
  body: z.object({
    clientId: z.string().min(1, 'A client is required'),
    requestId: z.string().optional(),
    title: z.string().optional(),
    clientNote: z.string().optional(),
  }),
});
