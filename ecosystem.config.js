// ATENÇÃO: PM2 é a opção de DESENVOLVIMENTO/fallback operacional, não a
// principal de produção — em produção Linux, prefira systemd (ver
// deploy/atlantic-host.service e DEPLOY.md). Motivos: systemd já vem em
// qualquer VPS Linux moderna (sem instalar mais nada globalmente),
// reinicia de verdade após reboot sem passo extra (`pm2 startup` + `pm2
// save`), e integra logs com o journal do próprio SO (rotação
// automática). Use PM2 se: você já opera outros processos via PM2, está
// testando localmente, ou seu provedor não te dá acesso a systemd.
module.exports = {
  apps: [
    {
      name: 'atlantic-host',
      script: 'index.js',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      },
      watch: false,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      kill_timeout: 10000,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
