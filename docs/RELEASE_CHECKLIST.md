# Pixy Release Checklist

Use this checklist before promoting the consolidated Setup/Settings + Thread Support build to production.

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
- [ ] Confirm Groq is shown directly while it is the only production provider.
- [ ] Confirm model controls stay unavailable until a valid credential is saved.
- [ ] Submit an invalid credential and confirm setup remains on the AI step without storing it.
- [ ] Submit a valid test credential and confirm it is accepted and never displayed back.
- [ ] Verify the default model works or verify/change an alternate model.
- [ ] Press Next and configure Human Support, or explicitly choose **Skip for Now**.
- [ ] Confirm the Trial starts only after onboarding completion.
- [ ] Re-run `/pixy-setup` and confirm it opens the Setup Dashboard instead of restarting onboarding.

## 5. Existing-server migration smoke test

Use a guild configured before the multi-source/onboarding changes.

- [ ] Confirm its existing ticket category still appears as a Ticket Source.
- [ ] Confirm existing billing dates/state are unchanged.
- [ ] Confirm its stored AI credential still resolves through compatibility migration/fallback.
- [ ] Confirm `/pixy-setup` does not grant another Trial.
- [ ] Add a second Category and verify tickets under both Categories become eligible.

## 6. Channel-ticket runtime smoke test

- [ ] Create a new ticket channel under a configured Category after setup.
- [ ] Confirm Pixy tracks it and posts/reuses one control message.
- [ ] Ask a normal question and confirm one AI reply is generated.
- [ ] Pause AI from the ticket control and confirm automatic replies stop.
- [ ] Resume AI and confirm replies resume.
- [ ] Add guild Knowledge and verify premium responses can use it.
- [ ] Add an Excluded Ticket entry and confirm Pixy stops reading/replying in that ticket.
- [ ] Remove the exclusion and confirm the valid ticket is reconciled/reactivated.

## 7. Thread-ticket runtime smoke test

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

## 8. Human Support smoke test

- [ ] Configure an escalation category.
- [ ] Confirm Pixy creates or reuses the notification channel when allowed.
- [ ] Add at least one support role route with a description.
- [ ] Trigger escalation from a channel ticket in Smart Overlay and confirm the ticket is not moved/renamed.
- [ ] Trigger escalation from a Thread and confirm the same non-destructive handoff invariant.
- [ ] Test a non-mentionable support role without `MentionEveryone` and confirm the handoff still succeeds with a non-pinging fallback.
- [ ] Confirm AI is paused after successful handoff.

## 9. Full Ticket Control smoke test

Run only in a dedicated test guild/category.

- [ ] Attempt to enable Full Ticket Control without required setup/permissions and confirm it is rejected with specific preflight issues.
- [ ] Fix the reported issues and enable Full Ticket Control for channel-based tickets.
- [ ] Confirm validated Rename works only for channel tickets.
- [ ] Confirm Close requires explicit current-message close intent.
- [ ] Confirm channel escalation can perform its allowed lifecycle changes and rolls back partial mutations when a later required step fails.
- [ ] Confirm Thread tickets in the same guild remain Smart Overlay-only.

## 10. Billing and entitlement smoke test

- [ ] Check Trial behavior.
- [ ] Check active Pro behavior.
- [ ] Check Partner behavior and stored fallback state.
- [ ] Check Expired behavior: generic AI + AI On/Off still available, Knowledge injection/additions and agent actions locked.
- [ ] Confirm stale ticket controls cannot bypass an entitlement downgrade.
- [ ] Confirm billing mutations refresh open controls after commit on a best-effort basis.

## 11. Permission model

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

## 12. Reset smoke test

Use `/pixy-reset` only in a disposable test guild.

- [ ] Confirm the command is Administrator-only.
- [ ] Confirm it clearly lists the operational data that will be deleted.
- [ ] Cancel once and verify no data changes.
- [ ] Confirm once and verify operational configuration, Ticket Sources, Knowledge, routes, exclusions, safety settings, credential config, ticket records, and detailed usage logs are deleted.
- [ ] Confirm Discord channels/threads/categories/roles are not deleted.
- [ ] Confirm Trial/Pro/Partner continuity and billing audit rows are retained.
- [ ] Reconfigure and confirm another Trial is not granted.

## 13. Final rollout

- [ ] Start Pixy and confirm startup reports exactly five public slash commands.
- [ ] Confirm startup reconciliation completes without repeated failures.
- [ ] Watch logs during one channel ticket and one Thread ticket interaction.
- [ ] Confirm no credential, token, private admin reason, or unexpected user content is logged as a secret.
- [ ] Keep the database + encryption-key backup until the new build has been stable through the verification window.
