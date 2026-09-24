/** Shared format/structural checks for identity & address fields collected
 * during firm and client onboarding. Mirrors
 * backend/src/shared/utils/validation-patterns.ts - keep both in sync. */

export const EIN_PATTERN = /^\d{2}-?\d{7}$/;
export const SSN_PATTERN = /^\d{3}-?\d{2}-?\d{4}$/;
export const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

// Accepts either a bare vanity subdomain label ("acme") or a full dotted
// domain ("portal.acme.com") - no protocol/path allowed.
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

const normalizeDigits = (value: string) => value.replace(/\D/g, '');

/** Rejects SSNs that are well-formed (9 digits) but structurally invalid per
 * SSA rules: area 000/666/900-999, group 00, and serial 0000 were never
 * issued. */
export const isValidSsnStructure = (value: string): boolean => {
  const digits = normalizeDigits(value);
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
export const isValidEinStructure = (value: string): boolean => {
  const digits = normalizeDigits(value);
  if (!/^\d{9}$/.test(digits)) return false;
  return digits.slice(0, 2) !== '00';
};

interface AddressLike {
  state?: string;
  postalCode?: string;
  country?: string;
}

/** State/ZIP only have a fixed, checkable format for US addresses - for any
 * other country we skip the format check entirely. Call from a schema's
 * superRefine with the field's path prefix, e.g.
 * validateUsAddress(data.firm.address, ctx, ['firm', 'address']). */
export const validateUsAddress = (
  address: AddressLike | undefined,
  ctx: { addIssue: (issue: { code: 'custom'; message: string; path: (string | number)[] }) => void },
  path: (string | number)[],
): void => {
  if (!address) return;
  const isUs = !address.country || address.country.toUpperCase() === 'US';
  if (!isUs) return;

  if (address.state && !US_STATE_CODES.has(address.state.toUpperCase())) {
    ctx.addIssue({
      code: 'custom',
      message: 'Enter a valid 2-letter US state code (e.g. CA)',
      path: [...path, 'state'],
    });
  }

  if (address.postalCode && !US_ZIP_PATTERN.test(address.postalCode)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Enter a valid US ZIP code (12345 or 12345-6789)',
      path: [...path, 'postalCode'],
    });
  }
};
