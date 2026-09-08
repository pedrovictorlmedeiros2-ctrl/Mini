/**
 * REDAÇÃO/ALLOWLIST PRO GROQ (SecurityMonitor — Fase 2)
 *
 * Princípio central: em vez de tentar "limpar" texto livre de segredos
 * (frágil, incompleto por definição — sempre existe um padrão que a regex
 * não pegou), o payload enviado ao Groq usa uma ALLOWLIST ESTRITA de
 * campos estruturados (código enumerado, categoria, severidade, contagem,
 * timestamps, um pseudônimo opaco no lugar do botId real). Não há campo de
 * texto livre no payload final — então não há onde um token, secret,
 * trecho de código ou tentativa de prompt injection (vinda de um log de
 * bot) possa vazar, por CONSTRUÇÃO, não por tentativa de filtro.
 *
 * `redactText`/`redactPathForGroq` existem como camada adicional de
 * defesa em profundidade (aplicadas a qualquer campo textual que ainda
 * assim precise ser considerado, como `matchedPath` vindo do
 * security_wrapper) — nunca são a única linha de defesa.
 */
const crypto = require('crypto');

const MAX_EVENTS_PER_PAYLOAD = 20;
const MAX_TEXT_LENGTH = 200;

/**
 * Nunca deixa um erro de serialização (ex.: referência circular vinda de
 * um bug em quem monta o evento) propagar — mesmo padrão já usado em
 * SecurityEngine.js/IncidentResponseManager.js nesta mesma linha de
 * trabalho (Kamikaze).
 */
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch (err) {
        try {
            return JSON.stringify({ __unserializable: true, reason: err.message });
        } catch {
            return '{"__unserializable":true}';
        }
    }
}

/**
 * Scrub de padrões comuns de segredo em texto livre. Camada de defesa em
 * profundidade — nunca é a única proteção (ver o comentário do arquivo).
 *
 * @param {string} text
 * @param {{maxLength?: number}} [options]
 * @returns {string|null}
 */
// Teto defensivo no tamanho de ENTRADA antes de rodar qualquer regex —
// achado em revisão de segurança adversarial: sem isto, um texto livre
// absurdamente grande (ex.: resposta de um endpoint comprometido/MITM, já
// que o `summary` do Groq acaba passando por aqui) força as 3 regexes a
// varrer o texto INTEIRO antes de qualquer corte por tamanho acontecer.
// Nenhum uso legítimo desta função precisa de mais que uns poucos KB de
// entrada (a saída final nunca passa de MAX_TEXT_LENGTH mesmo assim).
const MAX_INPUT_LENGTH_BEFORE_SCRUB = 5000;

function redactText(text, options = {}) {
    if (typeof text !== 'string') return null;
    const maxLength = options.maxLength ?? MAX_TEXT_LENGTH;

    let out = text.length > MAX_INPUT_LENGTH_BEFORE_SCRUB ? text.slice(0, MAX_INPUT_LENGTH_BEFORE_SCRUB) : text;
    // Formato de token do Discord bot (3 segmentos separados por ponto).
    out = out.replace(/[\w-]{20,30}\.[\w-]{6,10}\.[\w-]{20,40}/g, '[REDACTED_TOKEN]');
    // "KEY=valor"/"KEY: valor" onde KEY sugere ser um segredo (env-like).
    out = out.replace(/\b([A-Z_][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
    // Blob genérico longo (hex/base64-like) — chave/segredo sem nome óbvio.
    out = out.replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, '[REDACTED_SECRET]');

    if (out.length > maxLength) {
        out = out.slice(0, maxLength) + '…[truncado]';
    }
    return out;
}

// Marcadores de caminho que sugerem arquivo sensível da PLATAFORMA — mesma
// lista de espírito usada em processManager.js pro achado "evidência dura".
const PLATFORM_SECRET_MARKERS = /\.env\b|hosting\.db|ENCRYPTION_KEY|GITHUB_WEBHOOK_SECRET/i;

/**
 * Nunca envia um caminho de arquivo real pro Groq — só um hash não
 * reversível (pra correlação: "é o mesmo caminho de antes?") e uma
 * categoria ampla (nunca o nome real do arquivo/pasta).
 *
 * @param {string} rawPath
 * @returns {{hash: string, category: 'platform_secret_like'|'generic'}|null}
 */
function redactPathForGroq(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath) return null;
    const hash = crypto.createHash('sha256').update(rawPath).digest('hex').slice(0, 12);
    const category = PLATFORM_SECRET_MARKERS.test(rawPath) ? 'platform_secret_like' : 'generic';
    return { hash, category };
}

/**
 * Constrói um pseudônimo opaco e estável (por processo) pra um botId, pra
 * nunca enviar o ID real da plataforma pro Groq. A resposta do Groq nunca
 * deveria ecoar nem usar esse pseudônimo pra nada — ele existe só como
 * rótulo de correlação dentro de UM ÚNICO request (um bot por vez, nunca
 * misturado — ver SignalCollector.js).
 */
function pseudonymFor(botId) {
    return crypto.createHash('sha256').update(String(botId)).digest('hex').slice(0, 10);
}

/**
 * Monta o payload final enviado ao Groq: só campos da allowlist, nunca
 * texto livre arbitrário, com teto de quantidade de eventos (evita um
 * payload excessivo/DoS-adjacente e mantém o prompt pequeno e previsível).
 *
 * @param {string} botId - usado só pra gerar o pseudônimo, nunca incluído cru
 * @param {Array<{code:string, source:string, category:string, severity:string, occurrences:number, firstSeenAt:string, lastSeenAt:string, matchedPath?:string}>} events
 * @returns {{ref: string, events: Array<object>}}
 */
function buildGroqEventPayload(botId, events) {
    const ref = pseudonymFor(botId);
    const safeEvents = Array.isArray(events) ? events.slice(0, MAX_EVENTS_PER_PAYLOAD) : [];

    const allowlisted = safeEvents.map((event) => {
        const item = {
            code: typeof event.code === 'string' ? event.code.slice(0, 60) : 'unknown',
            source: typeof event.source === 'string' ? event.source.slice(0, 40) : 'unknown',
            category: typeof event.category === 'string' ? event.category.slice(0, 40) : 'unknown',
            severity: typeof event.severity === 'string' ? event.severity.slice(0, 20) : 'UNKNOWN',
            occurrences: Number.isFinite(event.occurrences) ? event.occurrences : 1,
            firstSeenAt: typeof event.firstSeenAt === 'string' ? event.firstSeenAt : null,
            lastSeenAt: typeof event.lastSeenAt === 'string' ? event.lastSeenAt : null,
        };
        if (event.matchedPath) {
            item.path = redactPathForGroq(event.matchedPath);
        }
        return item;
    });

    return { ref, events: allowlisted };
}

module.exports = {
    safeStringify,
    redactText,
    redactPathForGroq,
    pseudonymFor,
    buildGroqEventPayload,
    MAX_EVENTS_PER_PAYLOAD,
};
