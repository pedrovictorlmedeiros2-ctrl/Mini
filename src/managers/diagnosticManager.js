/**
 * GERENCIADOR DE DIAGNÓSTICO IA (GROQ)
 * Analisa logs de erro e sugere soluções usando IA.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// CORREÇÃO: llama-3.1-70b-versatile nunca foi um model ID válido da Groq (o
// certo seria llama-3.3-70b-versatile), e mesmo esse foi descontinuado pela
// Groq em 17/06/2026. openai/gpt-oss-120b é o substituto recomendado
// oficialmente pela Groq para essa classe de modelo (qualidade equivalente,
// mais rápido). Toda chamada à IA neste arquivo usa este model ID.
const GROQ_MODEL = 'openai/gpt-oss-120b';

/**
 * Analisa os logs de um bot usando a IA da Groq
 */
async function analyzeBotLogs(botId, logs) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        return "⚠️ IA de Diagnóstico indisponível (GROQ_API_KEY não configurada).";
    }

    if (!logs || logs.trim() === "") {
        return "Nenhum log disponível para análise.";
    }

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: GROQ_MODEL,
            messages: [
                {
                    role: "system",
                    content: "Você é um especialista em suporte técnico de hospedagem de bots Discord (Node.js e Python). Analise os logs fornecidos, identifique o erro e sugira uma solução curta e direta em português."
                },
                {
                    role: "user",
                    content: `Analise estes logs de erro e diga o que está errado e como corrigir:\n\n${logs.substring(0, 2000)}`
                }
            ],
            temperature: 0.5,
            max_tokens: 500
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000,
        });

        return response.data.choices[0].message.content;
    } catch (err) {
        console.error('❌ Erro na API da Groq:', err.message);
        return "⚠️ Falha ao conectar com a IA de Diagnóstico.";
    }
}

/**
 * NOVA FEATURE: quando o deploy (via ZIP ou GitHub) não consegue detectar a
 * linguagem/arquivo principal pela heurística simples (procurar index.js,
 * main.py etc.), pedimos pra IA da Groq analisar a listagem de arquivos (e o
 * conteúdo de manifestos como package.json/requirements.txt, quando existem)
 * e sugerir a linguagem, o arquivo principal e o framework usado.
 *
 * IMPORTANTE (segurança): a IA pode alucinar ou, em tese, ser manipulada por
 * conteúdo malicioso dentro do próprio ZIP enviado pelo usuário (prompt
 * injection via nome de arquivo ou conteúdo de um manifesto). Por isso o
 * mainFile sugerido pela IA NUNCA é confiado cegamente — sempre validamos
 * que o arquivo sugerido realmente existe dentro da pasta do bot antes de
 * usar a sugestão pra qualquer coisa.
 */
async function detectLanguageWithAI(folderPath) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        return { success: false, reason: 'GROQ_API_KEY não configurada — não é possível usar detecção automática por IA.' };
    }

    // Monta uma listagem rasa da pasta (até 2 níveis, até 80 itens) — não manda
    // conteúdo de arquivos binários nem a pasta inteira, só a estrutura.
    function walk(dir, prefix, depth, out) {
        if (depth > 2 || out.length >= 80) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            out.push(rel + (entry.isDirectory() ? '/' : ''));
            if (entry.isDirectory() && out.length < 80) walk(path.join(dir, entry.name), rel, depth + 1, out);
        }
    }
    const fileList = [];
    walk(folderPath, '', 0, fileList);

    if (fileList.length === 0) {
        return { success: false, reason: 'Pasta vazia, nada para analisar.' };
    }

    // Inclui o conteúdo de manifestos comuns, se existirem — ajuda MUITO a IA
    // a acertar (package.json diz a linguagem e às vezes até o "main"/"start").
    const manifests = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile'];
    let manifestContent = '';
    for (const m of manifests) {
        const p = path.join(folderPath, m);
        if (fs.existsSync(p)) {
            try {
                manifestContent += `\n--- ${m} ---\n${fs.readFileSync(p, 'utf8').substring(0, 1500)}\n`;
            } catch { /* Ignora arquivo ilegível */ }
        }
    }

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: GROQ_MODEL,
            messages: [
                {
                    role: 'system',
                    content:
                        'Você identifica a linguagem de programação, o arquivo de entrada (main file) e o framework ' +
                        'de projetos de bot de Discord a partir da estrutura de arquivos. Responda ESTRITAMENTE em ' +
                        'JSON válido, sem markdown, sem texto extra, no formato: ' +
                        '{"language": "javascript"|"python"|null, "mainFile": "caminho/relativo/arquivo.ext"|null, ' +
                        '"framework": "discord.js"|"discord.py"|"outro"|null, "confidence": "alta"|"media"|"baixa"}. ' +
                        'Se não conseguir determinar com alguma confiança, use null nos campos correspondentes.'
                },
                {
                    role: 'user',
                    content: `Estrutura de arquivos do projeto:\n${fileList.join('\n')}\n${manifestContent}`
                }
            ],
            temperature: 0.2,
            max_tokens: 300,
            response_format: { type: 'json_object' },
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000,
        });

        const raw = response.data.choices[0].message.content;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { success: false, reason: 'A IA respondeu em um formato inesperado.' };
        }

        if (!parsed.language || !parsed.mainFile) {
            return { success: false, reason: 'A IA não conseguiu identificar a linguagem/arquivo principal com confiança suficiente.' };
        }

        // VALIDAÇÃO CRÍTICA: nunca confiar cegamente no caminho sugerido pela IA.
        // Precisa existir de verdade dentro da pasta do bot, sem escapar dela.
        const resolvedRoot = path.resolve(folderPath);
        const resolvedFile = path.resolve(folderPath, parsed.mainFile);
        if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) {
            return { success: false, reason: 'A IA sugeriu um caminho fora da pasta do bot — sugestão ignorada por segurança.' };
        }
        if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
            return { success: false, reason: `A IA sugeriu "${parsed.mainFile}", mas esse arquivo não existe de verdade na pasta enviada.` };
        }
        if (parsed.language !== 'javascript' && parsed.language !== 'python') {
            return { success: false, reason: `Linguagem sugerida pela IA (${parsed.language}) não é suportada por esta hospedagem (só Node.js e Python).` };
        }

        return {
            success: true,
            language: parsed.language,
            mainFile: parsed.mainFile,
            framework: parsed.framework || null,
            confidence: parsed.confidence || 'media',
        };
    } catch (err) {
        console.error('❌ Erro na detecção de linguagem via Groq:', err.message);
        return { success: false, reason: 'Falha ao conectar com a IA de detecção.' };
    }
}

module.exports = {
    analyzeBotLogs,
    detectLanguageWithAI,
};
