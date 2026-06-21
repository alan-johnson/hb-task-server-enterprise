// PM2 process config for UpQ on the droplet.
// Fork mode (not cluster) — long-lived WebSocket connections from the macOS
// bridge client require a single process. Cluster mode would spread WS
// connections across workers without Redis pub/sub + sticky sessions.
module.exports = {
  apps: [
    {
      name: 'upq',
      script: 'src/task-server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3500,
      },
      // Logs land in /home/deploy/.pm2/logs/ by default.
      // Rotate with: pm2 install pm2-logrotate
      error_file: '/home/deploy/logs/upq-error.log',
      out_file: '/home/deploy/logs/upq-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
