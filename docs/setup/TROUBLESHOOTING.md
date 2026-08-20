# Pixy AI Tickets setup troubleshooting

## Docker is unavailable

Check Docker and Docker Compose:

```powershell
docker version
docker compose version
```

On Windows, start Docker Desktop. On Ubuntu, run:

```bash
sudo systemctl enable --now docker
```

## Port 3306 is already in use

Pixy AI Tickets binds its bundled MySQL service to `127.0.0.1:3306`.

Inspect active containers:

```powershell
docker ps
```

Stop the database from the Pixy AI Tickets directory when it is no longer needed:

```powershell
npm run db:down
```

Do not change only `DATABASE_URL`. A host-port change must also be reflected in `docker-compose.yml`.

## Prisma cannot connect to MySQL

Confirm that:

- `npm run db:up` completed successfully.
- The MySQL container is healthy in `docker ps`.
- The username, password, and database name in `.env` match `.env.docker`.
- `DATABASE_URL` uses host port `3306` for the bundled local database.
- Special characters in the database password are URL-encoded in `DATABASE_URL`.

Then retry in order:

```powershell
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

## Environment files already exist

Avoid overwriting configured secrets. On Windows:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path .env.docker)) { Copy-Item .env.docker.example .env.docker }
```

On Ubuntu:

```bash
[ -f .env ] || cp .env.example .env
[ -f .env.docker ] || cp .env.docker.example .env.docker
```

## Discord slash commands are not visible or old commands are still visible

Pixy bulk-replaces the configured Discord application-command scope during startup.

Expected public commands are:

- `/pixy-setup`
- `/pixy-settings`
- `/pixy-billing`
- `/pixy-help`
- `/pixy-reset`

Legacy `/pixy-admins`, `/pixy-learn`, `/pixy-mode`, `/pixy-blacklist`, and `/pixy-clear` should disappear after the new command set has synchronized and Discord has propagated the update.

Confirm that:

- the bot startup reached the command-sync log line,
- `DISCORD_CLIENT_ID` belongs to the same application as `DISCORD_TOKEN`,
- the application was invited with the `bot` and `applications.commands` scopes,
- any configured development guild ID points to the guild where you are testing.

## Stored AI-provider credentials cannot be decrypted

Pixy AI Tickets requires the same stable `PIXY_CREDENTIAL_ENCRYPTION_KEY` across restarts and deployments. A database backup without the matching key cannot recover encrypted guild credentials.

Restore the correct encryption key or replace the affected guild credential through `/pixy-setup` → **AI Provider**.

## A Thread ticket is not detected

Confirm that the Thread's **direct parent** is configured in `/pixy-setup` as a **Thread Parent** Ticket Source.

The parent needs effective:

- View Channel
- Send Messages in Threads
- Read Message History

For a Private Thread, Pixy also needs access to that specific Thread. Prefer having the ticket system add Pixy to the private ticket Thread instead of granting broad Manage Threads permission.

## Full Ticket Control will not enable

This is usually a preflight failure, not a crash. Read the exact issue shown by `/pixy-settings` → **Ticket Behavior** and repair the reported Ticket Source, Human Support configuration, role, or Discord permission.

Thread tickets intentionally remain Smart Overlay-only even when Full Ticket Control is enabled for channel tickets.

## Clean local restart

A normal restart preserves database data:

```powershell
npm run db:down
npm run db:up
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm start
```

Use `npm run db:clear -- --confirm` only when intentionally deleting all application rows. It is destructive and is not a normal troubleshooting step.

Use `/pixy-reset` only when intentionally resetting one guild's operational Pixy data while retaining its billing continuity/audit history.
