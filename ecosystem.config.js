module.exports = {
  apps: [
    {
      name: 'autocheck-backend',
      script: 'node_modules/.bin/ts-node-dev',
      args: '--transpile-only --files --exit-child src/server.ts',
      cwd: './backend',
      interpreter: 'none',

      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s',
      restart_delay: 2000,

      // Memory guard — restart if RSS exceeds 512 MB
      max_memory_restart: '512M',

      // Environment
      env: {
        NODE_ENV: 'development',
        INLINE_WORKER: 'true',
      },
      env_production: {
        NODE_ENV: 'production',
        INLINE_WORKER: 'false',   // run worker as separate process in prod
      },

      // Log files
      out_file: './logs/backend-out.log',
      error_file: './logs/backend-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      log_type: 'json',
    },

    // In production: separate worker process so heavy AI checks
    // don't block the API server
    {
      name: 'autocheck-worker',
      script: 'node_modules/.bin/ts-node-dev',
      args: '--transpile-only --files --exit-child src/worker.ts',
      cwd: './backend',
      interpreter: 'none',

      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '256M',

      env_production: {
        NODE_ENV: 'production',
        WORKER_CONCURRENCY: '3',
      },

      // Only run in production — dev uses INLINE_WORKER
      instances: 0,   // start manually: pm2 start ecosystem.config.js --only autocheck-worker --env production

      out_file: './logs/worker-out.log',
      error_file: './logs/worker-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    {
      name: 'autocheck-frontend',
      script: 'node_modules/.bin/vite',
      args: 'preview --port 3000 --host',
      cwd: './frontend',
      interpreter: 'none',
      autorestart: true,
      restart_delay: 2000,
      env: { NODE_ENV: 'production' },
      out_file: './logs/frontend-out.log',
      error_file: './logs/frontend-err.log',
    },
  ],
};
