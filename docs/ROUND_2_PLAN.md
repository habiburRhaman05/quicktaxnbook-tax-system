# Round 2 - UI fixes, business clients, status control, OTP forgot-password

Status: **Proposed - awaiting go-ahead**

## 1. Bug fixes (quick)

- **Onboarding link overflowing its dialog** - the raw URL isn't wrapping. Fix: `break-all` + let `CopyReveal`'s code block wrap instead of forcing a single line.
- **Images not loading** - your backend's `helmet()` sets a default `Cross-Origin-Resource-Policy: same-origin` header. Avatars are served from `localhost:8000/uploads/...` but the page is on `localhost:6767`, so the browser blocks them as cross-origin. Fix: set `Cross-Origin-Resource-Policy: cross-origin` specifically on the `/uploads` static route (not globally - keep helmet's defaults everywhere else).

## 2. Client onboarding - type-aware fields

**Add Client popup (firm side) stays as-is** - name, type, email, phone. Making **email required** when type is Individual, so onboarding never has to ask for it again.

**Public onboarding form becomes type-aware:**

- **Individual** - unchanged in spirit, but no longer re-asks for what the admin already entered. Shows: first name, last name, password. Email comes from what the admin entered at creation (shown, not re-typed); phone is pre-filled and editable.
- **Business / Trust-Estate / Nonprofit** - two sections, similar in spirit to the firm-onboarding form but its own separate implementation (not reusing that component):
  - *Business info:* legal business name, EIN, website, business phone, business address (reuses the existing `Address` table - no schema change needed there).
  - *Your info (the person signing in):* first name, last name, login email, phone, password.

  I'm deliberately keeping one email per side (business email vs. the signer's login email) rather than adding a third "business email" field - simpler, and the signer's email is what matters for login.

**Schema change needed:** `Client` has no `website` column today (Firm does, Client doesn't) - adding `Client.website String?`. EIN/legal name storage already exists on `Client` (same encrypted pattern as `Firm`).

## 3. Phone input with country code

Adding `react-phone-number-input` (pairs with `libphonenumber-js`, gives a country-code dropdown + formatting/validation) to the Add Client form, and reusing the same component everywhere else phone numbers are collected (team creation, onboarding, profile) for consistency rather than just one spot.

## 4. Client status control

Mirrors the Team ban/unban pattern you already have:
- New backend endpoint `PATCH /clients/:id/status` (Firm Admin only) - cycles between `ACTIVE`/`INACTIVE` (the other statuses - Prospect, Onboarding, Archived - stay system-managed, not manually toggled).
- New row action in the Clients table, same confirm-dialog treatment as Team.

## 5. Forgot password - OTP-based, for Platform Owner / Firm Admin / Client

Per your confirmation, **Team stays admin-reset-only** (unchanged - preserves the oversight rule from round 1). The other three get real self-service recovery:

1. `POST /auth/forgot-password {email}` → generates an OTP, emails it, returns a short-lived reset token (same shape as the client-login pending-OTP token).
2. `POST /auth/reset-password {resetToken, otp, newPassword}` → verifies the OTP + token together, sets the new password, revokes all existing sessions.

This **replaces** the current link-in-email reset flow (which only worked for Platform Owner/Firm Admin) - one consistent OTP mechanism everywhere instead of two different ones.

**Schema change needed:** `OtpPurpose` enum is missing a `PASSWORD_RESET` value (it only has LOGIN/MFA/SIGNATURE/VERIFY_EMAIL/VERIFY_PHONE today).

## 6. Real email templates

Replacing the current plain-text emails with branded HTML (teal, matches the app) for: OTP codes (login + password reset), firm-admin welcome, client onboarding invite. Plain-text fallback kept alongside for email clients that need it.

## 7. Clean out test data

Firms, their team/client accounts, and everything under them get removed; **only the Platform Owner account stays**. I'll run this as a one-off cleanup script against the database directly - not a UI feature, since "wipe all firms" isn't something that belongs behind a button in the product.

## Build order

1. DB migration (`Client.website`, `OtpPurpose.PASSWORD_RESET`)
2. Backend: client-status endpoint, OTP forgot/reset-password endpoints, business fields on the onboarding-complete endpoint, HTML email templates
3. Frontend: fix overflow + image CORS, phone-input component, type-aware onboarding form, client status action, rebuilt forgot-password UI
4. Run the test-data cleanup script
5. End-to-end pass on every changed flow

---

Say go and I'll start on it.
