# Ideias

Registro de ideias para o projeto, começando pelo ponto de partida.

## Bot de canais por projeto (GitHub → Discord)

**Data:** 2026-08-11

Um bot conectado à conta do GitHub que, para cada projeto/repositório, cria
automaticamente um canal no Discord com o nome do projeto e posta o link do
repositório, guardando esse vínculo (canal ↔ repositório) para uso futuro
(ex: rotear notificações de commits, PRs e issues para o canal certo).

Pontos em aberto para quando for implementar:
- Trigger: comando manual (`/novo-projeto`) vs. automático via webhook do
  GitHub (novo repo criado/detectado).
- Persistência do vínculo canal↔repo (arquivo, SQLite, etc.).
- Se aproveita a infraestrutura de bot já existente neste repositório
  (Atlantic Host) ou se é um serviço separado.
