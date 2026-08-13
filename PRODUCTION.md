# AutoCheck — Production Setup Guide

## Prerequisites

- Node.js 20 LTS
- PostgreSQL 16
- Redis 5+ (Memurai for Windows, or Redis native on Linux)
- nginx (for HTTPS reverse proxy)
- PM2 (`npm install -g pm2`)

## Environment (.env)

```bash
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/autocheck
REDIS_URL=redis://localhost:6379
JWT_SECRET=<64-hex-char random string>
TOKEN_ENCRYPTION_KEY=<64-hex-char random string>
OPENROUTER_API_KEY=sk-or-v1-...      # https://openrouter.ai/keys
AI_CHECKER_MODEL=anthropic/claude-haiku-4.5
AI_FALLBACK_MODEL=openai/gpt-5-mini
AI_REPORT_MODEL=anthropic/claude-sonnet-5
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://yourdomain.com
```

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Build & Deploy

```bash
cd backend && npm run build   # tsc → dist/
cd frontend && npm run build  # vite → dist/

# Run migrations
cd backend && node dist/db/migrate.js

# Start with PM2
pm2 start pm2.ecosystem.config.js --env production
pm2 save && pm2 startup
```

## nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # Frontend
    location / {
        root /path/to/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    # SSE — disable buffering for real-time events
    location /api/events {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        chunked_transfer_encoding on;
    }
}

server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}
```

## Backup (crontab)

```cron
# Daily backup at 2am
0 2 * * * DB_NAME=autocheck DB_USER=postgres /path/to/autocheck/scripts/backup.sh

# Weekly vacuum
0 3 * * 0 psql -U postgres -d autocheck -c "VACUUM ANALYZE;"
```

## pg_bouncer (optional, recommended for 10+ teachers)

Install pg_bouncer, then:
```ini
[databases]
autocheck = host=localhost port=5432 dbname=autocheck

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 20
listen_port = 5433
```

Change DATABASE_URL to use port 5433 (pg_bouncer).

## Scaling

- HTTP: `pm2 scale autocheck-api 4`  (4 instances behind nginx upstream)
- Workers: `pm2 scale autocheck-worker 3` (3 worker processes)
- Each worker runs `WORKER_CONCURRENCY=5` concurrent checks

## Health Monitoring

```bash
# Check health
curl https://yourdomain.com/api/health | jq

# PM2 monitoring
pm2 monit

# Queue depth
pm2 logs autocheck-worker --lines 50
```
