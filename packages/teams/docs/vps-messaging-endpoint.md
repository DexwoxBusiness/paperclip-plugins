# Public messaging endpoint (VPS runbook)

Teams' Bot Connector delivers every inbound activity by **POSTing to a public HTTPS URL**.
In Paperclip that URL is the plugin webhook route:

```
https://<public-host>/api/plugins/dexwox.teams-chatos/webhooks/bot-messages
```

There is **no Paperclip change** involved — this is the same plugin-webhook mechanism the
Slack and Discord plugins use. The only work is operational: front the Paperclip host with a
reverse proxy that terminates public HTTPS with a valid CA certificate and forwards this one
route to the Paperclip process. The exact URL to paste into Azure is shown on the plugin's
settings page (the `messaging-endpoint` data surface) once `paperclipBaseUrl` is set.

> The messaging endpoint shares the public origin with `paperclipBaseUrl` (Paperclip serves
> its UI and `/api` from one server, so deep links, the approval REST calls, and this endpoint
> are the same host). If your API is exposed on a different origin than the UI, point the proxy
> below at the API host and keep `paperclipBaseUrl` set to the public origin that serves `/api`.

## 1. DNS

Create a record for the public host pointing at the VPS:

```
teams-bot.example.com.   A     <VPS-public-IPv4>
teams-bot.example.com.   AAAA  <VPS-public-IPv6>   # only if you serve IPv6
```

## 2. Reverse proxy + TLS

Expose **only** the bot messaging route publicly; keep the rest of the Paperclip API/UI on
the loopback interface. Assume Paperclip listens on `127.0.0.1:3100` (adjust to your port).

### Option A — Caddy (recommended: automatic valid cert)

Caddy auto-provisions and renews a Let's Encrypt certificate over ACME, which satisfies the
"valid, publicly trusted cert (no self-signed)" requirement with the least effort.

```caddyfile
teams-bot.example.com {
    # Automatic HTTPS (Let's Encrypt) — public CA, auto-renewed.
    #
    # Wrap in `route` so directives run in WRITTEN order. Caddy's default directive order
    # sorts `respond` BEFORE `reverse_proxy`, so a matcher-less `respond 404` would answer
    # every request (including the webhook path) before the proxy could — breaking delivery.
    # Inside `route`, the path-matched reverse_proxy runs first and only non-webhook paths
    # fall through to the 404.
    route {
        reverse_proxy /api/plugins/dexwox.teams-chatos/webhooks/bot-messages 127.0.0.1:3100 {
            header_up X-Forwarded-Proto https
        }
        # Nothing else is served publicly.
        respond 404
    }
}
```

Caddy forwards the `Host` and `Authorization` headers and the request body verbatim by
default — the inbound JWT and raw body arrive intact.

### Option B — nginx + certbot

```nginx
# HTTP: ACME challenge + redirect to HTTPS.
server {
    listen 80;
    server_name teams-bot.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;
    server_name teams-bot.example.com;

    # Public CA cert (Let's Encrypt). NEVER a self-signed cert — the Bot Connector
    # validates the chain and refuses to deliver otherwise.
    ssl_certificate     /etc/letsencrypt/live/teams-bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/teams-bot.example.com/privkey.pem;

    # Exact-match: expose ONLY the messaging route (least exposure).
    location = /api/plugins/dexwox.teams-chatos/webhooks/bot-messages {
        proxy_pass http://127.0.0.1:3100;   # request URI is forwarded unchanged

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Do NOT strip or rewrite the Authorization header — the Bot Framework JWT rides
        # in it and the worker validates it. Pass the body through so the host records the
        # exact bytes.
        proxy_request_buffering off;
        client_max_body_size 4m;   # Teams activities incl. small attachments
        proxy_read_timeout 30s;    # a message activity is processed quickly
    }
}
```

Issue and auto-renew the certificate:

```bash
certbot certonly --webroot -w /var/www/certbot -d teams-bot.example.com
# certbot installs a systemd timer / cron entry that renews automatically.
```

## 3. Point Azure at the endpoint

Azure Bot resource → **Configuration → Messaging endpoint**:

```
https://teams-bot.example.com/api/plugins/dexwox.teams-chatos/webhooks/bot-messages
```

Use the exact value from the plugin settings page (`messaging-endpoint` surface) so the
`pluginId`/`endpointKey` match the registered plugin. This URL is **static** — it survives
Paperclip restarts with no re-provisioning (it is derived from the plugin id + endpoint key,
not allocated per run). Only change it if you change the public host or the plugin id.

## 4. Verify

1. **Host exposure/version.** Before pointing Teams at it, run `paperclipai plugin target`
   — it prints the resolved API URL plus the server's status, version, `deploymentMode`, and
   `deploymentExposure`. A private/unexposed host or a stale server version is the most common
   cause of "Teams can't reach the bot" that looks like a plugin bug but isn't. Expected fields
   to check:
   - `apiUrl` — resolves to the public `https://<public-host>` you configured above.
   - `status` — `ok`/ready.
   - `version` — ≥ the version this plugin targets (an older host is a frequent false "bug").
   - `deploymentExposure` — indicates public reachability; a `private`/`internal`/`local`
     value means the host is not internet-reachable and Teams will not be able to deliver.
   - `deploymentMode` — `local_trusted` vs a production mode (affects secret-ref resolution).

   The plugin also surfaces a config-level check: the settings page (`messaging-endpoint`
   data surface) flags a `paperclipBaseUrl` that is empty, non-HTTPS, or non-publicly-routable
   before you ever reach the `plugin target` step.

2. **Plugin installed + ready.** The host route requires the plugin to be installed, in
   `ready` state, holding the `webhooks.receive` capability, with the `bot-messages` endpoint
   declared. Otherwise it returns `400`/`404` before the worker runs. Confirm the plugin is
   installed first.

3. **TLS + auth enforcement from outside** (no `-k`, so an invalid/self-signed cert fails just
   like it does for the Bot Connector):

   ```bash
   curl -i -X POST \
     -H 'content-type: application/json' -d '{}' \
     https://teams-bot.example.com/api/plugins/dexwox.teams-chatos/webhooks/bot-messages
   ```

   Expected: an **auth rejection**, i.e. `HTTP 502 {"status":"failed","error":"unauthorized"}`.
   This is correct — the request has no Bot Framework token, so the worker rejects it and the
   host maps the throw to a 502 with a **generic** message (no stack traces or internals). What
   each other result means:
   - `200` → auth is not being enforced (misconfiguration — investigate).
   - `404` → the plugin isn't installed/ready, or the path/`endpointKey` is wrong.
   - a TLS error → the certificate is missing, self-signed, or the chain is incomplete.
   - a connection timeout → DNS/firewall/proxy isn't routing to the Paperclip port.

4. **End to end.** Message the bot in Teams (or trigger an approval card). The activity should
   appear in the plugin's webhook deliveries and the bot should respond via the Bot Connector.

## Notes

- **Why 502 and not 401/403 on rejection.** The plugin `onWebhook` cannot set the HTTP status
  or return a body (the host returns a fixed `200` on success / `502` on a thrown error). An
  auth rejection therefore surfaces as a clean-message `502` rather than the Bot Framework
  spec's `403`. This is a host limitation (a proper `403` would require a change in the Paperclip
  host); it does not affect functionality — the call is still rejected and nothing is processed.
- **Replies go via the Bot Connector.** Because the webhook response body is discarded, the bot
  never answers inline; it replies with a proactive/`updateActivity` call. This is why
  interactive approvals use `Action.Submit` (a normal message activity) rather than
  `Action.Execute` Universal Actions (which require an inline invoke response). Microsoft's docs
  confirm `Action.Submit` posts a `type:"message"` activity that needs no inline response, and
  that Teams drives its client feedback off the bot's HTTP status (host `200` → "Your response
  was sent to the app"; `502` → "Something went wrong, Try again.").
