# Pixy AI Tickets 🤖

Pixy AI Tickets is a public, multi-server Discord AI support assistant that works alongside an existing ticket system instead of replacing it. It supports channel-based tickets, ticket threads, guild-scoped knowledge, safe human escalation, plan-aware controls, encrypted per-server AI credentials, and manually administered Trial, Pro, and Partner plans.

This repository is public so Discord, partners, and collaborators can inspect the implementation and policies. Source availability does **not** mean the project is Open Source or grant rights beyond the repository's applicable terms.

## Product model

Pixy has two ticket behaviors:

- **Smart Overlay** — recommended when another ticket bot owns the lifecycle. Pixy answers questions, can pause/resume AI, and can hand a ticket to Human Support without closing, renaming, moving, or deleting it.
- **Full Ticket Control** — available for channel-based tickets after a permission/setup preflight. Pixy may expose validated Close, Rename, and Escalation actions according to server settings and plan entitlement.

**Thread tickets always use Smart Overlay for lifecycle safety**, even when channel tickets in the same server use Full Ticket Control.

## Plans

The effective plan is resolved at request time with this priority:

`Partner > active Pro > active Trial > Expired`

- **Trial** — one seven-day premium Trial started only after the first successful onboarding is completed.
- **Pro** — time-limited premium entitlement activated or extended manually by a Pixy owner.
- **Partner** — premium entitlement without an expiry; stored Pro or Trial remains underneath as fallback state.
- **Expired** — generic AI replies and ticket AI On/Off remain available, while learned AI context, new knowledge additions, and validated agent ticket actions are locked.

Resetting Pixy, removing/reinviting the bot, or configuring it again does not create another Trial.

## Main features

- AI replies inside configured ticket channels and ticket threads
- Multiple Ticket Sources per guild
- Category sources for channel-based tickets
- Thread Parent sources for ticket threads under text, announcement, forum, or media channels
- Guild-scoped semantic Knowledge with Q&A facts, free-form topics, and Quick Import
- Smart Overlay and Full Ticket Control operating modes
- Validated close, rename, and human-escalation actions for supported channel tickets
- Safe overlay handoff for Thread tickets
- Support-role routing and escalation notifications
- Non-mentionable role fallback: handoff still succeeds even when Pixy cannot ping the role
- Ticket-level AI pause/resume controls
- Per-ticket exclusions for tracked channels or threads
- Built-in and guild-specific safety terms with allow exceptions
- Selectable Groq, Google Gemini, Mistral, and OpenAI API providers with encrypted guild credentials
- Plan-aware controls and execution-time entitlement checks
- Guild-isolated AI usage logs and operational reset
- Manual Trial, Pro, and Partner billing with transactional audit records

## First-run setup

Run `/pixy-setup` as a server administrator. The first run is a guided three-step onboarding flow.

### 1. Ticket Sources

Add every place where the existing ticket system creates tickets.

- **Category** — Pixy tracks normal text ticket channels created directly inside that category.
- **Thread Parent** — Pixy tracks ticket threads created directly under the selected text, announcement, forum, or media channel.

A server can configure multiple Categories, multiple Thread Parents, or both. The admin stays on this step until all required sources are added, then presses **Next: AI Provider**.

### 2. AI Provider

Choose one of the providers exposed in setup:

- **Groq**
- **Google Gemini**
- **Mistral**
- **OpenAI API**

The guild supplies its own API key for the selected provider. Pixy runs provider-specific validation plus a small live generation probe before saving the credential encrypted, and the saved secret is never displayed back to users. Live validation failures are surfaced directly in AI Provider setup and Setup Health.

OpenAI API uses the Responses API with `gpt-5.6-luna` as Pixy's default OpenAI model for cost-sensitive, high-volume ticket support. Servers can change the model after connecting a valid OpenAI API key.

Each provider has a default model that is usable immediately after a valid credential is saved. **Change Model** verifies an alternate model against the connected provider account and runs the same live generation check before saving it.

Switching providers clears the previous provider credential and model override so a credential from one provider cannot accidentally be reused with another provider.

### 3. Human Support

Human Support is recommended but optional.

The admin can configure:

- an escalation category,
- Pixy's escalation notification channel,
- one or more support-role routes with descriptions.

Or choose **Skip for Now**.

The one-time Trial starts only when onboarding successfully completes. Re-running `/pixy-setup` after that opens the editable **Setup Dashboard** instead of restarting onboarding.

## Public slash commands

Pixy's public command surface is intentionally small:

- `/pixy-setup` — first-run onboarding, then Ticket Sources, AI Provider, and Human Support management
- `/pixy-settings` — Ticket Behavior, Knowledge, Safety, and Excluded Tickets
- `/pixy-billing` — plan status, remaining time, capability availability, and manual activation/renewal instructions
- `/pixy-help` — interactive help for setup, Threads, AI, billing, features, commands, and troubleshooting
- `/pixy-reset` — administrator-only destructive reset of Pixy's operational guild data while retaining billing continuity/audit records

Legacy `/pixy-admins`, `/pixy-learn`, `/pixy-mode`, `/pixy-blacklist`, and `/pixy-clear` commands are no longer part of the public command surface. Their useful workflows were consolidated into Setup/Settings, while the destructive reset was renamed to `/pixy-reset` for clarity.

The startup command sync uses Discord's bulk command replacement, so deploying this version removes stale legacy application commands from the target registration scope.

## `/pixy-settings`

### Ticket Behavior

- AI Replies
- Smart Overlay / Full Ticket Control preset
- Close Ticket
- Rename Ticket
- Human Escalation
- Agent Actions

Full Ticket Control runs a guild permission/setup preflight before it can be enabled. Thread tickets remain Smart Overlay regardless of the guild's channel-ticket mode.

### Knowledge

Knowledge is reusable AI context, **not an exact FAQ lookup table**. Q&A is simply one convenient way to teach Pixy a fact: the stored question is example wording, and a future user can ask the same idea in different words.

For broader topics such as an advertising package, pricing plan, server policy, product rules, or eligibility details, a single **Free-form** item can hold the whole topic. For example, one `Gold Advertising Package` note can contain its price, duration, benefits, and rules, and Pixy can use that same note to answer multiple related questions.

Admins can:

- add a Q&A fact,
- add a Free-form topic,
- use **Quick Import** to paste several `Q:` / `A:` pairs at once (Arabic `س:` / `ج:` markers are also accepted),
- list and delete individual entries,
- clear the guild's Knowledge.

Existing knowledge can still be managed after expiry, but new additions and AI injection require Trial, Pro, or Partner entitlement.

### Safety

Admins can manage server-specific blocked terms and deliberate allow exceptions for false positives.

### Excluded Tickets

Admins can exclude an individual tracked channel or thread from Pixy without removing the entire Ticket Source, optionally storing a private admin reason. Removing the exclusion asks Pixy to reconcile and reactivate the ticket if it is still eligible.

## Thread support

Pixy supports:

- Public Threads
- Private Threads when Pixy has access to that specific thread
- Announcement Threads

Thread Parent Ticket Sources can be text, announcement, forum, or media channels.

### Private Threads

Prefer having the existing ticket system add Pixy to each private ticket thread. Pixy does not require broad `Manage Threads` permission by default because that permission is intentionally more powerful than normal Smart Overlay operation needs.

### Thread safety invariant

Pixy never performs lifecycle mutations on Thread tickets. Close and Rename are removed from the Thread control panel and are also rejected at execution time if a stale component or request tries to invoke them.

Human escalation on a Thread is an overlay handoff: Pixy sends the notification, stores the escalation state, pauses automatic AI replies, and leaves the Thread itself in place.

## Discord permissions

The production target is scoped permissions rather than Administrator.

### Baseline channel-ticket operation

For configured Category sources, Pixy needs the effective ability to:

- View Channel
- Send Messages
- Read Message History

### Thread Parent operation

For configured Thread Parent sources, Pixy needs:

- View Channel
- Send Messages in Threads
- Read Message History

Private Threads additionally require Pixy to have access to the specific Thread.

### Full Ticket Control for channel tickets

When Full Ticket Control is enabled for normal channel tickets, Pixy additionally preflights the permissions needed for lifecycle changes, including Manage Channels and Manage Roles / permission overwrites where applicable.

### Human Support

If Pixy's notification channel does not exist, creating it requires Manage Channels. Full-control escalation of a channel ticket also needs the destination/category permissions checked by the preflight.

`Mention @everyone, @here, and All Roles` is **not required** for escalation to function. If a configured support role is not mentionable and Pixy cannot ping it, the handoff still completes and the notification shows the role name without a ping.

## Billing behavior

Payment choices in `/pixy-billing` only show a configured Discord owner mention and manual DM instructions. Pixy never automatically DMs the owner, collects money, activates a plan, or stores PayPal/Vodafone payment credentials.

### Trial, Pro, and Partner

Premium entitlement can use:

- learned Q&A/free-form context in AI prompts,
- new learned-knowledge additions,
- validated AI-requested ticket actions where the ticket surface supports them,
- premium ticket controls according to guild settings.

### Expired

Expired mode intentionally keeps useful assistant behavior:

- generic AI replies remain available with a valid configured provider credential,
- ticket AI On/Off remains available,
- existing learned entries can still be listed, deleted, or cleared.

Expired mode blocks:

- learned knowledge injection into AI prompts,
- new knowledge additions,
- agent action schemas/execution,
- premium action controls.

Entitlement is checked again at execution time, so stale menus, buttons, modals, or direct component IDs cannot bypass expiration.

## Manual billing owner commands

Owner commands use the configured prefix, which is `^` in `.env.example`. Unauthorized users receive no response, usage hint, cooldown, or command-existence signal.

- `^help` — operator reference
- `^activate <guild-id>` — start 30 days of Pro from now
- `^resub <guild-id>` — add 30 days after current active Pro expiry
- `^custom <guild-id> <duration>` — extend active Pro or start from now
- `^deactivate <guild-id>` — end Pro immediately while preserving Trial/Partner state
- `^status <guild-id>` — show billing layers and latest audit event
- `^partner add <guild-id>` — enable Partner
- `^partner remove <guild-id>` — disable Partner and reveal fallback state
- `^partner list` — list active Partner guilds

Supported custom duration units are `d`, `w`, `m`, and `y` for days, seven-day weeks, 30-day months, and 365-day years. The resulting Pro expiry cannot be more than ten years from the mutation time.

Every owner billing mutation uses the repository's transactional billing flow with row locking, audit persistence, bounded write-conflict retry, and best-effort ticket-control refresh after commit. See `docs/payments/CONCURRENCY.md`.

## Safety behavior

- Ticket history and learned server content are treated as untrusted reference data, not system instructions.
- Expired prompts do not include learned data or agent-action schemas.
- AI-generated text cannot ping users, roles, `@everyone`, or `@here`.
- AI close requests require explicit close intent from the current user message.
- Thread lifecycle actions are denied regardless of stale controls.
- Human escalation uses safe notification and role-mention fallbacks.
- Billing output sanitizes guild names and disables allowed mentions.
- Passwords, Discord tokens, AI-provider keys, backup codes, and payment credentials must never be sent to payment owners or stored as learned content.

## Operational reset and data retention

`/pixy-reset` and guild removal delete operational guild data such as:

- Ticket Sources and setup state,
- learned knowledge,
- tracked tickets and exclusions,
- support routes,
- feature/safety settings,
- encrypted provider credentials,
- detailed AI usage logs.

They intentionally retain minimal billing continuity:

- Trial, Pro, and Partner dates/state in `GuildBilling`
- billing mutations and actors in `BillingEvent`

This preserves entitlement continuity, audit history, and repeat-Trial prevention after reset, removal, reinvitation, or reconfiguration.

The development command `npm run db:clear -- --confirm` is different: it clears all application tables, including billing tables, while preserving Prisma migration history.

## Tech stack

- Node.js 20+
- discord.js 14
- Prisma ORM 7
- MySQL 8.4 locally and in production
- Groq SDK for Groq plus native HTTPS integrations for Google Gemini, Mistral, and OpenAI API

## Environment variables

Create `.env` from `.env.example` and fill in the real values:

```env
NODE_ENV=production
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
PREFIX=^

OWNERS=
PAYPAL_OWNER_ID=
VODAFONE_OWNER_ID=

DATABASE_URL="mysql://pixy:pixy_local_password@127.0.0.1:3306/pixy"
PIXY_CREDENTIAL_ENCRYPTION_KEY=
```

`OWNERS` is a comma-separated list of Discord user IDs authorized for silent owner-only prefix commands. Payment-owner IDs are Discord contact targets only; they are not payment account identifiers.

`PIXY_CREDENTIAL_ENCRYPTION_KEY` must remain stable and be backed up separately from the database. A database backup without the matching key cannot recover encrypted guild provider credentials.

Never commit Discord tokens, provider API keys, production database credentials, backups, payment information, or encryption keys.

## Local development

Set `NODE_ENV=development`, configure `TEST_DATABASE_URL`, then:

```powershell
npm run db:up
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm test
npm start
```

Stop local databases with:

```powershell
npm run db:down
```

## Production deployment

```powershell
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm start
```

Startup synchronizes the public slash-command set before logging the bot in. Use `prisma migrate deploy` through `npm run prisma:migrate` in production; do not run `prisma migrate dev` against production.

Run the automated suite against the dedicated test database before deployment:

```powershell
npm test
```

See `docs/RELEASE_CHECKLIST.md` for the production smoke-test and rollout checklist.

## Quick-start guides

- [Windows quick start](docs/setup/WINDOWS.md)
- [Ubuntu quick start](docs/setup/UBUNTU.md)
- [Setup troubleshooting](docs/setup/TROUBLESHOOTING.md)
- [Setup guide index](docs/setup/README.md)

## Data handling

Pixy stores guild/channel/thread/role IDs, server-provided knowledge, feature and routing settings, encrypted provider credentials, ticket state, AI usage diagnostics, billing state/dates, and billing audit events. Ticket context is sent to the guild-configured AI provider when a response is requested. See `PRIVACY_POLICY.md` for retention, sharing, and deletion details.