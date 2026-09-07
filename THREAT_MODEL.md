# THREAT_MODEL.md — Atlantic Host

Fase 2 da missão de sandboxing. Este documento assume tudo que
`SECURITY_AUDIT.md` encontrou e define, de forma explícita, quem é o
atacante, o que ele controla, o que ele NÃO pode conseguir, e onde a
fronteira de confiança (trust boundary) precisa existir.

---

## Ativos a proteger (por ordem de criticidade)

1. **O host/processo do Atlantic Host** — disponibilidade da plataforma
   inteira (se cai, cai pra todos os tenants ao mesmo tempo).
2. **Segredos da plataforma** — `.env` real (`BOT_TOKEN`, `ENCRYPTION_KEY`,
   `OWNER_ID`, `CLIENT_ID`, `GITHUB_WEBHOOK_SECRET`), o banco `hosting.db`
   (contém tokens de bots de TODOS os clientes, criptografados, mas a
   chave de criptografia está no mesmo `.env`).
3. **Isolamento entre tenants** — filesystem, rede, processos e variáveis
   de ambiente de um bot não podem ser alcançados por outro bot.
4. **Recursos do host** — CPU, RAM, PIDs, disco, file descriptors,
   banda de rede — nenhum tenant pode monopolizar a máquina inteira.
5. **Integridade dos backups** — um backup não pode ser um vetor de
   exfiltração (ver C5 no audit) nem de restauração maliciosa.

---

## Ator: cliente hospedado malicioso

**O que ele controla, 100% livremente, hoje:**

- Todo o conteúdo do seu próprio bot: JavaScript, TypeScript, Python.
- O `package.json`/`requirements.txt`/`pyproject.toml` inteiro, incluindo
  quais dependências de terceiros são instaladas (`--ignore-scripts`
  bloqueia só o *script* de instalação de um pacote de terceiro, não o
  pacote em si — o pacote instalado pode conter qualquer código, incluindo
  addons nativos pré-compilados).
- O script `"build"` do próprio `package.json` (hoje executado sem
  isolamento — ver C4).
- O conteúdo de um `.zip` de deploy, ou de um repositório GitHub inteiro
  (incluindo poder commitar links simbólicos, que sobrevivem a
  `git clone`/`git pull` — diferente da extração de `.zip`, que não recria
  symlinks).
- Variáveis de ambiente do PRÓPRIO bot (não as da plataforma — isso já é
  bem isolado, ver "verificado e confirmado sem vulnerabilidade" no audit).
- Quando o processo do bot está rodando: toda a API padrão do Node.js
  disponível a qualquer script Node (fs, net, os, worker_threads, etc.),
  MENOS os 6 módulos nativos explicitamente bloqueados por nome.

**O que ele PODE tentar (lista do pedido original, com status real hoje):**

| Ataque | Hoje | Referência |
|---|---|---|
| Ler `.env`/tokens do Atlantic | ❌ Consegue | C1 |
| Ler banco de outros tenants | ❌ Consegue (mesmo mecanismo, é só um arquivo) | C1 |
| Acessar filesystem de outros bots | ❌ Consegue | C1 |
| Acessar processos do Atlantic | ❌ Consegue matar o processo pai | C2 |
| Controlar outros bots | ❌ Consegue (via processo pai morto, ou lendo o banco e agindo por fora) | C1, C2 |
| Acessar Docker socket | ⚠️ Não aplicável hoje (Docker não está em uso) — mas ver Fase 4/7 pra quando estiver |
| Acessar credenciais do sistema | ❌ Consegue (mesmo usuário do SO, sem separação) | C1 |
| Executar comandos privilegiados | ⚠️ Não tem privilege escalation (não roda como admin/root), mas já é code exec completo no mesmo nível de usuário |
| Escapar do sandbox | N/A — não existe sandbox real pra escapar (é o mesmo processo) | C6 |
| Consumir toda a RAM | ⚠️ Parcialmente mitigado (watchdog soft, mata depois de estourar) | M3 |
| Consumir toda a CPU | ⚠️ Só mitigado se `cpulimit` estiver instalado (não está por padrão no Windows) | M2 |
| Criar milhares de processos (fork bomb) | ✅ Mitigado — `child_process`/`cluster` bloqueados, `process.fork` sobrescrito | — |
| Acessar localhost/rede interna | ❌ Consegue | C3 |
| Descobrir segredos por rede (SSRF) | ❌ Consegue | C3 |

**Legenda:** ❌ = o atacante consegue hoje (falha real) · ✅ = mitigado ·
⚠️ = parcialmente mitigado / depende de configuração do host.

---

## Trust boundaries (onde a fronteira PRECISA existir)

```
┌─────────────────────────────────────────────────────────────┐
│ HOST (Windows/Linux)                                          │
│                                                                 │
│  ┌───────────────────────────────┐   TRUST BOUNDARY (hoje:    │
│  │ Atlantic Host (processo pai)  │   NÃO EXISTE DE VERDADE —   │
│  │ - Discord bot de gestão        │   é a mesma "sala" que o    │
│  │ - Banco hosting.db             │   bot hospedado)            │
│  │ - .env / segredos              │                             │
│  │ - webhook GitHub, proxy, etc.  │  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│  └───────────────────────────────┘                             │
│                                                                 │
│  ┌───────────────────────────────┐                             │
│  │ Bot do Cliente A (spawn)       │ ← devia estar numa sala      │
│  │ security_wrapper.js (JS only) │   trancada à parte, sem       │
│  └───────────────────────────────┘   enxergar o resto           │
│                                                                 │
│  ┌───────────────────────────────┐                             │
│  │ Bot do Cliente B (spawn)       │ ← idem, e sem enxergar o      │
│  │ security_wrapper.js (JS only) │   Cliente A                   │
│  └───────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

A fronteira precisa ser aplicada pelo **kernel** (namespaces, cgroups), não
por convenção de código JavaScript. Isso é o que as Fases 3–7 do pedido
original endereçam, e é consistente com a decisão já tomada nesta conversa:
usar `bwrap`/`nsjail` como implementação real dessa fronteira em Linux, e
manter o `security_wrapper.js` atual — devidamente rotulado como
"isolamento reduzido, best-effort" — como o que roda em Windows enquanto não
houver um host Linux disponível (decisão já confirmada com você).

---

## O que o cliente NÃO pode conseguir (meta de segurança, não estado atual)

Repetindo os requisitos do pedido original como critério de aceite formal
pras fases seguintes:

- [ ] Ler `.env` do Atlantic
- [ ] Ler tokens do Discord de outros bots
- [ ] Acessar banco de outros tenants
- [ ] Acessar filesystem de outros bots
- [ ] Acessar processos do Atlantic
- [ ] Controlar outros bots
- [ ] Acessar Docker socket (quando Docker estiver em uso)
- [ ] Acessar credenciais do sistema
- [ ] Executar comandos privilegiados
- [ ] Escapar do sandbox

Nenhum destes está marcado como concluído — todos dependem das Fases 3+
(ainda não implementadas, aguardando sua revisão da Fase 1/2 antes de eu
prosseguir, conforme pedido).

---

## Ator secundário: bot "comum" não malicioso, mas com bug

Vale registrar — nem todo incidente exige intenção maliciosa. Um bot com
um loop infinito por bug (não ataque) já hoje pode:
- Consumir 100% de um núcleo de CPU indefinidamente (M2).
- Crescer em RAM até o watchdog perceber e matar (M3), afetando a
  responsividade do host pros outros bots durante a janela até a detecção.

Isso significa que os limites de recurso (Fase 6) protegem não só contra
ataque deliberado, mas contra o caso muito mais comum de bug acidental de
cliente legítimo — vale a pena nas duas frentes.

---

## Fora de escopo deste modelo de ameaças

- Ataques à conta Discord do cliente (phishing, roubo de token fora da
  plataforma) — não é responsabilidade do Atlantic Host.
- Ataques à infraestrutura de rede do provedor de hospedagem (ISP, roteador
  doméstico) — fora do controle do software.
- Malware autorreplicante/destrutivo real como ferramenta de teste — já
  recusado explicitamente em conversa anterior desta sessão, mantido aqui
  como fora de escopo por decisão de segurança, não por limitação técnica.
