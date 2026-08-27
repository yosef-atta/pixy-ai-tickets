# ChatGPT Workspace Agent bridge (Beta)

Pixy can use a server-owned published ChatGPT Workspace Agent as its AI provider. This path is separate from the OpenAI API provider: it uses the Workspace Agents API to trigger the server administrator's own Workspace Agent, then receives the final reply or validated ticket-action request through Pixy's MCP endpoint.

This integration is intentionally marked **Beta** because Workspace Agent API run tracking is currently beta and the trigger API does not return the agent's response body directly.

## What the server administrator needs

- A ChatGPT workspace where Workspace Agents and personal Workspace Agent access tokens are enabled by the workspace admin.
- A published Workspace Agent with an **API** channel and an API Trigger ID in the `agtch_...` format.
- A Workspace Agent access token with the **Workspace Agents** scope.
- Pixy's public MCP URL, normally `https://<pixy-host>/mcp`.

The Workspace Agent chooses its model inside ChatGPT. Pixy does not expose model selection for this provider.

## Pixy operator deployment

Set these optional environment variables on the Pixy host:

```env
PIXY_PUBLIC_BASE_URL=https://pixy.example.com
PIXY_MCP_PORT=3100
```

`PIXY_PUBLIC_BASE_URL` must be public HTTPS in production. When it is absent, Pixy continues to run normally but the Workspace Agent bridge stays disabled.

Pixy binds the MCP listener to `127.0.0.1` and expects the public web server/reverse proxy to forward `/mcp` to `PIXY_MCP_PORT`. Do not expose the raw local port directly to the internet when a reverse proxy is available.

Example Nginx location inside the HTTPS virtual host:

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3100/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

The same Pixy process also exposes `GET /health` on the local MCP listener for host-level health checks. Only `/mcp` needs to be publicly routed for the Workspace Agent integration.

## Configure the Workspace Agent

1. In ChatGPT, publish the Workspace Agent with an **API** channel and copy its `agtch_...` API Trigger ID.
2. Add Pixy's MCP endpoint as a custom MCP server for the agent and make these Pixy tools available:
   - `send_ticket_reply`
   - `close_ticket`
   - `rename_ticket`
   - `escalate_ticket`
3. The trigger input already tells the agent to finish each Pixy request with exactly one delivery tool. A normal answer uses `send_ticket_reply`. A ticket action uses the matching action tool only when the supplied Pixy server context explicitly allows it and the user's request satisfies Pixy's normal action policy.
4. Create a Workspace Agent access token with the Workspace Agents scope.
5. In Discord run `/pixy-setup` → **AI Provider** → **ChatGPT Workspace Agent (Beta)** → **Connect Workspace Agent**.
6. Enter the Workspace Agent access token and the `agtch_...` API Trigger ID.

Pixy does not save the connection immediately. It first runs a real end-to-end test: Pixy triggers the Workspace Agent and waits for that agent to call one Pixy MCP delivery tool through the bridge. Only after the round trip succeeds are the access token and trigger ID encrypted and saved.

## Runtime flow

```text
Discord ticket message
        ↓
Pixy builds the normal ticket + Knowledge + action-policy context
        ↓
POST api.chatgpt.com/v1/workspace_agents/{agtch_id}/trigger
        ↓
ChatGPT Workspace Agent runs
        ↓
Exactly one Pixy MCP delivery tool
        ↓
normal reply OR action_request
        ↓
Existing Pixy parsing + entitlement + settings + safety + permission validation
        ↓
Existing Pixy reply/action executor
        ↓
Discord ticket
```

The trigger request uses a unique idempotency key and asks for beta run-status metadata when available. Pixy can use a returned `apirun_...` ID to detect a failed run or a run that completed without calling the MCP bridge. The Workspace Agents API still does not return the final agent result itself, so one MCP callback is required.

## Discord Super Powers

Workspace Agent servers keep the same Pixy ticket capabilities as the other AI providers. The MCP bridge exposes the three existing safe Pixy action requests:

- `close_ticket(delivery_token, reply)`
- `rename_ticket(delivery_token, name, reply)`
- `escalate_ticket(delivery_token, role_id, reason, name?, reply)`

These tools **do not execute Discord mutations directly from ChatGPT**. They serialize the Workspace Agent's request into the same `action_request` format used by Pixy's normal provider pipeline. The existing Discord-side code then rechecks everything before execution.

That means using ChatGPT Workspace Agent does not bypass or weaken the bot's settings:

- the guild must currently have premium agent-action entitlement,
- Agent Actions must be enabled,
- the requested feature must be valid for the current ticket surface,
- Close still requires explicit close intent in the user's current message,
- Rename still passes Pixy's name sanitization and safety rules,
- Close/Rename remain forbidden for Thread tickets,
- Escalate must use one configured Human Support role ID and valid route,
- Discord permissions and current ticket state are checked again at execution time,
- stale or malicious tool requests can still be rejected by Pixy.

Thread tickets therefore keep the same invariant as every other provider: Smart Overlay only for lifecycle behavior. Workspace Agent can escalate a Thread through the safe Human Support handoff, but cannot close or rename the Thread.

## Security boundary

The MCP surface is intentionally limited to one normal reply tool plus Pixy's three existing validated ticket actions. It does **not** expose raw Discord administration such as ban, kick, timeout, arbitrary role management, arbitrary channel creation/deletion, permission editing, or arbitrary messaging.

Each trigger creates a cryptographically random delivery capability token. Pixy:

- sends the plaintext token only inside that trigger input,
- stores only a SHA-256 hash in MySQL,
- accepts the token once across **all** four delivery tools,
- gives it a short expiry,
- binds the pending delivery to one guild request,
- redacts the token if a model accidentally includes it in delivered text,
- does not intentionally log the token.

Whichever reply/action tool successfully consumes the token first wins. A later tool call with the same token cannot replace the accepted result or create a second Discord action.

The MCP tools advertise `noauth` transport because ChatGPT custom MCP cannot be configured with an arbitrary shared API-key scheme. Authorization for the callback is enforced by the short-lived one-time delivery capability itself. A future bridge version can move to an OAuth or mTLS transport boundary without changing the ticket-provider contract.

The Workspace Agent access token and API Trigger ID are serialized as one Pixy provider credential and encrypted with `PIXY_CREDENTIAL_ENCRYPTION_KEY`. They are never displayed after saving.

## Failure behavior

Pixy does not silently fall back to another provider. The Workspace Agent connection fails safely when:

- the access token is rejected,
- the API Trigger ID is invalid,
- the trigger request is rate limited or fails,
- the Workspace Agent run reports failure,
- the agent completes without calling a Pixy MCP delivery tool,
- the one-time delivery token expires,
- the MCP callback contains an invalid/expired token.

An action request can additionally be rejected by Pixy's normal Discord-side validator when the plan, guild settings, user intent, ticket surface, support route, safety policy, or permissions do not permit it.

During setup the connection is not saved when the round trip fails. During a ticket request the existing Pixy provider-error path is used, and the guild can switch to another configured provider through `/pixy-setup`.

## Reset and retention

Workspace Agent pending/delivered bridge rows are operational data. `/pixy-reset` and guild removal delete them along with the guild's encrypted AI provider credential. Billing continuity remains governed by Pixy's existing reset rules.
