import { z } from 'zod';

import {
  EIN_PATTERN,
  isValidEinStructure,
  validateUsAddress,
} from '@/libs/validation-patterns';

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine(
    (value) => /\d/.test(value) && /[a-zA-Z]/.test(value),
    'Password must contain at least 1 letter and 1 number',
  );

/** Individual clients: admin already gave name/email/phone at creation -
 * onboarding just confirms identity and sets a password. */
export const individualOnboardingSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  phone: z.string().min(7, 'Enter a valid phone number'),
  password: passwordSchema,
});
export type IndividualOnboardingInput = z.infer<
  typeof individualOnboardingSchema
>;

const businessAddressSchema = z.object({
  line1: z.string().optional().or(z.literal('')),
  line2: z.string().optional().or(z.literal('')),
  city: z.string().optional().or(z.literal('')),
  state: z.string().optional().or(z.literal('')),
  postalCode: z.string().optional().or(z.literal('')),
  country: z.string().optional().or(z.literal('')),
});

/** Business/trust/nonprofit clients: collect the entity's info plus the
 * signer's own login details. */
export const businessOnboardingSchema = z
  .object({
    business: z.object({
      legalName: z.string().min(1, 'Legal business name is required'),
      ein: z
        .string()
        .optional()
        .refine((v) => !v || EIN_PATTERN.test(v), 'EIN must look like 12-3456789')
        .refine(
          (v) => !v || isValidEinStructure(v),
          'That EIN is not a valid IRS-issued number',
        ),
      website: z
        .string()
        .optional()
        .refine((v) => !v || z.url().safeParse(v).success, 'Enter a valid URL'),
      phone: z.string().optional().or(z.literal('')),
      address: businessAddressSchema,
    }),
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    email: z.email('Enter a valid email').trim(),
    phone: z.string().min(7, 'Enter a valid phone number'),
    password: passwordSchema,
  })
  .superRefine((data, ctx) => {
    validateUsAddress(data.business.address, ctx, ['business', 'address']);
  });
export type BusinessOnboardingInput = z.infer<typeof businessOnboardingSchema>;
