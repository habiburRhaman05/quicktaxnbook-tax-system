# GoHighLevel Integration - Plan & Decision Record

Status: **draft, in progress** · Owner: Habib · Last updated: 2026-09-24

This is the single place where GHL decisions live. Every entry marked **LOCKED** was
confirmed in conversation; entries marked **PROPOSED** still need a yes/no.

Replaces the earlier "PIT + Webhook migration" spike plan. There is no spike phase -
we build the flows directly and verify against the live API as we go.

---

## 1. Locked decisions

| # | Decision | Notes |
|---|---|---|
| D1 | GHL is the system of action. Postgres keeps identity, tenancy, credentials, audit. | |
| D2 | Credentials are **Private Integration Tokens (PIT)**, not a Marketplace OAuth app. | PITs are static tokens, available for agencies *and* sub-accounts. Rotate every 90 days; GHL gives a 7-day overlap window where old + new both work. |
| D3 | Auth is **two layers**: one agency PIT (env, platform-wide) + one PIT per firm (stored per firm, encrypted). | Agency PIT is only used to look things up / verify a sub-account exists. Firm data operations use that firm's own PIT. |
| D4 | `locationId` arrives in the **URL**, and the app routes on it. | See §2 for the three URL shapes. |
| D5 | We **never create** a sub-account in GHL. | Sub-accounts are created by the agency in GHL. Our job is to *link* to them. |
| D6 | The firm onboarding form does **not** provision anything in GHL. | It is a log-only mock: `logGhlProvisionIntent()` in `platform.service.ts`. |
| D7 | Webhooks are **on hold**. | No `/webhooks/ghl` endpoint, no workflow receiver until you say so. |
| D8 | No live spike / integration-test run. | We verify endpoints against the official docs and validate in the real flow instead. |
| D9 | The `/platform` popup collects the **agency PIT + the agency's Relationship Number**. | Relationship Number is stored on the connection record. |
| D10 | The agency credential lives in a new **`GhlAgencyConnection`** model. | `Integration` stays strictly firm-scoped, so its `@@unique([firmId, provider])` keeps its meaning. |
| D11 | Schema trim = **middle path**: delete models with no plausible near-term use, **keep** Case / Document / Task / Message. | So the GHL phases can still rebuild a local index if needed. See §9. |
| D12 | **The platform area has no user login.** The agency PIT *is* the credential: visit `/platform`, paste the token + Relationship Number, and we issue an httpOnly agency session cookie. `requireRole(['PLATFORM_OWNER'])` is gone from the platform layout and `requirePlatformOwner` is gone from the platform routes. | Reasoning: a valid agency PIT can only be minted by an agency admin inside GoHighLevel, so possessing it already proves authority. The connect endpoint is rate-limited because it is now the only unauthenticated entry point. |
| D13 | The agency session is a **stateless JWT signed with `JWT_SECRET`**, held as an httpOnly cookie by Next.js and forwarded to Express as `x-ghl-agency-session`. | Express stays stateless (it can't read cookies), matching the existing architecture. Nothing new to store; rotating `JWT_SECRET` invalidates every agency session at once. |

| D14 | **Supersedes D12 and D13.** `/platform` is password-login again (`PLATFORM_OWNER`). After sign-in, if no agency is connected a non-dismissible popup asks for the agency PIT + company id (+ optional relationship number); once stored, it never appears again. The agency session JWT/cookie/header is removed. | The connect endpoint now requires the platform-owner login. A company id that GoHighLevel reports differently from the one typed is rejected. |
| D15 | **Firm owner entry:** `/firms/{locationId}` verifies the sub-account under the agency, then the firm's stored PIT live, then signs in the firm owner and opens the dashboard. No stored/working PIT → the token form is shown. Suspended firms are refused. | Failed attempts are rate-limited. |
| D16 | **Team entry:** `/firms/{locationId}/teams/{userId}` verifies the sub-account, then that `userId` is staff of it (GHL Users API with the firm's PIT), then signs in as `FIRM_TEAM` (created on first visit, matched by email after). Deactivated members, the firm admin's own email, and emails owned by other firms are refused. | Requires the firm owner to have connected first. |

---

## 2. Route map

| Route | Who opens it | What happens |
|---|---|---|
| `/platform` | Platform owner (agency) | Popup asks for the **agency PIT**. We validate it against GHL, pull the agency profile, store the connection, then list every sub-account (location) under that agency. |
| `/firm/:locationId` | Firm owner (sub-account) | Popup asks for that **sub-account's PIT**. We verify it belongs to `:locationId`, then store it against the firm. |
| `/team/:locationId/:teamId` | Team member | We check that `:teamId` exists as a user **under that sub-account**. If yes → full team access. If no → rejected + audited. |

`locationId` and `teamId` are the GHL identifiers. They are always validated against
GHL; a URL parameter is never trusted on its own.

---

## 3. Flow 1 - `/platform` (agency connect) · **first deliverable**

1. Anyone visiting `/platform` without a stored agency connection sees a popup
   asking for the **agency PIT** and the agency's **Relationship Number**.
2. We call GHL with the pasted token to **validate it and read the agency profile**.
3. On success we create the agency connection record and store the token encrypted.
4. We then fetch **all sub-accounts under that agency** and render them as a list.
5. Anyone re-visiting `/platform` sees the stored connection state instead of the popup.

Endpoints (built - platform-owner only):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/platform/ghl/agency/connect` | **Public + rate-limited.** Body `{ privateToken, relationshipNumber? }`. Validates live, stores encrypted, returns a one-time `sessionToken`. This is the login. |
| `GET` | `/v1/platform/ghl/agency` | Agency session required. Connection state. Never returns the token. |
| `GET` | `/v1/platform/ghl/agency/locations` | Agency session required. `?page&limit` → paginated sub-account list. |

**Superseded by D12:** the connect call is now the *only* unauthenticated endpoint in
the platform area, and everything else (including `/firms`) requires the agency
session. Nothing is written until GHL confirms the token works, so a typo can never
leave a broken credential on file, and `tokenEncrypted` is never selected into a
response.

Frontend routes: `POST /api/platform/ghl/agency/connect` sets the httpOnly cookie and
**strips `sessionToken` from the JSON before serializing**, so client JavaScript can
never read the platform-wide credential. `GET /api/platform/ghl/agency` answers
"connected or not" with a 200 either way, and clears a stale cookie so an expired
session can't trap the user behind an unsatisfiable gate.

---

## 4. Flow 2 - `/firm/:locationId` (firm owner)

1. Page loads with `locationId` from the path.
2. **Agency pre-check** (`precheckLocation`): with the agency PIT, does this
   sub-account exist, and is it already linked to a firm?
3. Popup asks the firm owner for the sub-account PIT.
4. `connectFirmToLocation` verifies the token **live** - and requires GHL to echo back
   the *same* `locationId`, so a valid token for a different sub-account is rejected.
5. Token is encrypted into `Integration.configEncrypted`, `Firm.ghlLocationId` is set,
   and an `AuditLog` row is written - all in one transaction.

The pre-check is deliberately **non-blocking**: if GHL is disabled, the agency token is
missing/rejected, or GHL is unreachable, we say so and continue to the token step, which
is verified for real. Status is reported as `checked / exists / reason`.

---

## 5. Flow 3 - `/team/:locationId/:teamId` (team member)

1. Resolve the firm by `locationId`.
2. Using that firm's stored PIT, check whether `teamId` exists as a user in that
   sub-account (GHL Users API).
3. Exists → mint our session with team scope. Missing → reject and audit.

Open: whether "all access as team" means our `FIRM_TEAM` role or something broader - §8 Q3.

---

## 6. Explicitly on hold

Sub-account creation · snapshot/bootstrapping · custom-menu provisioning ·
Mailer/email replacement · contacts, opportunities, tasks, conversations, media,
documents, e-sign · webhooks and reconcile · SMTP removal · the `FileStorage` adapter.

Nothing above should be half-built. The GHL module currently implements only the
agency/firm credential flows.

---

## 7. Verified GHL API facts

Checked against `marketplace.gohighlevel.com/docs` on 2026-09-24. Anything not in this
table is **unverified** and must be confirmed before use - no invented endpoints.

| Fact | Value |
|---|---|
| Base URL | `https://services.leadconnectorhq.com` |
| Required headers | `Authorization: Bearer <PIT>`, `Version: 2021-07-28`, `Accept: application/json` |
| Missing/invalid `Version` | Request is rejected outright |
| Get sub-account | `GET /locations/:locationId` → `{ location: { id, companyId, name, email, phone, ... } }` |
| List sub-accounts | `GET /locations/search` with `companyId`, `skip`, `limit`, `order`, `email` → `{ locations: [...] }` |
| Token types | Endpoints declare agency-token vs sub-account-token. Some endpoints accept only one. |
| PIT scope | Agency admins create PITs in GHL → Settings → Private Integrations (must be enabled on Labs first). |

**Unverified, must be confirmed by a live call:** whether `GET /locations/:locationId`
accepts an *agency* token (the docs page does not state its token type), and whether a
sub-account token can read its own location. The code handles both outcomes instead of
assuming - see §4 step 2.

---

## 8. Open questions

| # | Question | Why it matters |
|---|---|---|
| ~~Q1~~ | **Resolved (D9):** popup collects the agency PIT **and** the Relationship Number. | |
| Q1b | You also said: "if possible to get agency access using pti token then you can also keep that but first verify". | The code does exactly this - `verifyAgencyToken()` makes a live call and only stores on success. **Still unverified:** whether the agency PIT alone can read agency-level data. That needs one real call with your token. |
| ~~Q2~~ | **Resolved (D11):** middle path - delete unused, keep Case/Document/Task/Message. Not yet executed; see §9. | |
| Q3 | For `/team/:locationId/:teamId`, does "all access as team" mean our existing `FIRM_TEAM` role, or a tenant-wide grant? | Our RBAC is finer-grained than GHL's roles. |
| Q4 | Where does "no login required" stop? `/firm/:locationId` is opened by a firm owner who may not have a session yet. | Anyone with the URL + a valid PIT could otherwise claim a sub-account. |

---

## 9. Prisma schema - trim (**D11 decided: middle path, not yet executed**)

> **DECIDED:** delete models with no plausible near-term use; **keep** `Case`,
> `Document`, `Task`, `Message` and everything they depend on. Nothing has been
> deleted yet - this section is the plan, and the safe sequence is at the end of this section.
>
> Coupled models must move with their parent: keeping `Case` means keeping
> `Pipeline`, `PipelineStage`, `EngagementType`, `CaseAssignment`,
> `CaseCollaborator`, `CaseStageHistory`; keeping `Client` means keeping
> `ClientTag`/`Tag` and `ClientRelationship`. Those are not optional extras -
> dropping them leaves dangling relation fields on models we keep.


Current schema: **95 models, 82 enums**. The application code touches **14 models**.

### Used by code today

`Firm` · `FirmSettings` (nested write in `platform.service.ts`) · `User` · `FirmMember` ·
`FirmMemberRole` · `Role` · `Session` · `OtpChallenge` · `OnboardingLink` · `Client` ·
`ClientAccess` · `Address` · `StoredFile` · `AuditLog` · `Integration`

### Keep - identity / tenancy / account, **plus the Case / Document / Task / Message domain** (per D11)

The 14 above **plus**: `FirmBranding`, `FirmDomain`, `FirmFeatureFlag`,
`VerificationToken`, `Invitation`, `MfaFactor`, `MfaRecoveryCode`, `ClientPerson`,
`ClientRelationship`, `ClientTag`, `Tag`, `WebhookEvent` (kept for future GHL webhooks).

### Delete - the rest (~50 models)

> Superseded by D11: from the list below, **keep** everything belonging to the Case,
> Document, Task and Message domains. What is actually deleted is voice/AI, marketing
> automations, reports, imports, billing/Stripe, custom fields, notes, notifications,
> reminders, appointments/calendar, phone numbers, call logs, outbound webhooks, API
> keys, usage records and plans.

Everything else, including the whole CRM/tax domain: `Case`, `CaseAssignment`,
`CaseCollaborator`, `CaseStageHistory`, `CaseTag`, `Pipeline`, `PipelineStage`,
`EngagementType`, `ServiceItem`, `Document`, `DocumentVersion`, `DocumentCategory`,
`DocumentRequest`, `DocumentRequestTemplate`, `DocumentRequestTemplateItem`, `ReturnDraft`,
`DraftComment`, `ReturnSummary`, `ExtractionJob`, `EFiling`, `SignatureTemplate`,
`SignatureRequest`, `SignatureSigner`, `SignatureEvent`, `Invoice`, `InvoiceLineItem`,
`Payment`, `Refund`, `StripeAccount`, `Plan`, `FirmSubscription`, `UsageRecord`, `Task`,
`TaskComment`, `TaskTemplate`, `TaskTemplateItem`, `MessageThread`, `Message`,
`MessageAttachment`, `MessageReceipt`, `AppointmentType`, `Appointment`,
`AppointmentAttendee`, `AvailabilityRule`, `AvailabilityException`, `CalendarConnection`,
`NotificationTemplate`, `Notification`, `NotificationPreference`, `ReminderRule`,
`Reminder`, `VoiceAgentConfig`, `PhoneNumber`, `CallLog`, `CallTranscriptSegment`,
`ReportSchedule`, `ReportRun`, `ImportJob`, `ImportRow`, `AutomationRule`, `AutomationRun`,
`FirmSequence`, `WebhookEndpoint`, `WebhookDelivery`, `ApiKey`, `Note`,
`CustomFieldDefinition`, `CustomFieldValue`.

Plus every enum that only those models use (roughly 60 of the 82).

### Why this needs an explicit yes

1. **It is irreversible in the database.** A migration that removes models issues
   `DROP TABLE` - every row in them is gone, along with any existing data.
2. **It contradicts decision D-earlier** ("additive migrations only, never drop models").
   That rule was written to protect you from exactly this. Overriding it is your call to
   make consciously, not mine to assume.
3. **It reverses the original architecture.** The first plan had Postgres hold a local
   index/cache of Case, Document and Task because GHL search is limited and rate-limited
   (100 req/10s). Deleting those models means re-adding them later if Phase 5/6 still
   stand. If GHL has fully replaced that plan, deleting is correct - if not, we should
   leave them unused rather than drop them.

### Recommended safe sequence

1. Confirm §9 point 3 above (does the old Case/Document plan still exist?).
2. Land the GHL flows first, with the schema untouched.
3. Then delete in one reviewed PR, with the DB backed up first.

---

## 10. Built so far

| File | What |
|---|---|
| `backend/src/modules/ghl/ghl.types.ts` | Shared GHL types, pre-check result, token kinds |
| `backend/src/modules/ghl/ghl.client.ts` | The only GHL HTTP path: `Version` header, per-attempt timeout, retry + jittered backoff on 429/5xx honouring `Retry-After`, per-location concurrency cap, never logs tokens or bodies |
| `backend/src/modules/ghl/ghl.tokens.ts` | `agency()` / `forFirm()` / `forLocation()` / `saveFirmLocationToken()` |
| `backend/src/modules/ghl/ghl.service.ts` | `precheckLocation` · `verifyLocationToken` · `connectFirmToLocation` |
| `backend/prisma/schema.prisma` | `IntegrationProvider.GOHIGHLEVEL`, `Firm.ghlLocationId`/`ghlCompanyId`/`ghlConnectedAt`, `Integration.lastVerifiedAt` (all additive) |
| `backend/src/config/config.ts` | `GHL_*` env vars, all optional so a GHL-less deploy still boots |
| `backend/src/modules/platform/platform.service.ts` | `logGhlProvisionIntent()` - the deliberate no-op for onboarding |
| `backend/src/modules/ghl/agency.service.ts` | `getAgencyConnection` · `connectAgency` (validate → encrypt → store) · `listSubAccounts` |
| `backend/src/modules/ghl/ghl.tokens.ts` | `forAgencyConnection()` - prefers the DB connection, falls back to `GHL_AGENCY_PIT` |
| `backend/prisma/schema.prisma` | `GhlAgencyConnection` model + `User.ghlAgencyConnections` back-relation |
| `backend/src/modules/platform/{route,controller,validation}.ts` | The three `/v1/platform/ghl/*` endpoints |
| `frontend/src/components/platform/ghl-agency-card.tsx` | The Connect panel: status badge, token dialog, sub-account table + pagination |
| `frontend/src/features/platform/hooks/use-ghl-agency.ts` | `useGhlAgency` · `useConnectGhlAgency` · `useGhlAgencyLocations` |
| `frontend/src/features/platform/schemas/connect-agency.ts` | Token + Relationship Number form schema |
| `frontend/src/app/platform/firms/page.tsx` | Renders `GhlAgencyCard` above the firms table (`/platform` redirects here) |

Verified: `prisma generate`, `tsc --noEmit`, `eslint` all clean.
Not verified: `vitest` cannot run without a `DATABASE_URL` containing `test`
(`test/setup.ts` hard-throws otherwise) - pre-existing.
