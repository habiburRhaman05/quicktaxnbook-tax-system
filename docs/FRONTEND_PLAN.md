# Frontend Build Plan

Status: **Proposed - awaiting go-ahead**
Scope: Wire the existing Next.js template to the real Express auth API for all 4 roles, with protected routing, RBAC, forms, and consistent success/error UX. No new backend work in this pass (aside from noted fast-follows).

The frontend is the `next-elite` template (Next.js 16, React 19, Tailwind 4, shadcn "new-york", Radix, react-hook-form + zod, sonner, tanstack-query). The component library, theming system, and sidebar/shell primitives are solid and reusable. The auth wiring is not - it's `better-auth`, pointed at no database, with a 2-role admin/user demo. Per your go-ahead, that gets removed and replaced with a real integration against the Express API.

## 1. Auth architecture

**Tokens never touch client-side JS.** Next.js route handlers act as a thin server-side proxy (BFF) to the Express API and store tokens in `httpOnly` cookies:

```
Browser ──cookie──▶ Next.js route handlers (/api/*) ──Bearer token──▶ Express API (:8000/v1)
```

- `POST /api/auth/login` → calls Express `/v1/auth/login` → sets `qt_access` + `qt_refresh` httpOnly cookies → returns `{ user }` (no tokens) to the browser.
- `POST /api/auth/client/login/start|password|verify-otp` → thin passthroughs to the matching Express client-login steps; `verify-otp` sets the session cookies on success.
- `POST /api/auth/logout` → calls Express logout, clears cookies.
- A generic **authenticated proxy** - `app/api/backend/[...path]/route.ts` - forwards any other request (`GET/POST/PATCH`) to `${EXPRESS_API_URL}/v1/<path>` with `Authorization: Bearer <qt_access>`. On a 401, it silently calls Express refresh using `qt_refresh`, rotates cookies, and retries once before giving up. Every team/client/profile/platform call from the UI goes through this one proxy - no hand-written route handler per backend endpoint.
- `getCurrentUser()` (server, cached per-request like today) reads the cookie, calls Express `/v1/me` server-side. Used by every layout for server-side role enforcement (`requireRole([...])`, replacing today's `requireUser`/`requirePermission`).
- Client-side `AuthProvider` gets `initialUser` from the server layout (as today) and exposes `signIn`, `signOut`, `user` - but talks to `/api/auth/*`, not `better-auth`.
- `middleware.ts` (new - none exists today): cheap cookie-presence check to bounce unauthenticated requests to `/login` before a page even renders. Real authorization still happens server-side in each layout - middleware is a fast UX redirect, not the security boundary.

**Removed:** `better-auth` + its Next route handler, `features/auth/demo/*`, `features/auth/lib/auth.ts` / `auth-client.ts`, the `AUTH_ADMIN_EMAILS`/`BETTER_AUTH_*`/`NEXT_PUBLIC_DEMO_MODE` env vars. `rbac/roles.ts` + `permissions.ts` get rewritten around the real `AccountRole` enum (`PLATFORM_OWNER | FIRM_ADMIN | FIRM_TEAM | FIRM_CLIENT`) instead of the demo `admin | user`.

## 2. Route structure

Three separate top-level areas instead of forcing 4 very different roles into one shared parallel-route shell:

```
/login                     staff login (Platform Owner / Firm Admin / Team - one form, role auto-resolved)
/client-login               client's 3-step login (email → password → OTP)
/onboard/[token]            public - client onboarding form
/unauthorized

/platform                   Platform Owner only
  /platform/firms            list + search/filter
  /platform/firms/new         onboarding form (business + owner + EIN/SSN/license/address)
  /platform/firms/[id]        detail (status, safe identity fields, suspend/activate)
  /platform/profile

/firm                       Firm Admin + Firm Team (shared shell, sections gated by role)
  /firm/dashboard
  /firm/team                 Admin only - list, create (shows one-time password), ban/unban, reset password
  /firm/team/[id]
  /firm/clients               Admin + Team - list, create, generate onboarding link
  /firm/clients/[id]
  /firm/profile

/portal                     Firm Client only
  /portal/dashboard
  /portal/profile
```

Each area's `layout.tsx` calls `requireRole([...])` server-side and redirects to `/unauthorized` (wrong role) or `/login`/`/client-login` (not authenticated) - same defense-in-depth pattern the template already uses, just re-pointed.

## 3. API client & data layer

- `src/libs/api-client.ts` - typed `apiFetch<T>(path, options)` hitting `/api/backend/<path>` (same-origin, cookies sent automatically). Parses the backend's `{ success, statusCode, message, data, errors }` envelope; throws a typed `ApiError` carrying `.message` and `.errors` (field-level) on failure.
- One tanstack-query hook file per feature area, e.g. `features/team/hooks/use-team.ts` (`useTeamMembers`, `useCreateTeamMember`, `useSetTeamStatus`, `useResetTeamPassword`), mirroring `features/clients`, `features/platform`, `features/profile`.
- A shared `useApiMutation` wrapper standardizes the success/error UX (next section) so individual components don't reimplement it.

## 4. Forms, validation, success/error UX

- Zod schemas per form under each feature's `schemas/` folder, mirrored from the backend's actual validation (`auth.validation.ts`, `team.validation.ts`, `client.validation.ts`, `platform.validation.ts`) so client and server agree - including the firm-onboarding form's nested `firm`/`owner`/`address` shape and the "EIN or SSN required" rule.
- `react-hook-form` + `@hookform/resolvers/zod` for every form (already a dependency).
- Consistent mutation outcome handling via `useApiMutation`:
  - **Success:** `toast.success(response.message)` - reuses the backend's own human-readable message ("Team member created - copy their password now...") rather than inventing new copy in two places.
  - **Field-level validation errors** (`error.errors`, path+message pairs from zod on the backend): mapped onto the matching `form.setError(path, { message })` so they render inline under the right field.
  - **Non-field errors** (wrong password, 403 forbidden, 409 conflict, etc.): `toast.error(error.message)`.
  - One-time secrets (temporary passwords, onboarding links) get a dedicated "copy to clipboard" result panel after success - not just a toast - since they're shown exactly once.
- Loading states: tanstack-query `isPending` disables submit buttons and shows a spinner (existing shadcn `Button` supports this pattern).

## 5. Theming - default white/teal

- `tokens.css` default palette swapped from the template's purple (`#5c4beb`) to a teal-based scheme: white backgrounds, teal primary/ring/sidebar-active, matching hover/active states, both light and dark variants. This becomes the product's default look.
- **Per-firm dynamic white-labeling** (reading each Firm's actual `FirmBranding.primaryColor` etc. and injecting it as CSS variables at runtime) is a separate feature from "what's our own default theme" - the schema already has `FirmBranding`, but there's no read endpoint yet. I'll ship the static teal/white default now and flag the dynamic version (small backend addition + a theme-injection provider) as a fast-follow, unless you want it pulled into this pass.

## 6. Build order

1. Remove better-auth + demo scaffolding; add `EXPRESS_API_URL` env var
2. `api-client.ts` + generic `/api/backend/[...path]` proxy + cookie-based `/api/auth/*` route handlers
3. `getCurrentUser()` / `requireRole()` / `AuthProvider` rewritten against the real API
4. `middleware.ts`
5. Teal/white theme tokens
6. `/login` (staff) + `/client-login` (3-step) + `/onboard/[token]` pages, forms wired end-to-end
7. `/platform` area: firms list, onboarding form, firm detail, status actions
8. `/firm` area: team management, client management + onboarding-link generation, dashboard
9. `/portal` area: client dashboard/profile
10. Shared `/profile` (all roles): view/update info, avatar upload, password change (hidden for Team, per backend rule)
11. Manual pass through every flow in the browser against the real running backend (mirroring the backend's own smoke test)

---

Say the word and I'll start on step 1.
