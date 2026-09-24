import { z } from 'zod';

import { password } from '@/modules/auth/auth.validation';
import { normalizeDigits } from '@/shared/utils/encryption';
import {
  EIN_PATTERN,
  isValidEinStructure,
  validateUsAddress,
} from '@/shared/utils/validation-patterns';

export const createClientSchema = z.object({
  body: z
    .object({
      displayName: z.string().min(1),
      type: z.enum(['INDIVIDUAL', 'BUSINESS', 'TRUST_ESTATE', 'NONPROFIT']).default('INDIVIDUAL'),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.type === 'INDIVIDUAL' && !data.email) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Email is required for individual clients since they onboard using it directly',
          path: ['email'],
        });
      }
    }),
});

export const clientIdParamSchema = z.object({
  params: z.object({ clientId: z.string() }),
});

/** Optional body: the GoHighLevel tag that marks a contact as a client. */
export const syncClientsFromGhlSchema = z.object({
  body: z
    .object({
      tag: z.string().trim().min(1).max(64).optional(),
    })
    .default({}),
});

export const listClientsSchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1).optional(),
    limit: z.coerce.number().min(1).max(100).optional(),
    search: z.string().optional(),
  }),
});

export const updateClientStatusSchema = z.object({
  params: z.object({ clientId: z.string() }),
  body: z.object({
    status: z.enum(['ACTIVE', 'INACTIVE']),
  }),
});

export const onboardingTokenParamSchema = z.object({
  params: z.object({ token: z.string() }),
});

const onboardingAddressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

export const completeOnboardingSchema = z.object({
  params: z.object({ token: z.string() }),
  body: z
    .object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      phone: z.string().min(7),
      password,
      // Present only when the client is a business/trust/nonprofit - validated
      // against the client's actual type in the service layer, since the type
      // lives on the Client record, not in this request.
      business: z
        .object({
          legalName: z.string().min(1),
          ein: z
            .string()
            .regex(EIN_PATTERN, 'EIN must look like 12-3456789')
            .refine(
              (v) => isValidEinStructure(normalizeDigits(v)),
              'That EIN is not a valid IRS-issued number'
            )
            .optional(),
          website: z.string().url().optional(),
          phone: z.string().optional(),
          address: onboardingAddressSchema.optional(),
        })
        .optional(),
    })
    .superRefine((data, ctx) => {
      validateUsAddress(data.business?.address, ctx, ['business', 'address']);
    }),
});
