/**
 * PROJECT MANAGER (Etapa 1 — Universal Project Foundation)
 *
 * Primeira camada de abstração do Atlantic Host rumo a "Universal
 * Project Hosting". Hoje o sistema só entende "bot" como entidade
 * hospedada (tabela `bots`, usada em ~30 arquivos e ~157 queries
 * diretas — ver auditoria desta etapa). Reescrever isso agora seria
 * uma migração destrutiva disfarçada de abstração — o que esta etapa
 * explicitamente NÃO deve fazer.
 *
 * Em vez disso, este módulo é uma CAMADA DE COMPATIBILIDADE somente-
 * leitura: `Project` é a visão conceitual de um recurso hospedado
 * (Discord bot hoje; site estático, app Node/Python, container Docker
 * no futuro), montada a partir da linha real de `bots` — sem tabela
 * nova, sem escrita nova, sem tocar em nenhum dos ~30 arquivos que já
 * usam `bots` diretamente. Esses continuam funcionando exatamente como
 * antes; este módulo é só uma ponte por cima deles.
 *
 * Escopo desta etapa: SÓ o tipo DISCORD_BOT é de fato compreendido e
 * mapeado a partir de dados reais. Os demais tipos abaixo existem
 * apenas como constantes reservadas para etapas futuras — nenhuma
 * lógica de provisionamento, deploy ou UI é implementada para eles
 * aqui.
 */
const { get, query } = require('../database/database');

const PROJECT_TYPE = Object.freeze({
    DISCORD_BOT: 'DISCORD_BOT',
    // Reservados para etapas futuras — sem implementação nesta etapa.
    STATIC_SITE: 'STATIC_SITE',
    NODE_APP: 'NODE_APP',
    PYTHON_APP: 'PYTHON_APP',
    DOCKER_APP: 'DOCKER_APP',
    // Qualquer `bots.type` que já exista no banco e não seja um dos
    // mapeamentos conhecidos abaixo (ex.: 'minecraft') cai aqui — nunca
    // inventamos um tipo novo silenciosamente só para "encaixar" um
    // dado legado.
    OTHER: 'OTHER',
});

/**
 * `bots.type` é um TEXT livre, sem enum no banco (valores conhecidos
 * hoje: 'bot' — default —, 'web', 'minecraft'). Este mapeamento é
 * puramente descritivo: só categoriza o que já existe, nunca decide
 * comportamento algum (isso continua 100% nos managers/handlers atuais).
 */
function mapBotTypeToProjectType(rawType) {
    switch (rawType) {
        case 'bot':
        case null:
        case undefined:
            return PROJECT_TYPE.DISCORD_BOT;
        // Quick Deploy ("Adicionar Site/App") já gera um app Node/Express
        // real (package.json + index.js) sob `type = 'web'` — o
        // mapeamento mais honesto disponível hoje é NODE_APP, não
        // DISCORD_BOT nem um tipo genérico "site" que ainda não existe.
        case 'web':
            return PROJECT_TYPE.NODE_APP;
        default:
            return PROJECT_TYPE.OTHER;
    }
}

/**
 * Monta a visão `Project` a partir de uma linha real de `bots`. Nunca
 * decide nada — só relê e reorganiza campos que já existem. Retorna
 * `null` para `row` nulo/indefinido (nunca lança), pra chamadores
 * poderem encadear com `getProject()` sem checagem extra.
 */
function projectFromBotRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        ownerId: row.creator_id,
        name: row.name,
        type: mapBotTypeToProjectType(row.type),
        runtime: row.language || null,
        status: row.status,
        source: {
            folderPath: row.folder_path,
            githubRepo: row.github_repo || null,
            githubBranch: row.github_branch || null,
        },
        resources: {
            // Mesma precedência já documentada em processManager.js:
            // limite do projeto (se definido) > limite do plano/entitlement
            // do usuário (fora do escopo deste objeto) > default de config.
            maxRamMB: row.max_memory ?? null,
            maxCpuPercent: row.max_cpu_limit ?? null,
        },
        // Carregamento tardio de propósito — ver getProjectEnvironment().
        // Nunca pré-carregado aqui para não pagar o custo de uma query
        // extra em toda listagem que nem precisa disso.
        environment: null,
        metadata: {
            code: row.code,
            nodeId: row.node_id,
            suspended: !!row.suspended,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        },
    };
}

/** Busca um Project pelo id. `null` se não existir — nunca lança. */
function getProject(projectId) {
    return projectFromBotRow(get('SELECT * FROM bots WHERE id = ?', [projectId]));
}

/** Todos os Projects de um dono, na mesma ordem que `bots` já usa hoje. */
function listProjectsByOwner(ownerId) {
    return query('SELECT * FROM bots WHERE creator_id = ? ORDER BY created_at ASC', [ownerId]).map(projectFromBotRow);
}

/**
 * Variáveis de ambiente do Project, como um objeto simples `{chave: valor}`.
 * Mesmo padrão de leitura já usado por processManager.js (sem cifra —
 * `env_variables.value` já é gravado em texto puro por todo o sistema
 * atual; este helper não introduz nem remove nenhuma camada de
 * segurança que já não existisse).
 */
function getProjectEnvironment(projectId) {
    const rows = query('SELECT key, value FROM env_variables WHERE bot_id = ?', [projectId]);
    return rows.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
    }, {});
}

module.exports = {
    PROJECT_TYPE,
    mapBotTypeToProjectType,
    projectFromBotRow,
    getProject,
    listProjectsByOwner,
    getProjectEnvironment,
};
