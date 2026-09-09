/**
 * TESTES — Etapa 1 (Universal Project Foundation)
 *
 * Cobre só a abstração `Project` (camada de compatibilidade somente-
 * leitura sobre a tabela `bots` já existente) — não re-testa nada da
 * tabela `bots` em si, que já é coberta pelos testes de bots/processos
 * existentes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-projectManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run } = require('../src/database/database');
initDatabase();

const ProjectManager = require('../src/managers/ProjectManager');

let counter = 0;
function makeUser() {
    counter += 1;
    const userId = `pm-user-${counter}`;
    run('INSERT INTO users (id, username, role) VALUES (?, ?, ?)', [userId, 'tester', 'client']);
    return userId;
}

/** Insere uma linha de `bots` real, do mesmo jeito que o sistema já faz hoje. */
function makeBotRow(ownerId, overrides = {}) {
    counter += 1;
    const id = `pm-bot-${counter}`;
    const fields = {
        id,
        code: `PMB${counter}`,
        name: `Bot de Teste ${counter}`,
        description: null,
        type: 'bot',
        language: 'javascript',
        main_file: 'index.js',
        max_memory: null,
        max_cpu_limit: null,
        github_repo: null,
        github_branch: 'main',
        creator_id: ownerId,
        folder_path: `/tmp/pm-bot-${counter}`,
        status: 'offline',
        ...overrides,
    };
    run(
        `INSERT INTO bots (id, code, name, description, type, language, main_file, max_memory, max_cpu_limit, github_repo, github_branch, creator_id, folder_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fields.id, fields.code, fields.name, fields.description, fields.type, fields.language, fields.main_file,
         fields.max_memory, fields.max_cpu_limit, fields.github_repo, fields.github_branch, fields.creator_id,
         fields.folder_path, fields.status]
    );
    return fields;
}

test('PROJECT_TYPE.DISCORD_BOT: bot com type="bot" é mapeado corretamente, com todos os campos conceituais presentes', () => {
    const owner = makeUser();
    const bot = makeBotRow(owner, { max_memory: 512, max_cpu_limit: 40, github_repo: 'user/repo' });

    const project = ProjectManager.getProject(bot.id);
    assert.ok(project);
    assert.equal(project.id, bot.id);
    assert.equal(project.ownerId, owner);
    assert.equal(project.name, bot.name);
    assert.equal(project.type, ProjectManager.PROJECT_TYPE.DISCORD_BOT);
    assert.equal(project.runtime, 'javascript');
    assert.equal(project.status, 'offline');
    assert.equal(project.source.folderPath, bot.folder_path);
    assert.equal(project.source.githubRepo, 'user/repo');
    assert.equal(project.resources.maxRamMB, 512);
    assert.equal(project.resources.maxCpuPercent, 40);
    assert.equal(project.metadata.code, bot.code);
});

test('mapBotTypeToProjectType: null/undefined ("bots.type" sem valor explícito) também é DISCORD_BOT — mesmo default da coluna no schema', () => {
    assert.equal(ProjectManager.mapBotTypeToProjectType(null), ProjectManager.PROJECT_TYPE.DISCORD_BOT);
    assert.equal(ProjectManager.mapBotTypeToProjectType(undefined), ProjectManager.PROJECT_TYPE.DISCORD_BOT);
    assert.equal(ProjectManager.mapBotTypeToProjectType('bot'), ProjectManager.PROJECT_TYPE.DISCORD_BOT);
});

test('mapBotTypeToProjectType: "web" (Quick Deploy) é mapeado pra NODE_APP; tipo desconhecido/legado ("minecraft") cai em OTHER, nunca inventa um tipo novo', () => {
    const owner = makeUser();
    const webBot = makeBotRow(owner, { type: 'web', language: 'javascript' });
    const webProject = ProjectManager.getProject(webBot.id);
    assert.equal(webProject.type, ProjectManager.PROJECT_TYPE.NODE_APP);

    const mcBot = makeBotRow(owner, { type: 'minecraft' });
    const mcProject = ProjectManager.getProject(mcBot.id);
    assert.equal(mcProject.type, ProjectManager.PROJECT_TYPE.OTHER);
});

test('getProject: id inexistente retorna null, nunca lança', () => {
    assert.equal(ProjectManager.getProject('projeto-que-nao-existe'), null);
});

test('listProjectsByOwner: retorna só os projetos do dono pedido, mapeados; dono sem nenhum projeto recebe lista vazia', () => {
    const ownerA = makeUser();
    const ownerB = makeUser();
    const botA1 = makeBotRow(ownerA);
    const botA2 = makeBotRow(ownerA, { type: 'web' });
    makeBotRow(ownerB); // nunca deveria aparecer na listagem de ownerA

    const projectsA = ProjectManager.listProjectsByOwner(ownerA);
    assert.equal(projectsA.length, 2);
    assert.deepEqual(projectsA.map((p) => p.id).sort(), [botA1.id, botA2.id].sort());

    const ownerC = makeUser();
    assert.deepEqual(ProjectManager.listProjectsByOwner(ownerC), []);
});

test('getProjectEnvironment: retorna as variáveis reais de env_variables como {chave: valor}; projeto sem nenhuma retorna objeto vazio', () => {
    const owner = makeUser();
    const bot = makeBotRow(owner);
    run('INSERT INTO env_variables (bot_id, key, value) VALUES (?, ?, ?)', [bot.id, 'API_KEY', 'segredo-123']);
    run('INSERT INTO env_variables (bot_id, key, value) VALUES (?, ?, ?)', [bot.id, 'NODE_ENV', 'production']);

    const env = ProjectManager.getProjectEnvironment(bot.id);
    assert.deepEqual(env, { API_KEY: 'segredo-123', NODE_ENV: 'production' });

    const otherBot = makeBotRow(owner);
    assert.deepEqual(ProjectManager.getProjectEnvironment(otherBot.id), {});
});

test('projectFromBotRow: linha nula/indefinida retorna null, nunca lança — permite encadear getProject() sem checagem extra', () => {
    assert.equal(ProjectManager.projectFromBotRow(null), null);
    assert.equal(ProjectManager.projectFromBotRow(undefined), null);
});
