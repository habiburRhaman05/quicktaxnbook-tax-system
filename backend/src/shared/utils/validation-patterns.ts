import { z } from 'zod';

/** Shared format/structural checks for identity & address fields collected
 * during firm and client onboarding. Kept format-only (regex/lookup) so it
 * can be reused from any zod schema via .regex()/.refine(). */

export const EIN_PATTERN = /^\d{2}-?\d{7}$/;
export const SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/;
export const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

// Accepts either a bare vanity subdomain label ("acme") or a full dotted
// domain ("portal.acme.com") - matches how Firm.domain is documented in the
// schema (vanity subdomain or custom domain). No protocol/path allowed.
export const DOMAIN_PATTERN =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*(\.[a-z]{2,})?$/i;

export const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'AS', 'GU', 'MP', 'PR', 'VI',
]);

/** Rejects SSNs that are well-formed (9 digits) but structurally invalid per
 * SSA rules: area 000/666/900-999, group 00, and serial 0000 were never
 * issued. Catches obviously fake values (e.g. 000-00-0000, 123-00-6789)
 * that a plain digit-count regex lets through. */
export const isValidSsnStructure = (digits: string): boolean => {
  if (!/^\d{9}$/.test(digits)) return false;
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5, 9);
  if (area === '000' || area === '666' || Number(area) >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
};

/** An EIN prefix of 00 was never issued by the IRS. */
export const isValidEinStructure = (digits: string): boolean => {
  if (!/^\d{9}$/.test(digits)) return false;
  return digits.slice(0, 2) !== '00';
};

interface AddressLike {
  state?: string;
  postalCode?: string;
  country?: string;
}

/** State/ZIP only have a fixed, checkable format for US addresses - for any
 * other country we only check that a value was actually provided, not its
 * shape. Call from a schema's superRefine with the field's path prefix, e.g.
 * validateUsAddress(data.business.address, ctx, ['business', 'address']). */
export const validateUsAddress = (
  address: AddressLike | undefined,
  ctx: z.RefinementCtx,
  path: (string | number)[]
): void => {
  if (!address) return;
  const isUs = !address.country || address.country.toUpperCase() === 'US';
  if (!isUs) return;

  if (address.state && !US_STATE_CODES.has(address.state.toUpperCase())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Enter a valid 2-letter US state code (e.g. CA)',
      path: [...path, 'state'],
    });
  }

  if (address.postalCode && !US_ZIP_PATTERN.test(address.postalCode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Enter a valid US ZIP code (12345 or 12345-6789)',
      path: [...path, 'postalCode'],
    });
  }
};
