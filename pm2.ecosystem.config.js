/**
 * PM2 ecosystem config for AutoCheck production deployment.
 *
 * Usage:
 *   npm run build          # compile TypeScript → dist/
 *   pm2 start pm2.ecosystem.config.js
 *   pm2 save && pm2 startup
 *
 * Scale workers independently:
 *   pm2 scale autocheck-worker 3
 */

module.exports = {
  apps: [
    {
      name: 'autocheck-api',
      script: 'dist/server.js',
      instances: 2,                   // 2 HTTP processes (round-robin)
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      env_production: {
        NODE_ENV: 'production',
        INLINE_WORKER: 'false',       // HTTP processes never run the worker
        PORT: 3001,
      },
      error_file: 'logs/api-error.log',
      out_file: 'logs/api-out.log',
      merge_logs: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '5s',
    },
    {
      name: 'autocheck-worker',
      script: 'dist/worker.js',
      instances: 2,                   // 2 worker processes
      exec_mode: 'fork',             // fork (not cluster) — workers are I/O-bound, not CPU
      max_memory_restart: '768M',
      env_production: {
        NODE_ENV: 'production',
        WORKER_CONCURRENCY: 5,        // 5 concurrent checks per worker process
      },
      error_file: 'logs/worker-error.log',
      out_file: 'logs/worker-out.log',
      merge_logs: true,
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
