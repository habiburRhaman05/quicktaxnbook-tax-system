# White-Label Plan - Firm Dashboard & Client Portal

Status: **Proposed - planning only, not started.** Round 2 (`ROUND_2_PLAN.md`) is the active work.

## Good news: the schema already expects this

Reading through `schema.prisma` again - this was designed with white-labeling in mind from day one:

- **`FirmBranding`** (already exists, unused so far): `displayName`, `logoFileId`, `faviconFileId`, `primaryColor`, `secondaryColor`, `accentColor`, `emailSenderName/Address/ReplyTo`, `portalWelcomeText`, `emailFooterHtml`, `customCss`.
- **`Firm.domain`** (added in Round 1): a requested vanity subdomain.
- **`FirmDomain`** (already exists, unused so far): for a firm's *own* custom top-level domain later (`portal.theirfirm.com`) - token verification, SSL status, the works.

So this round is mostly "build the API + UI on top of tables that already exist," not a schema redesign.

## Scope: now vs. later

**Now (Phase 1):**
- Logo upload (reuses the local-storage pattern already built for avatars)
- Primary/secondary/accent color pickers → injected as CSS variables at runtime
- Firm display name
- Subdomain (`firm-slug.quicktaxnbook365.com`) - the firm picks/changes their slug, subject to uniqueness (same check used at onboarding)

**Later (Phase 2, not this round - the schema is already ready for these, they just need building):**
- Custom top-level domains (`portal.theirfirm.com`) via `FirmDomain` - needs DNS verification + SSL provisioning, real infra work
- Favicon, portal welcome text, custom CSS, branded email sender identity/footer
- Firm-uploaded email templates

## The subdomain strategy

`quicktaxnbook365.com` stays the platform's own domain (marketing, Platform Owner). Each firm gets `{slug}.quicktaxnbook365.com`.

**How it works technically:** a `middleware.ts` addition reads the `Host` header. If it's `{slug}.quicktaxnbook365.com` and `{slug}` matches a real firm, the request gets **rewritten** (not redirected - invisible to the browser, URL bar stays clean) from `{slug}.quicktaxnbook365.com/dashboard` to the existing `/firm/{slug}/dashboard` route internally. Same for the client portal - `{slug}.quicktaxnbook365.com/client-login` etc.

This is additive on top of what's already built: the path-based routing (`/firm/{slug}/...`, `/client/{id}/...`) keeps working exactly as it does today; the subdomain is just a nicer front door that resolves to the same pages.

**Locally testable today, no DNS setup needed:** modern browsers resolve any `*.localhost` subdomain to `127.0.0.1` automatically - so `sunrise-tax.localhost:6767` will work in dev the moment the middleware logic exists, no `/etc/hosts` editing. In production it needs one wildcard DNS record (`*.quicktaxnbook365.com`) and a wildcard TLS cert, both standard and cheap (Vercel/Cloudflare handle this natively).

**One judgment call worth flagging:** should a firm be allowed to change their slug after onboarding (it's their subdomain, their bookmarked login links, etc.)? I'd allow it but treat it like a real "this changes URLs" action - confirm dialog, and old links simply 404 rather than silently redirecting forever. Flag if you'd rather slugs be fixed after creation.

## What client portal white-labeling means concretely

Same firm branding (logo, colors, name) applies when a *client* of that firm is logged in - a client should see their firm's identity, not the platform's. The branding fetch + CSS-variable injection wraps both the `/firm/{slug}` area layout and the `/client/{id}` area layout, keyed off whichever firm the logged-in user belongs to.

---

This stays parked here until Round 2 is done - starting on Round 2 now.
