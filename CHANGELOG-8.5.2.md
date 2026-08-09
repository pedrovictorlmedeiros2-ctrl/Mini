# v8.5.2

## Segurança / Host
- Proteção de RAM do PC: teto por bot + % máxima da RAM total
- Planos respeitam HOST_MAX_RAM_PER_BOT / HOST_MAX_CPU_PER_BOT
- Defaults mais seguros no PC (256MB RAM, 30% CPU, 3 bots)

## Watchdog
- Aviso suave (85% RAM / 90% CPU) antes de matar
- DM automática para o dono do bot + webhook admin
- Cooldown de avisos (5 min)

## Site / App
- Fluxo no Discord: Bot Discord OU Site/App
- Criação de site/app com porta automática (10000-20000)
- Template Node HTTP pronto (usa process.env.PORT)
- Lista "Meus Bots" mostra tipo e porta

## Painel web
- API lista type e port

## Config (.env)
```
HOST_MAX_RAM_PER_BOT=512
HOST_MAX_CPU_PER_BOT=50
HOST_MAX_BOTS_PER_USER=8
HOST_MAX_RAM_PERCENT=55
MAX_BOTS_PER_USER=3
MAX_RAM_PER_BOT=256
MAX_CPU_PER_BOT=30
```
