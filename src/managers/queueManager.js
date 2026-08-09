/**
 * GERENCIADOR DE FILA DE TAREFAS — v2.0
 * Fila com concorrência controlada, prioridades e métricas.
 *
 * Melhorias vs v1:
 * - Concorrência configurável (não mais estritamente serial)
 * - Prioridades (high / normal / low)
 * - Timeout por tarefa
 * - Métricas (processadas, falhas, tempo médio)
 * - Cancelamento graceful
 */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

const PRIORITY = { high: 0, normal: 1, low: 2 };

const queue = [];
let activeCount = 0;
let concurrency = DEFAULT_CONCURRENCY;
let stopped = false;

const metrics = {
    processed: 0,
    failed: 0,
    totalDurationMs: 0,
};

/**
 * @param {Function} taskFn
 * @param {string} description
 * @param {{ priority?: 'high'|'normal'|'low', timeoutMs?: number }} options
 */
function addToQueue(taskFn, description = 'Tarefa sem nome', options = {}) {
    const priority = PRIORITY[options.priority] ?? PRIORITY.normal;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        const item = {
            taskFn,
            description,
            priority,
            timeoutMs,
            resolve,
            reject,
            enqueuedAt: Date.now(),
        };

        // Inserção ordenada por prioridade (menor número = mais prioritário)
        let inserted = false;
        for (let i = 0; i < queue.length; i++) {
            if (priority < queue[i].priority) {
                queue.splice(i, 0, item);
                inserted = true;
                break;
            }
        }
        if (!inserted) queue.push(item);

        console.log(`[QUEUE] + ${description} | prio=${options.priority || 'normal'} | fila=${queue.length} | ativos=${activeCount}`);
        processQueue();
    });
}

async function processQueue() {
    if (stopped) return;

    while (activeCount < concurrency && queue.length > 0) {
        const item = queue.shift();
        activeCount += 1;
        runTask(item).finally(() => {
            activeCount -= 1;
            // Pequeno respiro entre tarefas para não saturar I/O
            setTimeout(processQueue, 200);
        });
    }
}

async function runTask(item) {
    const { taskFn, description, timeoutMs, resolve, reject, enqueuedAt } = item;
    const started = Date.now();
    console.log(`[QUEUE] ▶ ${description} (espera ${started - enqueuedAt}ms)`);

    let timer;
    try {
        const result = await Promise.race([
            taskFn(),
            new Promise((_, rej) => {
                timer = setTimeout(
                    () => rej(new Error(`Timeout de ${Math.round(timeoutMs / 1000)}s na tarefa: ${description}`)),
                    timeoutMs
                );
            }),
        ]);
        metrics.processed += 1;
        metrics.totalDurationMs += Date.now() - started;
        resolve(result);
        console.log(`[QUEUE] ✓ ${description} (${Date.now() - started}ms)`);
    } catch (err) {
        metrics.failed += 1;
        metrics.totalDurationMs += Date.now() - started;
        console.error(`[QUEUE] ✗ ${description}:`, err.message);
        reject(err);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function getQueueSize() {
    return queue.length;
}

function getActiveCount() {
    return activeCount;
}

function getQueueMetrics() {
    const total = metrics.processed + metrics.failed;
    return {
        ...metrics,
        queued: queue.length,
        active: activeCount,
        concurrency,
        avgDurationMs: total > 0 ? Math.round(metrics.totalDurationMs / total) : 0,
    };
}

function setConcurrency(n) {
    concurrency = Math.max(1, Math.min(8, Number(n) || DEFAULT_CONCURRENCY));
    processQueue();
}

function stopQueue() {
    stopped = true;
}

function resumeQueue() {
    stopped = false;
    processQueue();
}

module.exports = {
    addToQueue,
    getQueueSize,
    getActiveCount,
    getQueueMetrics,
    setConcurrency,
    stopQueue,
    resumeQueue,
};
