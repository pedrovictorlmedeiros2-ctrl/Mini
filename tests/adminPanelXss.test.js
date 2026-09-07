const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regressão para uma vulnerabilidade real encontrada em auditoria: o painel
// administrativo montava onclick="acao('${id}','${escapeHtml(nome)}')" inline
// no HTML. escapeHtml() escapa pra contexto HTML (ex: ' -> &#39;), mas o
// navegador decodifica entidades HTML do VALOR DO ATRIBUTO antes de rodar seu
// conteúdo como JavaScript — ou seja, &#39; volta a virar ' a tempo de fechar
// a string do onclick e injetar JS arbitrário através do nome do bot (que o
// próprio cliente hospedado controla via "Editar Nome"). Isso permitia XSS
// armazenado que rouba o WEB_PANEL_TOKEN (localStorage, controle total da
// plataforma) do navegador de um admin que abrisse o painel.
//
// Não há jsdom neste projeto pra simular o navegador de verdade, então esta
// é uma checagem estática: garante que o padrão vulnerável (onclick inline
// com dado interpolado) não volta a aparecer no arquivo.
test('painel administrativo não usa onclick inline com dado de bot interpolado (regressão de XSS)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'), 'utf8');
    assert.ok(!/onclick="[^"]*\$\{/.test(html), 'nenhum onclick inline deve interpolar template literal diretamente — use data-* + addEventListener');
});

test('escapeHtml sozinho não é seguro dentro de onclick="...\'${x}\'..." (documentação do porquê da correção)', () => {
    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    // Simula o que um navegador faz: decodifica entidades HTML do valor do
    // atributo antes de tratar a string como JavaScript.
    function decodeHtmlEntities(s) {
        return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    const maliciousName = "');window.__pwned=true;//";
    const escaped = escapeHtml(maliciousName);
    const attrValue = `act('id123','${escaped}')`;
    const decodedForJsEngine = decodeHtmlEntities(attrValue);
    // Prova que a string decodificada fecha a chamada de act() cedo e permite
    // JS arbitrário depois — exatamente o motivo pelo qual precisamos evitar
    // onclick inline com dado do usuário, mesmo escapado.
    assert.ok(decodedForJsEngine.includes("act('id123','');"), 'demonstra o bypass: escapeHtml não protege contexto onclick inline');
});
