# AutoCheck — Production Deployment (homework-shkola.ru)

Deployed 2026-07-27 on VDS `109.248.198.60` (Ubuntu 24.04). This document is the
source of truth for how the stack is wired together, day-to-day operations, and
emergency recovery.

## TLS status: issued and live (2026-07-28)

DNS for `homework-shkola.ru`/`www` was updated to point at `109.248.198.60` on
2026-07-28. Cert issued the same day via webroot validation, expires 2026-10-26.
nginx now runs the full HTTPS config (`deploy/nginx/nginx.conf`): port 80 redirects
to 443, TLS terminates on nginx with the Let's Encrypt cert.

The renewal cron job (`/etc/cron.d/autocheck`) handles renewal automatically
(twice-daily check, `certbot renew` + nginx reload) — no manual action needed
going forward.

## Architecture

```
Internet
   │  80/443
   ▼
[nginx]  container "autocheck-nginx" — TLS termination, reverse proxy
   │            (runs on nginx:alpine — needs root for port <1024 + reading
   │             root-owned Let's Encrypt private keys; worker processes still
   │             drop to the unprivileged "nginx" user, which is the real
   │             request-handling security boundary)
   ├── /                → frontend:8080   (static build, nginx-unprivileged, non-root)
   ├── /api/, /queues    → backend-api:3001 (Node, non-root)
   └── /api/events (SSE) → backend-api:3001 (buffering off)

backend-api / backend-worker (same image, different command)
   ├── postgres  (pgvector/pgvector:pg16, internal-only, not published to host)
   └── redis     (redis:7-alpine, requirepass, AOF persistence, internal-only)

autoheal     — restarts any container Docker's HEALTHCHECK marks unhealthy
watchtower   — auto-updates redis/nginx/certbot images nightly at 04:00 (NOT postgres
               or the custom backend/frontend images — see "Updating" below)
certbot      — one-off container, invoked by cron for renewal (not long-running)
```

Only nginx publishes ports to the host (80, 443). Everything else — postgres, redis,
backend-api, backend-worker, frontend — is reachable only on the internal Docker
network `autocheck_net`. UFW additionally blocks all inbound except 22/80/443.
All services use `restart: always`.

## Where things live

- App: `/opt/autocheck` (git clone of https://github.com/soleco13/autocheck)
- Secrets: `/opt/autocheck/.env` (chmod 600, root-only, **not** in git)
- DB data: Docker named volume `autocheck_pgdata`
- Redis data: Docker named volume `autocheck_redisdata`
- Uploaded textbook covers: Docker named volume `autocheck_covers` (mounted at
  `/app/covers` in both backend-api and backend-worker)
- TLS certs: Docker named volume `autocheck_certbot-etc` (`/etc/letsencrypt`)
- DB backups: `/opt/autocheck/backups/*.sql.gz` (30-day retention)
- Logs: `docker compose logs -f <service>` (json-file driver, rotated at 10MB×3 per
  container via `/etc/docker/daemon.json`)

## Notable deployment-specific decisions

- **`ANTHROPIC_BASE_URL=https://api.claudehub.fun`** — a third-party Anthropic API
  proxy/reseller, not the official `api.anthropic.com`. The repo's own
  `PRODUCTION.md` explicitly recommends against setting this in production (data
  transits third-party infrastructure, the key can be revoked without notice, no
  official SLA). This was set per explicit instruction from whoever ran this deploy.
  **To switch to the official API**: edit `.env`, remove the `ANTHROPIC_BASE_URL`
  line, replace `ANTHROPIC_API_KEY` with a real `sk-ant-...` key from
  console.anthropic.com, then `docker compose up -d backend-api backend-worker`.
- **`app.set('trust proxy', 1)`** was added to `backend/src/server.ts` (not upstream
  in the repo as of this deploy). Required because `express-rate-limit` v7 throws on
  every request when it sees `X-Forwarded-For` without Express's trust-proxy setting
  enabled — without this the app 500s on literally every request once it's behind
  nginx. If you pull upstream changes and this line is gone, re-add it.
- **No wildcard TLS cert** — only `homework-shkola.ru` + `www.homework-shkola.ru`
  (HTTP-01 challenge). The app has no subdomains; a wildcard would need DNS-01 and
  API credentials for whatever registrar/DNS host manages the domain.
- **SSH**: `PasswordAuthentication` was left enabled — there was no
  `~/.ssh/authorized_keys` configured for root at deploy time, so disabling password
  auth would have caused an immediate lockout. fail2ban is protecting sshd in the
  meantime (5 failures / 10 min → 1h ban; it had already banned an active
  brute-forcer within minutes of being enabled). **Recommended follow-up**: add your
  public key to `/root/.ssh/authorized_keys`, confirm you can log in with it, then
  set `PasswordAuthentication no` in `/etc/ssh/sshd_config` and `systemctl restart
  ssh`.
- **A kernel update needs a reboot** (`/var/run/reboot-required` is present). Not
  done automatically since this deployment session runs directly on the VDS and a
  reboot would have killed it mid-deploy. Schedule `reboot` for a low-traffic window;
  everything comes back via `restart: always` + Docker's `enable`d systemd unit.

## Common operations

```bash
cd /opt/autocheck

docker compose ps                       # status + health of every service
docker compose logs -f backend-api      # tail logs (add other service names)
docker compose restart backend-api      # restart one service
docker compose up -d --scale backend-api=2 --scale backend-worker=2   # scale out

./scripts/deploy.sh      # pull latest git, rebuild, migrate (auto on boot), restart, prune
./scripts/rollback.sh    # revert to the images running before the last deploy.sh
./scripts/backup.sh      # manual DB backup (also runs nightly via cron)
./scripts/prune.sh       # manual image/build-cache cleanup (also runs weekly via cron)
```

Migrations run automatically on `backend-api` container start
(`runMigrations()` in `server.ts`) — no separate migrate step needed after
`deploy.sh`.

### Updating images

- **App code** (backend/frontend): `./scripts/deploy.sh`. Keeps a `:previous` image
  tag for `./scripts/rollback.sh`.
- **redis / nginx / certbot base images**: auto-updated nightly by the `watchtower`
  container at 04:00, with old images cleaned up automatically.
- **postgres**: deliberately excluded from auto-update — an unattended major-version
  bump on the database is a real risk to data integrity. Bump the `pgvector/pgvector`
  tag in `docker-compose.yml` manually and test before rolling out.
- **OS packages**: `unattended-upgrades` applies security patches automatically
  (`/etc/apt/apt.conf.d/50unattended-upgrades-autocheck`). Reboots are **not**
  automatic (`Automatic-Reboot "false"`) — check `/var/run/reboot-required`
  periodically.

### Cron jobs (`/etc/cron.d/autocheck`)

| Job | Schedule | What |
|---|---|---|
| Cert renewal | twice daily | `certbot renew` (webroot) + reload nginx if renewed |
| DB backup | 02:00 daily | `scripts/backup.sh`, 30-day retention |
| Image prune | Sunday 03:30 | `scripts/prune.sh` |
| Monitor | every 5 min | `scripts/monitor.sh` → `/var/log/autocheck-monitor.log` |

## Security posture

- UFW: only 22 (SSH), 80, 443 open; default-deny inbound.
- fail2ban: sshd jail, 5 failures/10min → 1h ban.
- Non-root inside containers: backend/worker run as the built-in `node` user;
  frontend runs on `nginxinc/nginx-unprivileged`; postgres/redis official images
  already drop to their own non-root users internally. The edge `nginx` container is
  the one deliberate exception (see Architecture above).
- `cap_drop: ["ALL"]` + `no-new-privileges` on redis/backend-api/backend-worker/frontend.
- Postgres/Redis/backend are not exposed to the host or internet at all — only
  reachable from other containers on `autocheck_net`.
- Secrets live only in `/opt/autocheck/.env` (chmod 600) and are not committed to git.

## Emergency recovery runbook

**Full outage / server unresponsive**: check the VDS provider console first — if the
box itself is down, this runbook assumes you have a fresh VDS to rebuild on.

**Rebuilding from scratch on a new VDS:**
1. `git clone https://github.com/soleco13/autocheck.git /opt/autocheck`
2. Re-apply the `app.set('trust proxy', 1)` fix in `backend/src/server.ts` if not
   yet merged upstream (see "Notable deployment-specific decisions" above).
3. Recreate `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`,
   `frontend/docker-nginx.conf`, `deploy/nginx/nginx.conf` from this repo checkout
   (they're committed) — only `.env` is not.
4. Restore `.env` from your password manager / secrets backup (it was never
   committed to git — if you don't have it saved elsewhere, you'll need to
   regenerate `POSTGRES_PASSWORD`/`REDIS_PASSWORD`/`JWT_SECRET`/`TOKEN_ENCRYPTION_KEY`
   with `openssl rand -hex 32`, get the Anthropic key from wherever it's tracked, and
   accept that a fresh `TOKEN_ENCRYPTION_KEY` makes any tokens encrypted under the
   old key unreadable).
5. Point DNS at the new server's IP.
6. Run the system-prep steps in this doc's history (UFW, fail2ban, Docker install,
   `/etc/docker/daemon.json`) — or just re-run `docker compose build && docker
   compose up -d`, restore the DB (`gunzip < latest_backup.sql.gz | docker compose
   exec -T postgres psql -U autocheck -d autocheck`), then issue a fresh cert per the
   TLS section below.

**Database corruption / bad migration:**
```bash
cd /opt/autocheck
docker compose stop backend-api backend-worker
LATEST=$(ls -t backups/*.sql.gz | head -1)
gunzip < "$LATEST" | docker compose exec -T postgres psql -U autocheck -d autocheck
docker compose start backend-api backend-worker
```

**Bad app deploy:**
```bash
cd /opt/autocheck && ./scripts/rollback.sh
```

**Cert expired / renewal broken:**
```bash
cd /opt/autocheck
docker compose run --rm certbot certonly --webroot -w /var/www/certbot \
  -d homework-shkola.ru -d www.homework-shkola.ru --force-renewal
docker compose exec nginx nginx -s reload
```

**A service is stuck/unhealthy and autoheal isn't fixing it:**
```bash
docker compose ps                    # find the bad one
docker compose logs --tail=200 <service>
docker compose restart <service>     # or: docker compose up -d --force-recreate <service>
```

**Full cold start order** (if you ever bring everything up from stopped):
```bash
cd /opt/autocheck
docker compose up -d postgres redis
# wait for both healthy: docker compose ps
docker compose up -d backend-api backend-worker frontend nginx autoheal watchtower
```

**Secrets rotation**: edit `/opt/autocheck/.env`, then
`docker compose up -d backend-api backend-worker` (Postgres/Redis passwords also
require updating the `postgres`/`redis` service `environment:` — plan a maintenance
window since that needs those containers recreated too, not just the app layer).
