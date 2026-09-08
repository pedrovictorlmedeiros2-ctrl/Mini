/**
 * BANCO DE DADOS SQLITE - v8.0 ENTERPRISE (MULTI-PLATFORM)
 * Sistema de persistência usando SQLite nativo do Node
 *
 * Schema completo com todas as tabelas necessárias:
 * - users, sales_config, plans, coupons, nodes
 * - bots (schema completo com language, main_file, pid, health_status, cpu_usage, ram_usage, etc.)
 * - bot_collaborators, orders, backups, env_variables, logs, action_history
 */
const path = require('path');
const { createDatabaseConnection } = require('./sqliteCompat');

const dbPath = process.env.HOSTING_DB_PATH || path.join(__dirname, 'hosting.db');
const db = createDatabaseConnection(dbPath);

function initDatabase() {
    // TABELA DE USUARIOS
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            discriminator TEXT,
            avatar TEXT,
            role TEXT DEFAULT 'client',
            plan_id TEXT,
            plan_name TEXT DEFAULT 'free',
            plan_expiry DATETIME,
            notified_expiry INTEGER DEFAULT 0,
            max_bots INTEGER DEFAULT 1,
            max_cpu INTEGER DEFAULT 50,
            max_ram INTEGER DEFAULT 256,
            balance REAL DEFAULT 0,
            referred_by TEXT,
            affiliate_code TEXT UNIQUE,
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // CONFIGURACAO DE VENDAS
    db.exec(`
        CREATE TABLE IF NOT EXISTS sales_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            pix_key TEXT,
            pix_name TEXT,
            pix_city TEXT,
            pix_qrcode TEXT,
            affiliate_commission INTEGER DEFAULT 10,
            welcome_message TEXT,
            category_id TEXT,
            admin_role_id TEXT
        )
    `);
    db.prepare("INSERT OR IGNORE INTO sales_config (id) VALUES (1)").run();

    // PLANOS
    db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL,
            max_bots INTEGER NOT NULL,
            max_ram INTEGER NOT NULL,
            max_cpu INTEGER NOT NULL,
            storage INTEGER DEFAULT 1024,
            color TEXT DEFAULT '#00FF00',
            role_to_add TEXT,
            role_to_remove TEXT,
            icon TEXT,
            status TEXT DEFAULT 'active'
        )
    `);

    // CUPONS
    db.exec(`
        CREATE TABLE IF NOT EXISTS coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            code TEXT UNIQUE NOT NULL,
            type TEXT CHECK(type IN ('percentage', 'fixed')) NOT NULL,
            value REAL NOT NULL,
            max_uses INTEGER DEFAULT 0,
            current_uses INTEGER DEFAULT 0,
            expires_at DATETIME,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // NODES (MULTI-NODE)
    db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ip TEXT NOT NULL,
            port INTEGER DEFAULT 3001,
            secret_key TEXT NOT NULL,
            status TEXT DEFAULT 'offline',
            total_ram INTEGER,
            used_ram INTEGER DEFAULT 0,
            total_cpu INTEGER DEFAULT 100,
            used_cpu INTEGER DEFAULT 0,
            last_heartbeat DATETIME
        )
    `);
    db.prepare(
        "INSERT OR IGNORE INTO nodes (id, name, ip, secret_key, status) VALUES ('master', 'Master Node', '127.0.0.1', 'local-secret', 'online')"
    ).run();

    // APPS (Antiga tabela BOTS, agora genérica)
    db.exec(`
        CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            type TEXT DEFAULT 'bot', -- 'bot', 'web', 'minecraft'
            token TEXT, -- Opcional para web/mc
            language TEXT DEFAULT 'javascript',
            main_file TEXT DEFAULT 'index.js',
            port INTEGER, -- Porta externa alocada
            internal_port INTEGER, -- Porta interna do app
            domain TEXT, -- Domínio/Subdomínio
            java_version TEXT, -- Versão do Java (Minecraft)
            minecraft_version TEXT, -- Versão do MC
            server_type TEXT, -- 'paper', 'purpur', 'vanilla'
            prefix TEXT DEFAULT '!',
            color TEXT DEFAULT '#FFFFFF',
            privacy TEXT DEFAULT 'public',
            auto_restart INTEGER DEFAULT 1,
            auto_backup INTEGER DEFAULT 0,
            node_version TEXT DEFAULT '22',
            python_version TEXT DEFAULT '3',
            max_memory INTEGER,
            max_cpu_limit INTEGER,
            suspended INTEGER DEFAULT 0,
            suspended_reason TEXT,
            github_repo TEXT,
            github_branch TEXT DEFAULT 'main',
            creator_id TEXT NOT NULL,
            node_id TEXT DEFAULT 'master',
            status TEXT DEFAULT 'offline',
            folder_path TEXT NOT NULL,
            pid INTEGER,
            last_start DATETIME,
            health_score INTEGER DEFAULT 100,
            health_status TEXT DEFAULT 'healthy',
            cpu_usage REAL DEFAULT 0,
            ram_usage REAL DEFAULT 0,
            uptime INTEGER DEFAULT 0,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (creator_id) REFERENCES users(id),
            FOREIGN KEY (node_id) REFERENCES nodes(id)
        )
    `);

    // COLABORADORES
    db.exec(`
        CREATE TABLE IF NOT EXISTS bot_collaborators (
            bot_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            permissions TEXT DEFAULT 'view,start,stop,logs',
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (bot_id, user_id),
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    // PEDIDOS
    db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            channel_id TEXT UNIQUE NOT NULL,
            plan_id TEXT,
            coupon_id INTEGER,
            original_price REAL,
            discount_amount REAL DEFAULT 0,
            total_price REAL,
            status TEXT DEFAULT 'pending',
            receipt_url TEXT,
            rejection_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (plan_id) REFERENCES plans(id),
            FOREIGN KEY (coupon_id) REFERENCES coupons(id)
        )
    `);

    // BACKUPS
    db.exec(`
        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            size INTEGER DEFAULT 0,
            type TEXT DEFAULT 'manual',
            checksum TEXT,
            encrypted INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )
    `);

    // Migração leve para bancos já existentes criados antes destas colunas
    // (CREATE TABLE IF NOT EXISTS não adiciona colunas em tabelas já criadas).
    try { db.exec(`ALTER TABLE backups ADD COLUMN checksum TEXT`); } catch { /* já existe */ }
    try { db.exec(`ALTER TABLE backups ADD COLUMN encrypted INTEGER DEFAULT 0`); } catch { /* já existe */ }
    try { db.exec(`ALTER TABLE bots ADD COLUMN suspended INTEGER DEFAULT 0`); } catch { /* já existe */ }
    try { db.exec(`ALTER TABLE bots ADD COLUMN suspended_reason TEXT`); } catch { /* já existe */ }

    // KAMIKAZE MODE (resposta automática a incidentes de segurança):
    // 'safety_status' marca se um backup pode ser usado como snapshot seguro
    // de restauração automática ('safe') ou foi criado com um incidente já
    // aberto pro bot, portanto não confiável ('flagged_compromised'). Backups
    // já existentes (de antes desta feature) recebem o default 'safe' — não
    // retroagimos suspeita sobre nada que já existia.
    try { db.exec(`ALTER TABLE backups ADD COLUMN safety_status TEXT DEFAULT 'safe'`); } catch { /* já existe */ }
    try { db.exec(`ALTER TABLE backups ADD COLUMN flagged_by_incident_id INTEGER`); } catch { /* já existe */ }
    try { db.exec(`ALTER TABLE bots ADD COLUMN token_revoked_at DATETIME`); } catch { /* já existe */ }

    // ENV_VARIABLES
    db.exec(`
        CREATE TABLE IF NOT EXISTS env_variables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            UNIQUE(bot_id, key),
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )
    `);

    // LOGS DO SISTEMA
    db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT,
            user_id TEXT,
            action TEXT NOT NULL,
            details TEXT,
            type TEXT DEFAULT 'info',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        )
    `);

    // HISTORICO DE ACOES
    db.exec(`
        CREATE TABLE IF NOT EXISTS action_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            bot_id TEXT,
            action TEXT NOT NULL,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL
        )
    `);

    // KAMIKAZE MODE — INCIDENTES DE SEGURANÇA
    // Uma linha por incidente, atualizada in-place a cada transição de estado
    // (ver IncidentResponseManager.js). 'evidence_json' guarda os sinais que
    // levaram à classificação CRITICAL — para auditoria, não pra reprocessar.
    db.exec(`
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id TEXT NOT NULL,
            severity TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'detected',
            evidence_json TEXT,
            snapshot_used_id INTEGER,
            quarantine_entry_id INTEGER,
            credential_action TEXT,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            resolved_at DATETIME,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )
    `);

    // Quarentena: cada linha é uma cópia do workspace comprometido preservada
    // (nunca apagada automaticamente) para investigação. 'purged' só é ligado
    // por uma ação manual de admin — não construído nesta entrega.
    db.exec(`
        CREATE TABLE IF NOT EXISTS quarantine_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            incident_id INTEGER NOT NULL,
            bot_id TEXT NOT NULL,
            original_folder_path TEXT NOT NULL,
            quarantine_path TEXT NOT NULL,
            size_bytes INTEGER DEFAULT 0,
            retention_until DATETIME,
            purged INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
            FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
        )
    `);

    // ═══════════════════════════════════════════════════════════════════
    // SISTEMA COMERCIAL (Product → Order → Payment → Entitlement)
    //
    // Tabelas NOVAS e ISOLADAS do sistema de vendas legado (plans/orders/
    // sales_config, definidos acima) — os dois convivem até uma fase futura
    // substituir o legado. Prefixo `commerce_` evita qualquer colisão de
    // nome com as tabelas já existentes (ex.: já existe uma tabela `orders`
    // acima, do fluxo antigo — esta é `commerce_orders`, deliberadamente
    // separada). `coupons` é a ÚNICA tabela reaproveitada como está, sem
    // nenhuma coluna nova — arquitetura aprovada em
    // COMMERCIAL_ARCHITECTURE_PROPOSAL.md.
    // ═══════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_products (
            id TEXT PRIMARY KEY,
            guild_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL,
            max_bots INTEGER NOT NULL,
            max_ram INTEGER NOT NULL,
            max_cpu INTEGER NOT NULL,
            storage INTEGER DEFAULT 1024,
            billing_period TEXT NOT NULL DEFAULT 'monthly',
            role_to_add TEXT,
            role_to_remove TEXT,
            -- Fase 3: draft (recém-criado, nunca visível ao cliente) →
            -- published (visível na loja, comprável) → paused (some da
            -- loja, pedidos já existentes nunca são afetados) → archived
            -- (terminal, nunca reaparece). Ver ProductCatalog.js.
            status TEXT NOT NULL DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // product_snapshot: cópia JSON imutável do produto no momento em que o
    // pedido sai de DRAFT — nunca mais lida de commerce_products depois
    // disso (pedidos históricos nunca mudam com edições futuras do produto).
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            user_id TEXT NOT NULL,
            channel_id TEXT UNIQUE NOT NULL,
            product_id TEXT,
            product_snapshot TEXT,
            coupon_id INTEGER,
            renewal_of_entitlement_id INTEGER,
            original_price REAL,
            discount_amount REAL DEFAULT 0,
            total_price REAL,
            status TEXT NOT NULL DEFAULT 'DRAFT',
            rejection_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (product_id) REFERENCES commerce_products(id),
            FOREIGN KEY (coupon_id) REFERENCES coupons(id),
            FOREIGN KEY (renewal_of_entitlement_id) REFERENCES commerce_entitlements(id)
        )
    `);

    // Pix snapshotado (pix_key/name/city) no momento em que o pedido entra
    // em AWAITING_PAYMENT — nunca lido ao vivo de sales_config depois disso,
    // mesmo princípio de imutabilidade do product_snapshot acima.
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL UNIQUE,
            method TEXT NOT NULL DEFAULT 'pix',
            pix_key_snapshot TEXT,
            pix_name_snapshot TEXT,
            pix_city_snapshot TEXT,
            expected_amount REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'awaiting_proof',
            confirmed_by_admin_id TEXT,
            confirmed_at DATETIME,
            rejection_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES commerce_orders(id),
            FOREIGN KEY (confirmed_by_admin_id) REFERENCES users(id)
        )
    `);

    // Um Entitlement por Order (inclusive renovação — nunca edita um
    // entitlement existente). V1: no máximo UM entitlement com
    // status='active' por usuário a qualquer momento (garantido em
    // EntitlementManager.grant(), não só por convenção) — decisão de
    // negócio confirmada, "múltiplos planos simultâneos" fica pra uma
    // extensão futura explícita, não implementada aqui.
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            order_id INTEGER NOT NULL UNIQUE,
            user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_provisioning',
            activated_at DATETIME,
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES commerce_orders(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

    // FASE 7 (ProvisioningManager): histórico/log de tentativas de
    // provisionamento — NÃO é o mecanismo de exclusão mútua (isso é o CAS
    // de OrderManager.transitionOrder(), ver ProvisioningManager.js); cada
    // tentativa (inclusive retries) grava sua própria linha, nunca
    // sobrescreve uma anterior. `error_message` é sempre sanitizado antes
    // de gravar (nunca stack trace bruta, nunca segredo). `executor_user_id`
    // é NULL pra provisionamento automático pós-aprovação, preenchido pra
    // retry manual (staff/admin).
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_provisioning_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            entitlement_id INTEGER,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            error_message TEXT,
            executor_user_id TEXT,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME,
            FOREIGN KEY (order_id) REFERENCES commerce_orders(id),
            FOREIGN KEY (entitlement_id) REFERENCES commerce_entitlements(id),
            FOREIGN KEY (executor_user_id) REFERENCES users(id)
        )
    `);

    // Permissão comercial independente de 'admin' (ROLE_HIERARCHY de
    // userManager.js não é alterada) — soft-revoke (revoked_at) preserva
    // histórico de quem teve o papel e quando, nunca DELETE.
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_staff (
            user_id TEXT PRIMARY KEY,
            guild_id TEXT,
            granted_by TEXT NOT NULL,
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            revoked_by TEXT,
            revoked_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (granted_by) REFERENCES users(id),
            FOREIGN KEY (revoked_by) REFERENCES users(id)
        )
    `);

    // COMPROVANTES (Fase 3) — 1:N com commerce_orders (histórico completo,
    // nunca sobrescrito: um reenvio cria uma linha NOVA). `id` é um UUID
    // opaco (gerado em ProofManager.js), não sequencial, pra reduzir
    // correlação trivial. `storage_path` aponta pro arquivo CIFRADO em
    // disco (fileCrypto.js, AES-256-GCM) — nunca texto puro, nunca a URL
    // temporária do Discord. `status` reflete o veredito do MESMO
    // reviewer humano que decide o Payment (nunca uma validação
    // automática de conteúdo).
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_proofs (
            id TEXT PRIMARY KEY,
            order_id INTEGER NOT NULL,
            storage_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            mime_type TEXT,
            original_filename TEXT,
            size_bytes INTEGER,
            uploaded_by_user_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'submitted',
            reviewed_by_admin_id TEXT,
            review_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES commerce_orders(id),
            FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id),
            FOREIGN KEY (reviewed_by_admin_id) REFERENCES users(id)
        )
    `);

    // FASE 5 COMERCIAL (retenção de comprovantes): marca quando o arquivo
    // em disco de um comprovante foi apagado por retenção — a LINHA nunca
    // é apagada (mantém o histórico/auditoria de que aquele comprovante
    // existiu e foi revisado), só o arquivo cifrado em disco.
    try { db.exec(`ALTER TABLE commerce_proofs ADD COLUMN purged_at DATETIME`); } catch { /* já existe */ }

    // Estrutura de canais/categorias da loja comercial (Fase 3) — separada
    // de `sales_config` (legado: category_id/admin_role_id são de UM
    // canal de carrinho por vez). Uma linha só (id=1), preenchida pelo
    // comando de setup (idempotente — nunca recria se já configurado).
    db.exec(`
        CREATE TABLE IF NOT EXISTS commerce_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            guild_id TEXT,
            public_category_id TEXT,
            sales_panel_channel_id TEXT,
            faq_channel_id TEXT,
            staff_category_id TEXT,
            staff_panel_channel_id TEXT,
            orders_review_channel_id TEXT,
            proofs_channel_id TEXT,
            sales_log_channel_id TEXT,
            staff_role_id TEXT
        )
    `);
    db.prepare('INSERT OR IGNORE INTO commerce_config (id) VALUES (1)').run();

    // INDICES
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_creator ON bots(creator_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_code ON bots(code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_node ON bots(node_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_collaborators_bot ON bot_collaborators(bot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_collaborators_user ON bot_collaborators(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_backups_bot ON backups(bot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_env_bot ON env_variables(bot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_bot ON logs(bot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_history_user ON action_history(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_incidents_bot ON incidents(bot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantine_bot ON quarantine_entries(bot_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantine_incident ON quarantine_entries(incident_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commerce_orders_user_status ON commerce_orders(user_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commerce_orders_status ON commerce_orders(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commerce_entitlements_user_status ON commerce_entitlements(user_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commerce_proofs_order ON commerce_proofs(order_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commerce_products_status ON commerce_products(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_commerce_provisioning_attempts_order ON commerce_provisioning_attempts(order_id)`);

    // CORREÇÃO (defesa em profundidade — race condition de porta): garante no
    // nível do banco que duas linhas nunca tenham a mesma porta não-nula, mesmo
    // que algum código futuro contorne a reserva em memória do portManager.js.
    // Índice único PARCIAL (WHERE port IS NOT NULL) porque vários bots sem porta
    // (ex: bots comuns do Discord, que não usam porta) precisam poder ter
    // port = NULL simultaneamente sem conflito.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_port_unique ON bots(port) WHERE port IS NOT NULL`);

    // CORREÇÃO (performance): consultas como getAllLogs()/getUserHistory() fazem
    // ORDER BY created_at DESC LIMIT ? — sem índice em created_at, isso exige
    // varrer e ordenar a tabela inteira a cada chamada, o que fica lento à
    // medida que o histórico cresce (tabelas sem limpeza/retenção).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_action_history_created ON action_history(created_at)`);

    console.log('✅ Banco de dados v8.0 ENTERPRISE (MULTI-PLATFORM) inicializado com sucesso!');
}

// HELPERS DE CONSULTA
//
// CORREÇÃO (performance): antes cada chamada fazia db.prepare(sql) do zero,
// mesmo para o EXATO mesmo texto de SQL repetido centenas de vezes (ex: o
// watchdog do monitorManager chama get() para cada bot a cada 30s). Preparar
// uma statement no SQLite não é gratuito — recompila o plano de execução.
// Como o texto do SQL sempre vem do código-fonte (nunca de input do usuário),
// é seguro cachear as prepared statements indefinidamente por texto de SQL.
const statementCache = new Map();

function getStatement(sql) {
    let stmt = statementCache.get(sql);
    if (!stmt) {
        stmt = db.prepare(sql);
        statementCache.set(sql, stmt);
    }
    return stmt;
}

function query(sql, params = []) {
    return getStatement(sql).all(...params);
}

function run(sql, params = []) {
    return getStatement(sql).run(...params);
}

function get(sql, params = []) {
    return getStatement(sql).get(...params);
}

module.exports = {
    db,
    dbPath,
    initDatabase,
    query,
    run,
    get,
};
