# Pixy Release Checklist

Use this checklist before promoting the consolidated Setup/Settings + Thread Support + multi-provider build to production.

## 1. Pre-deploy

- [ ] Back up the production MySQL database.
- [ ] Back up `PIXY_CREDENTIAL_ENCRYPTION_KEY` separately from the database backup.
- [ ] Confirm `NODE_ENV=production`.
- [ ] Confirm `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` point to the intended Pixy application.
- [ ] Confirm `DATABASE_URL` points to the intended production database.
- [ ] Confirm `OWNERS`, `PAYPAL_OWNER_ID`, and `VODAFONE_OWNER_ID` contain Discord user IDs only.
- [ ] Confirm no Discord token, provider API key, database password, backup, or encryption key is committed to the repository.
- [ ] Run `npm ci`.
- [ ] Run `npm run prisma:generate`.
- [ ] Run `npm run check`.
- [ ] Run `npm test` against the dedicated test database.

## 2. Database deployment

- [ ] Run `npm run prisma:migrate` (`prisma migrate deploy`).
- [ ] Do **not** run `prisma migrate dev` against production.
- [ ] Confirm the Phase 1 data-foundation migration is applied.
- [ ] Confirm existing single-category guilds retained their legacy category through `TicketSource` migration/fallback.
- [ ] Run `npm run prisma:seed` only when the deployment environment expects the repository seed data.

## 3. Slash-command sync

Startup bulk-replaces the command set in the configured Discord registration scope.

Expected public commands:

- `/pixy-setup`
- `/pixy-settings`
- `/pixy-billing`
- `/pixy-help`
- `/pixy-reset`

Verify that these legacy commands are no longer registered:

- `/pixy-admins`
- `/pixy-learn`
- `/pixy-mode`
- `/pixy-blacklist`
- `/pixy-clear`

All public Pixy slash commands are guild-only. They should not be offered in DMs.

## 4. Fresh-server onboarding smoke test

Use a test guild with no Pixy operational configuration.

- [ ] Run `/pixy-setup` as an Administrator.
- [ ] Confirm step 1 is **Ticket Sources**.
- [ ] Add at least two Category sources and verify both remain listed.
- [ ] Add at least one Thread Parent source and verify it remains listed with the correct type.
- [ ] Remove one source and confirm only the selected source is removed.
- [ ] Confirm the wizard does not move to AI automatically after the first source.
- [ ] Press **Next: AI Provider**.
- [ ] Confirm the provider selector shows **Groq**, **Google Gemini**, **Mistral**, and **OpenAI API**.
- [ ] Switch between providers and confirm the previous provider credential/model override is cleared instead of being reused.
- [ ] Confirm model controls stay unavailable until a valid credential is saved.
- [ ] Submit an invalid credential for each provider being tested and confirm setup remains on the AI step without storing it.
- [ ] Submit a valid dedicated test credential and confirm it is accepted, encrypted, and never displayed back.
- [ ] Verify the selected provider's default model works or verify/change an alternate model available to that account.
- [ ] Press Next and configure Human Support, or explicitly choose **Skip for Now**.
- [ ] Confirm the Trial starts only after onboarding completion.
- [ ] Re-run `/pixy-setup` and confirm it opens the Setup Dashboard instead of restarting onboarding.

## 5. AI provider runtime smoke test

Use dedicated non-production provider keys and do not paste them into tickets, Knowledge, logs, screenshots, or release notes.

For each available test account:

- [ ] **Groq** — connect the key, create a fresh ticket, send a normal support question, and confirm a valid reply.
- [ ] **Google Gemini** — connect the key, create a fresh ticket, send a normal support question, and confirm a valid reply.
- [ ] **Mistral** — connect the key, create a fresh ticket, send a normal support question, and confirm a valid reply.
- [ ] **OpenAI API** — connect the key, confirm the live setup probe passes, create a fresh ticket, send a normal support question, and confirm a valid reply.
- [ ] Confirm provider/model usage logs identify the selected provider correctly on successful responses.
- [ ] Trigger or simulate a provider error and confirm the usage log does not fall back to a Groq model when Google Gemini, Mistral, or OpenAI API is selected.
- [ ] Confirm a 429/rate-limit response uses Pixy's provider-busy user message rather than crashing the ticket handler.
- [ ] Confirm switching back to a provider requires that provider's own credential again.

## 6. Existing-server migration smoke test

Use a guild configured before the multi-source/onboarding changes.

- [ ] Confirm its existing ticket category still appears as a Ticket Source.
- [ ] Confirm existing billing dates/state are unchanged.
- [ ] Confirm its stored Groq credential still resolves through compatibility migration/fallback.
- [ ] Confirm `/pixy-setup` does not grant another Trial.
- [ ] Add a second Category and verify tickets under both Categories become eligible.

## 7. Knowledge smoke test

Knowledge is reusable AI context, not an exact FAQ lookup table.

- [ ] Open `/pixy-settings` → **Knowledge** and confirm the page explains that differently worded questions can use the same learned information.
- [ ] Add one Free-form note such as **Gold Advertising Package** containing price, duration, benefits, rules, and eligibility.
- [ ] Ask at least three differently worded questions about that package and confirm Pixy can answer using the same single note without requiring three stored FAQ entries.
- [ ] Add one Q&A fact and ask the same idea with different wording; confirm the example question does not need to match literally.
- [ ] Use **Quick Import** with multiple `Q:` / `A:` pairs and confirm all valid pairs are added.
- [ ] Repeat Quick Import with Arabic `س:` / `ج:` markers and confirm valid pairs are added.
- [ ] Confirm duplicate questions are skipped rather than stored twice.
- [ ] Confirm incomplete pairs are skipped rather than having missing content invented.
- [ ] Confirm the configured knowledge limit is respected during bulk import.

## 8. Channel-ticket runtime smoke test

- [ ] Create a new ticket channel under a configured Category after setup.
- [ ] Confirm Pixy tracks it and posts/reuses one control message.
- [ ] Ask a normal question and confirm one AI reply is generated.
- [ ] Pause AI from the ticket control and confirm automatic replies stop.
- [ ] Resume AI and confirm replies resume.
- [ ] Verify premium responses can use eligible guild Knowledge.
- [ ] Add an Excluded Ticket entry and confirm Pixy stops reading/replying in that ticket.
- [ ] Remove the exclusion and confirm the valid ticket is reconciled/reactivated.

## 9. Thread-ticket runtime smoke test

Run at least one Public Thread and, when the ticket system supports it, one Private Thread.

- [ ] Configure the direct parent as a **Thread Parent** Ticket Source.
- [ ] Create/open a new ticket thread under that parent.
- [ ] Confirm Pixy tracks the thread and posts/reuses a control message.
- [ ] Confirm AI replies work inside the thread.
- [ ] Confirm the control panel identifies Smart Overlay behavior.
- [ ] Confirm Close and Rename are not exposed in the Thread control panel.
- [ ] Confirm a stale/direct Close or Rename component attempt is rejected at execution time.
- [ ] Confirm Human Support handoff can complete without moving, renaming, closing, or deleting the Thread.
- [ ] Confirm an archived tracked Thread is not deleted from Pixy state merely because it is absent from the active-thread list.
- [ ] Confirm deleting the Discord Thread cleans up its Pixy ticket/exclusion records.
- [ ] For a Private Thread, confirm the ticket system grants Pixy access to the specific Thread.

## 10. Human Support smoke test

- [ ] Configure an escalation category.
- [ ] Confirm Pixy creates or reuses the notification channel when allowed.
- [ ] Add at least one support role route with a description.
- [ ] Trigger escalation from a channel ticket in Smart Overlay and confirm the ticket is not moved/renamed.
- [ ] Trigger escalation from a Thread and confirm the same non-destructive handoff invariant.
- [ ] Test a non-mentionable support role without `MentionEveryone` and confirm the handoff still succeeds with a non-pinging fallback.
- [ ] Confirm AI is paused after successful handoff.

## 11. Full Ticket Control smoke test

Run only in a dedicated test guild/category.

- [ ] Attempt to enable Full Ticket Control without required setup/permissions and confirm it is rejected with specific preflight issues.
- [ ] Fix the reported issues and enable Full Ticket Control for channel-based tickets.
- [ ] Confirm validated Rename works only for channel tickets.
- [ ] Confirm Close requires explicit current-message close intent.
- [ ] Confirm channel escalation can perform its allowed lifecycle changes and rolls back partial mutations when a later required step fails.
- [ ] Confirm Thread tickets in the same guild remain Smart Overlay-only.

## 12. Billing and entitlement smoke test

- [ ] Check Trial behavior.
- [ ] Check active Pro behavior.
- [ ] Check Partner behavior and stored fallback state.
- [ ] Check Expired behavior: generic AI + AI On/Off still available, Knowledge injection/additions and agent actions locked.
- [ ] Confirm stale ticket controls cannot bypass an entitlement downgrade.
- [ ] Confirm billing mutations refresh open controls after commit on a best-effort basis.

## 13. Permission model

Baseline Category ticket operation should work with effective:

- View Channel
- Send Messages
- Read Message History

Thread Parent operation should work with effective:

- View Channel
- Send Messages in Threads
- Read Message History

Additional notes:

- [ ] Do not require Administrator for normal production operation.
- [ ] Do not require `MentionEveryone` for Human Support to function.
- [ ] Do not require broad `Manage Threads` merely to support Private Threads; prefer adding Pixy to each private ticket Thread.
- [ ] Full Ticket Control may require Manage Channels / Manage Roles where its preflight explicitly reports them.

## 14. Reset smoke test

Use `/pixy-reset` only in a disposable test guild.

- [ ] Confirm the command is Administrator-only.
- [ ] Confirm it clearly lists the operational data that will be deleted.
- [ ] Cancel once and verify no data changes.
- [ ] Confirm once and verify operational configuration, Ticket Sources, Knowledge, routes, exclusions, safety settings, credential config, ticket records, and detailed usage logs are deleted.
- [ ] Confirm Discord channels/threads/categories/roles are not deleted.
- [ ] Confirm Trial/Pro/Partner continuity and billing audit rows are retained.
- [ ] Reconfigure and confirm another Trial is not granted.

## 15. Fresh-install end-to-end pass

Before contacting partners or moving the build to the production VPS, repeat the whole product flow once in a completely new disposable Discord server with no prior Pixy records:

- [ ] Invite Pixy with the intended production permission set.
- [ ] Complete onboarding from zero.
- [ ] Configure at least one Category source and one Thread Parent source.
- [ ] Connect the provider intended for this test and verify a real AI reply.
- [ ] Add semantic Knowledge and verify paraphrased questions use it.
- [ ] Test channel tickets, public/private Threads where possible, pause/resume, Human Support, exclusions, Safety, and `/pixy-help`.
- [ ] Verify `/pixy-billing` and Trial timing.
- [ ] Run the safe cancellation path for `/pixy-reset`; use the destructive path only if this server is disposable and billing-continuity behavior is also being tested.
- [ ] Review bot logs and AI usage rows for errors, wrong provider/model attribution, duplicate control panels, or secrets.
- [ ] Only treat the build as partner-ready after this pass is clean.

## 16. Final rollout

- [ ] Start Pixy and confirm startup reports exactly five public slash commands.
- [ ] Confirm startup reconciliation completes without repeated failures.
- [ ] Watch logs during one channel ticket and one Thread ticket interaction.
- [ ] Confirm no credential, token, private admin reason, or unexpected user content is logged as a secret.
- [ ] Keep the database + encryption-key backup until the new build has been stable through the verification window.
