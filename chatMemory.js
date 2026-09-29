const fs = require('fs');
const path = require('path');

let memoryGraph = null;
const graphPath = path.join(__dirname, 'chat-memory-graph', 'graph.json');

try {
    if (fs.existsSync(graphPath)) {
        memoryGraph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
        console.log(`[MemoryGraph] Loaded ${memoryGraph.nodes.length} nodes & ${(memoryGraph.links || []).length} edges for Himanshi & Roshan`);
    }
} catch (e) {
    console.error('[MemoryGraph] Error loading graph:', e.message);
}

/**
 * Searches the Graphify knowledge graph for relevant past memories,
 * shared events, inside jokes, and milestones between Roshan and Himanshi.
 */
function queryChatMemory(userQuery, { allowed = true } = {}) {
    if (!allowed || !memoryGraph || !memoryGraph.nodes || !userQuery) return '';
    const qLower = String(userQuery).toLowerCase().slice(0, 300);

    // Intentional triggers only: explicit "remember/recall" phrasing, or rare, specific
    // shared-memory names. Everyday words (video, coffee, exam, ...) must NOT trigger recall.
    const recallPhrases = [
        'yaad hai', 'yaad h', 'yaad aa', 'yad hai', 'do you remember', 'remember when', 'remember that',
        'kya hua tha', 'kab hua tha', 'uss din', 'us din', 'purani baat', 'pehle ki baat', 'last time we'
    ];
    const specificTopics = [
        'ssb', 'curfew', '6 bje', '6 baje', 'braces', 'scooty', 'white shirt', 'papaji',
        'hardik', 'ravi', 'shruti', 'lallu', 'chote don'
    ];

    // Whole-word/phrase match (keywords are plain alphanumerics + spaces)
    const hasWord = kw => new RegExp(`(^|[^a-z0-9])${kw}([^a-z0-9]|$)`).test(qLower);
    const hasTrigger = recallPhrases.some(hasWord) || specificTopics.some(hasWord);
    if (!hasTrigger) return '';

    const words = qLower.split(/[\s,?.!]+/).filter(w => w.length > 2);
    const matched = [];

    for (const node of memoryGraph.nodes) {
        const label = (node.label || '').toLowerCase();
        const rationale = (node.rationale || '').toLowerCase();
        let score = 0;
        for (const w of words) {
            if (label.includes(w)) score += 3;
            if (rationale.includes(w)) score += 1;
        }
        if (score >= 3) {
            matched.push({ node, score });
        }
    }

    matched.sort((a, b) => b.score - a.score);
    const top = matched.slice(0, 2);
    if (top.length === 0) return '';

    const clip = t => (t.length > 160 ? t.slice(0, 157) + '...' : t);
    return '\n[PRIVATE BACKGROUND CONTEXT - never quote, list, or mention this; use only to stay consistent if directly relevant]:\n' +
        top.map(m => `- ${clip(`${m.node.label}: ${m.node.rationale || ''}`)}`).join('\n') + '\n';
}

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Scans recent chat turns (newest first) for the most recently mentioned email address.
 * `history` is an array of { role, content }. Returns the address or null.
 */
function findRecentEmail(history, { maxTurns = 10, exclude = [] } = {}) {
    if (!Array.isArray(history)) return null;
    const skip = new Set(exclude.map(e => String(e).toLowerCase()));
    const recent = history.slice(-maxTurns);
    for (let i = recent.length - 1; i >= 0; i--) {
        const matches = String((recent[i] && recent[i].content) || '').match(EMAIL_PATTERN);
        if (!matches) continue;
        for (let j = matches.length - 1; j >= 0; j--) {
            if (!skip.has(matches[j].toLowerCase())) return matches[j];
        }
    }
    return null;
}

/**
 * Per-key sequential task queue (a promise chain per chat). Tasks for the same key run strictly
 * one at a time in arrival order; a failing task never blocks the ones behind it.
 * Different keys run concurrently.
 */
function createSequentialQueue() {
    const tails = new Map();
    return function enqueue(key, task) {
        const prev = tails.get(key) || Promise.resolve();
        const run = prev.then(() => task());
        const tail = run.catch(() => {});
        tails.set(key, tail);
        tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
        return run;
    };
}

module.exports = { queryChatMemory, findRecentEmail, createSequentialQueue };
