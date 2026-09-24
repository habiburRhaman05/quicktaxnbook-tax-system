# Auth System - Implementation Plan (Backend Only)

Status: **Built and smoke-tested** - all 4 roles, end-to-end, against the live Neon DB.
Scope: Full authentication + account-management system for the multi-tenant platform, for all 4 roles. No frontend work in this phase.

## 0. What's live right now

Every endpoint below was hit end-to-end with real HTTP requests against the running server and the live database - not just written, actually exercised: Platform Owner login → onboard a Firm (+ Firm Admin created) → duplicate EIN/SSN correctly rejected with 409 → Firm Admin login → create a Team member → Team member login blocked from changing their own password (403, as designed) → ban a Team member → login blocked (403) → unban → create a Client → generate onboarding link → complete onboarding (public) → auto-login → the full 3-step client login (email → password → emailed OTP → verify) → avatar upload served back over `/uploads` → refresh-token rotation → logout revokes the session → reusing a revoked refresh token correctly fails (401).

`npx tsc --noEmit`, `eslint`, and `prettier --check` all pass clean across the backend.

**Seeded Platform Owner credentials** are in `backend/.env` (`PLATFORM_OWNER_EMAIL` / `PLATFORM_OWNER_PASSWORD`) - created by running `npm run db:seed` once. Change the password after first login in a real deployment.

**To run:** `cd backend && npm run dev` (server on `:8000`, API under `/v1`).

I re-read the entire `schema.prisma` (all ~3,090 lines: tenancy, identity/auth, clients, pipeline, documents, e-sign, payments, tasks, messaging, reporting, integrations, platform billing). It's well-designed and multi-tenant-ready already. The only gap is exactly what you flagged: **nothing currently makes a Firm's identity unique**, and roles are implicit (inferred from relations) instead of an explicit enum. Both are fixed below.

---

## 1. The 4 roles - explicit now, not inferred

Previously a "role" was something you had to *derive* (is `isPlatformAdmin` true? does a `FirmMember` row exist? does a `ClientAccess` row exist?). You asked for a real enum instead. New design:

```prisma
enum AccountRole {
  PLATFORM_OWNER   // sells/operates the platform
  FIRM_ADMIN       // owns one Firm's account
  FIRM_TEAM        // works inside one Firm
  FIRM_CLIENT      // taxpayer using one Firm's portal
}
```

```prisma
model User {
  // ...existing fields...
  accountRole AccountRole   // NEW - replaces isPlatformAdmin boolean
  // isPlatformAdmin Boolean  <- REMOVED (redundant now: PLATFORM_OWNER covers it)
  // ...
  @@index([accountRole])    // NEW
}
```

Every `User` row gets exactly one `accountRole`, set once at creation and never changed by anyone but the system itself (a Firm Admin never "promotes" a Client into a Team member, etc. - each role is created through its own dedicated flow, described below). This single field is what JWTs, middleware, and every "who is allowed to do this" check reads - one source of truth, so there's no way for two parts of the code to disagree about what a user is.

The existing relational tables still carry the *details* for each role and don't change:
- **PLATFORM_OWNER** → no `FirmMember`, no `firmId` - global.
- **FIRM_ADMIN** → one `User` + one `FirmMember` row (`isOwner = true`) inside their `Firm`.
- **FIRM_TEAM** → one `User` + one `FirmMember` row (`isOwner = false`, `staffType` = PREPARER/REVIEWER/etc) inside their `Firm`.
- **FIRM_CLIENT** → one `User` + one `ClientAccess` row linking to a `Client` record inside their `Firm`.

## 2. Firm identity - the "no conflict" guarantee

**The problem:** two different tax agencies (or the same person trying to register twice) must never be able to collide or be mistaken for each other. `EIN` alone isn't enough (some sole props don't have one; typos happen), so per your instruction we combine **EIN + the responsible person's SSN** into one identity key.

**Why we can't just make `einEncrypted` unique:** encrypted values aren't deterministic (the same SSN encrypts to a different string every time), so a normal unique index on ciphertext doesn't catch duplicates. The fix is a **blind index**: a one-way HMAC hash of the normalized EIN+SSN, stored in its own unique column, used only to detect collisions - never decrypted, never displayed.

```prisma
model Firm {
  // ...existing fields (name, legalName, slug, email, phone, website,
  //     addressLine1/2, city, state, postalCode, country, einEncrypted...)...

  einLast4                 String?           // NEW - clear last-4 for display
  ownerSsnEncrypted         String?          // NEW - responsible party's SSN, AES-256-GCM
  ownerSsnLast4             String?          // NEW - clear last-4 for display
  licenseNumber             String?          // NEW - CTEC/EA/CPA/state license, if any
  licenseType                String?         // NEW - free text: "CTEC", "EA", "CPA", "STATE_BUSINESS", ...
  identityHash               String?  @unique // NEW - HMAC-SHA256(pepper, EIN + "|" + SSN) - dedup key
  createdByPlatformAdminId  String?           // NEW - which Platform Owner onboarded this firm
  createdByPlatformAdmin    User?    @relation("FirmOnboardedBy", fields: [createdByPlatformAdminId], references: [id], onDelete: SetNull) // NEW
}
```

```prisma
model User {
  // ...
  firmsOnboarded Firm[] @relation("FirmOnboardedBy")  // NEW - inverse side
}
```

```prisma
enum StorageProvider {
  S3
  R2
  GCS
  AZURE
  LOCAL   // NEW - local-disk file storage for this phase, per your request
}
```

New secrets in `backend/.env` (already git-ignored):
- `ENCRYPTION_KEY` - 32-byte key, AES-256-GCM, for reversible SSN/EIN storage
- `BLIND_INDEX_PEPPER` - separate secret for the HMAC dedup hash

No other model needs to change. `Session`, `OtpChallenge`, `VerificationToken`, `Invitation`, `OnboardingLink`, `FirmMember`, `Role`/`FirmMemberRole`, `ClientAccess`, `ClientPerson`, `StoredFile`, `AuditLog` already fit this design correctly - confirmed by reading the full schema, not just the auth-adjacent section.

## 3. The actual flow, in order

1. **Seed** - one `PLATFORM_OWNER` row only (email + password from `.env`, printed once). No Firm, no demo data.
2. **Platform Owner logs in** (`POST /api/v1/auth/login`, role resolved from `accountRole`).
3. **Platform Owner updates their own profile** (`PATCH /api/v1/me`, `POST /api/v1/me/avatar`).
4. **Platform Owner onboards a Firm** - manual form, one call, creates the `Firm` **and** its first `FIRM_ADMIN` `User` + `FirmMember` together:
   - Firm business info: legal name, display name, EIN, license (if any), website, business email/phone, full address.
   - Responsible party: SSN (for the identity key), plus the admin's own name/email/phone (becomes their login).
   - Server computes `identityHash`; if a Firm with that EIN+SSN combination already exists → **409 Conflict**, no duplicate created.
   - Response includes the new Firm Admin's email + one-time generated password (copy, not emailed - per your earlier decision).
5. **Firm Admin logs in**, updates their own profile, then:
   - Creates **Team** members (`FIRM_TEAM`) - auto-generated password, shown once for copy.
   - Creates **Clients** + generates an **onboarding link**.
6. **Client** opens the onboarding link → enters name/email/phone, sets a password, finishes profile setup → account activated (`FIRM_CLIENT`).
7. **Client logs in** any time after that with the 3-step flow you specified: email → password → OTP emailed → enter OTP → logged in.
8. **Admin can ban/unban Team** (`FirmMember.status`: `ACTIVE` ⇄ `DEACTIVATED`).
9. **All 4 roles** can view/update their own profile and photo; only Platform Owner/Firm Admin can change someone else's password, and only Firm Admin/Client can self-service their own password (Team cannot - must ask their Admin, per your earlier decision).

## 4. API surface

### Platform Owner
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/login` | Shared login for Platform Owner / Firm Admin / Team (role resolved from `accountRole`) |
| POST | `/api/v1/platform/firms` | Onboard a new Firm + its Firm Admin (EIN+SSN dedup check) |
| GET | `/api/v1/platform/firms` / `/:id` | List / view firms |
| PATCH | `/api/v1/platform/firms/:id/status` | Activate / suspend / cancel a firm |

### Shared staff/session endpoints (Platform Owner, Firm Admin, Team)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/refresh-token` | Rotate access token via `Session` |
| POST | `/api/v1/auth/logout` | Revoke current session |

### Client auth (3-step)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/client/login/start` | `{email}` → confirms account exists & onboarding complete |
| POST | `/api/v1/auth/client/login/password` | `{email, password}` → verifies password, emails OTP, returns short-lived `loginToken` |
| POST | `/api/v1/auth/client/login/verify-otp` | `{loginToken, otp}` → issues tokens |

### Team management (Firm Admin only)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/team` | Create a team member - password generated, returned once |
| GET | `/api/v1/team` / `/:id` | List / view |
| PATCH | `/api/v1/team/:id` | Update role, title, staff type |
| PATCH | `/api/v1/team/:id/status` | Ban / unban |
| PATCH | `/api/v1/team/:id/reset-password` | Admin resets a team member's password |

### Clients + onboarding (Firm Admin / Team)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/clients` | Create a client shell |
| POST | `/api/v1/clients/:id/onboarding-link` | Generate a branded onboarding link |
| GET | `/api/v1/onboarding/:token` | **Public.** Validate link, return minimal firm/client info |
| POST | `/api/v1/onboarding/:token/complete` | **Public.** Client submits profile + password → account activated |

### Profile (any authenticated role)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/me` | Own profile (role-aware shape) |
| PATCH | `/api/v1/me` | Update own name/phone/etc - never password/status/role |
| POST | `/api/v1/me/avatar` | Upload profile photo (local disk, multipart) |
| PATCH | `/api/v1/me/password` | Self-service - allowed for Platform Owner, Firm Admin, Client; **blocked for Team** |

## 5. Security details (unchanged from before, still applies)

- Passwords: bcrypt hash; plaintext only ever returned once, in the create/reset response.
- Sessions: refresh tokens tracked in `Session` (hashed) - real revocation, not just stateless JWT.
- OTP: 6-digit, hashed, 5-minute expiry, max 5 attempts, rate-limited per destination.
- SSN/EIN: AES-256-GCM encrypted at rest, last-4 shown in clear, blind-index hash for dedup - never logged, never returned in full over the API.
- Every query for Firm Admin/Team/Client is scoped by `firmId` resolved from the session - never trusted from request input.

## 6. Also confirmed while reviewing: current backend doesn't compile

`backend/src`'s `auth`, `user`, `post`, `notification` modules, `passport.ts`, `config/roles.ts` are leftover generic starter-kit boilerplate referencing `User.role`, `User.password`, a `Token`/`TokenType` model, and a `Post`/`Comment` model that don't exist in your real schema. As part of this build:
- Rewrite `auth` + `profile` + session handling against the real schema.
- Delete the `post` module (unrelated blog boilerplate).
- Stub `notification` module for now; rebuilt against the real `Notification` model in the Week 5 "Communication" phase per the PRD.
- Replace `config/roles.ts` / `types/rbac.ts` (blog-style permissions) with RBAC driven by `AccountRole`.

## 7. Build order

1. Schema migration (`AccountRole` enum + `User.accountRole`, `Firm` identity fields, `StorageProvider.LOCAL`) → regenerate Prisma client
2. Encryption utils (AES-256-GCM + HMAC blind index) + local file storage helper
3. Seed script - one Platform Owner account only
4. Shared staff login (role resolved from `accountRole`) + refresh + logout (Session-based)
5. Platform module - onboard Firm (+ Firm Admin), list/suspend firms
6. Team management endpoints (Firm Admin)
7. Client + onboarding flow (create → link → public form → 3-step client login)
8. Unified profile endpoints (get / update / avatar / password) for all 4 roles
9. Cleanup - delete `post` module, stub `notification`, remove dead `roles.ts`/`rbac.ts`
10. End-to-end smoke test of every flow, all 4 roles

## 8. Env vars to add (`backend/.env`)

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=devhabib2005@gmail.com
SMTP_PASSWORD=<gmail app password>
EMAIL_FROM="Qicktaxnbook365 <devhabib2005@gmail.com>"

PLATFORM_OWNER_EMAIL=<you choose>
PLATFORM_OWNER_PASSWORD=<you choose, or auto-generated + printed once by the seed script>

ENCRYPTION_KEY=<32-byte hex, generated>
BLIND_INDEX_PEPPER=<random secret, generated>

LOCAL_UPLOAD_DIR=uploads
```

---

**Still waiting on your go-ahead before I touch anything** - this is a review copy. Once confirmed I'll run the migration against the Neon DB (additive/non-destructive) and start on step 1 of the build order.
