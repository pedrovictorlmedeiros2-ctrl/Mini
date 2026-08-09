/**
 * RATE LIMITER (SLIDING WINDOW)
 *
 * O cooldown global do interactionHandler (checkCooldown, ~3s entre qualquer
 * clique) protege contra clique/spam acidental, mas não limita AÇÕES
 * específicas mais custosas ou sensíveis por conta própria — nada impedia,
 * por exemplo, criar dezenas de backups (I/O + CPU de zipar a pasta inteira)
 * em sequência, ou tentar dezenas de códigos de cupom em poucos minutos
 * (brute-force de cupom).
 *
 * Este módulo implementa um limitador de taxa genérico por "chave" (ex:
 * `backup:${userId}` ou `coupon:${userId}`), com janela deslizante em memória.
 * Como o volume de chaves distintas é proporcional ao número de usuários
 * ativos (não cresce sem limite), fazemos uma limpeza periódica de entradas
 * expiradas para não vazar memória com o tempo.
 */

// chave -> array de timestamps (ms) das ações dentro da janela atual
const buckets = new Map();

/**
 * Verifica e registra uma tentativa de ação.
 * @param {string} key - identificador único da ação+ator, ex: `backup:123456`
 * @param {number} maxRequests - quantas ações são permitidas...
 * @param {number} windowMs - ...dentro desta janela de tempo (ms)
 * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
 */
function checkRateLimit(key, maxRequests, windowMs) {
    const now = Date.now();
    const timestamps = (buckets.get(key) || []).filter(t => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
        const oldest = timestamps[0];
        const retryAfterMs = windowMs - (now - oldest);
        buckets.set(key, timestamps);
        return { allowed: false, remaining: 0, retryAfterMs };
    }

    timestamps.push(now);
    buckets.set(key, timestamps);
    return { allowed: true, remaining: maxRequests - timestamps.length, retryAfterMs: 0 };
}

/**
 * Formata um retryAfterMs em uma string curta e amigável em português.
 */
function formatRetryAfter(ms) {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes}min`;
}

// Limpeza periódica: remove chaves cujo timestamp mais recente já está bem
// fora de qualquer janela razoável, evitando crescimento ilimitado do Map.
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos
const MAX_ENTRY_AGE_MS = 60 * 60 * 1000; // 1 hora
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of buckets.entries()) {
        const freshest = timestamps[timestamps.length - 1] || 0;
        if (now - freshest > MAX_ENTRY_AGE_MS) {
            buckets.delete(key);
        }
    }
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { checkRateLimit, formatRetryAfter };
