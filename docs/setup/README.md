# Pixy AI Tickets setup guides

These guides apply only to the public multi-server **Pixy AI Tickets** bot:

- [Windows quick start](WINDOWS.md) — PowerShell and Docker Desktop
- [Ubuntu quick start](UBUNTU.md) — Docker Engine and Docker Compose
- [Troubleshooting](TROUBLESHOOTING.md) — Docker, MySQL, Prisma, command sync, AI credentials, Thread tickets, and permissions
- [Production release checklist](../RELEASE_CHECKLIST.md) — migrations, command cleanup, channel/thread smoke tests, billing, reset, and rollout checks

## Setup order

1. Clone `riku-rio/pixy-ai-tickets` or pull the intended deployment branch.
2. Copy `.env.example` to `.env` and `.env.docker.example` to `.env.docker`.
3. Fill the Discord, billing-owner, database, and encryption values.
4. Install dependencies with `npm ci`.
5. Start MySQL with `npm run db:up` for local development.
6. Run `npm run prisma:generate`.
7. Run `npm run prisma:migrate`.
8. Run `npm run prisma:seed` when the environment expects repository seed data.
9. Run `npm test` against the dedicated test database before deployment.
10. Start Pixy AI Tickets with `npm start` or `node .`.

Pixy AI Tickets uses local MySQL host port `3306` by default. Production deployments should use `prisma migrate deploy` through `npm run prisma:migrate`, not `prisma migrate dev`.

Startup synchronizes Pixy's consolidated public slash-command set. See the release checklist before promoting a build so legacy commands, Ticket Sources, Thread Support, Human Support, billing, and reset behavior are verified together.

Pixy System is a separate bot with its own setup documentation in the [`pixy-system`](https://github.com/riku-rio/pixy-system) repository.
