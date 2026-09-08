# SECURITY_ARCHITECTURE.md — Atlantic Host

Visão geral da arquitetura de segurança do Atlantic Host. Este documento
descreve **como as peças se encaixam**; os detalhes de cada peça estão em
`SANDBOX.md` (mecanismo de isolamento) e `SECURITY_LIMITATIONS.md` (o que
não está protegido). O histórico de como se chegou aqui está em
`SECURITY_AUDIT.md` (achados) e `THREAT_MODEL.md` (modelo de ameaças).

---

## Trust boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│ CONFIANÇA TOTAL (código do próprio Atlantic Host)                 │
│  index.js, src/handlers/, src/managers/ (exceto sandbox/), banco   │
│  .env real, ENCRYPTION_KEY, BOT_TOKEN da plataforma                │
└──────────────────────────────────────────────────────────────────┘
                              │
                    checkpoint de autorização
                    (canManageBot() — único lugar
                     que decide quem pode agir sobre
                     qual bot, nunca duplicado rota a rota)
                              │
┌──────────────────────────────────────────────────────────────────┐
│ CONFIANÇA ZERO (código do cliente hospedado)                      │
│  Tudo que o cliente envia: JavaScript, TypeScript, Python, ZIP,    │
│  package.json, dependências npm/pip, repositório GitHub — tratado  │
│  como HOSTIL por padrão, mesmo sem intenção maliciosa (bugs        │
│  acontecem).                                                       │
│                                                                      │
│  Fronteira aplicada por SandboxManager (ver SANDBOX.md):           │
│  ┌────────────────────┐  ┌────────────────────┐                   │
│  │ Bot do Cliente A    │  │ Bot do Cliente B    │  ...              │
│  │ (sandbox própria)   │  │ (sandbox própria)   │                   │
│  └────────────────────┘  └────────────────────┘                   │
└──────────────────────────────────────────────────────────────────┘
```

A fronteira entre as duas zonas tem duas camadas independentes, que
precisam **ambas** estar corretas:

1. **Camada de autorização** (quem pode pedir o quê): `canManageBot()`,
   checado em toda rota/comando que age sobre um bot. Nega com "não
   encontrado" (nunca "sem permissão") pra não confirmar a existência de
   um recurso pra quem não tem acesso a ele.
2. **Camada de isolamento de execução** (o que o código do bot consegue
   alcançar uma vez rodando): `SandboxManager` — este é o assunto deste
   conjunto de documentos.

Estas duas camadas são independentes por design: um bug na autorização não
quebra o isolamento de execução, e vice-versa.

---

## Mecanismos utilizados, por camada

| Camada | Mecanismo | Onde |
|---|---|---|
| Autorização | `canManageBot()` — dono, colaborador com permissão explícita, ou nega | `src/managers/userManager.js` |
| Banco de dados | Prepared statements (`?`) em 100% das queries — sem concatenação de valor de usuário em SQL | `src/database/database.js` e todos os managers |
| Segredos da plataforma | `.env` real nunca entra no ambiente do processo do bot — `botEnv` é construído do zero, com lista de bloqueio pra variáveis com nome de segredo da plataforma | `src/managers/processManager.js` |
| Deploy — ZIP | Validação de zip-slip (`../`, barra invertida) e zip-bomb (limite de entradas e de tamanho descompactado) antes de qualquer extração | `src/utils/zipValidation.js` |
| Deploy — GitHub | `execFile` com argumentos em array (nunca concatenação de shell) pra todo comando `git` | `src/managers/githubManager.js` |
| Deploy — dependências | `npm install --ignore-scripts` / `pip install --only-binary` — nenhum script de instalação de terceiro roda. Scripts declarados pelo próprio bot (`"build"`, etc.) **não são executados automaticamente** (ver achado C4 do audit — foi tentado, revertido por ser code execution sem sandbox) | `src/managers/dependencyManager.js` |
| Gerenciador de arquivos (painel/comandos) | Resolução de caminho com `fs.realpathSync` seguindo symlink, não só string | `src/managers/fileManager.js` |
| **Execução do processo do bot** | **`SandboxManager`** — ver `SANDBOX.md` | `src/managers/sandbox/` |

---

## Permissões (modelo de autorização)

- **Dono do bot**: acesso total às ações permitidas pelo plano.
- **Colaborador**: permissões explícitas e granulares (`view`, `start`,
  `stop`, `logs`, `files`, ...), armazenadas por bot — nunca herda tudo só
  por estar associado ao bot.
- **Staff/Admin**: ações de suspensão/moderação, checadas separadamente
  das permissões de colaborador.
- **O próprio bot em execução**: roda com o mínimo de privilégio que o
  backend de sandbox permitir — no backend `linux`, isso significa **zero
  capabilities de kernel** (`CapInh/Prm/Eff/Bnd/Amb` todos
  `0000000000000000`, confirmado ao vivo), usuário mapeado não-privilegiado,
  e nenhuma visão de processos/arquivos fora do que foi explicitamente
  concedido.

---

## Como o SandboxManager decide (resumo — detalhe completo em SANDBOX.md)

```
SandboxManager.decideBackend()
├── process.platform !== 'linux'  →  'process' (reduzido, sempre disponível)
├── Linux + bwrap + user namespaces + cgroup v2 delegado (os 3, testados
│   de verdade, não só "o binário existe")  →  'linux' (isolamento real)
└── Linux sem os 3 requisitos  →  RECUSA (fail-closed — nunca cai
    silenciosamente pro modo reduzido)
```

Esta decisão acontece **antes** de qualquer processo de bot subir, em
`processManager.js`. Nenhum outro código do sistema decide isolamento por
conta própria — é a única fonte de verdade.

---

## Documentos relacionados

- `THREAT_MODEL.md` — quem é o atacante, o que ele controla, o que ele não
  pode conseguir.
- `SECURITY_AUDIT.md` — achados de auditoria (o que já foi quebrado e
  corrigido, com reprodução).
- `SANDBOX.md` — mecanismo de isolamento em detalhe, requisitos de host,
  como verificar se está ativo.
- `SECURITY_LIMITATIONS.md` — o que **não** está protegido hoje, sem
  meias-palavras.
- `SECURITY_MONITOR.md` — SecurityMonitor + Groq (Kamikaze Fase 2): analisador
  auxiliar, nunca decide nada sozinho, relatório de validação.
