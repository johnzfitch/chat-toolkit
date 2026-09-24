// Shared state and helpers for the content-script set.
// Content scripts in a single `content_scripts` entry share scope, but we
// stash things under a single namespace so file order and lookup are explicit.

(function () {
    'use strict';

    if (window.__chatToolkit) return;

    const host = location.hostname;
    const path = location.pathname;
    const PLATFORM = host === 'claude.ai' ? 'claude'
        : host.includes('chatgpt') || host.includes('openai') ? 'chatgpt'
        : host === 'grok.com' ? 'grok'
        : host === 'openrouter.ai' ? 'openrouter'
        : host.includes('gemini.google') ? 'gemini'
        : host.includes('aistudio.google') ? 'aistudio' : null;

    if (!PLATFORM) return;

    const safeStringify = (value) => {
        const seen = new WeakSet();
        const json = JSON.stringify(value, (key, current) => {
            if (typeof current === 'object' && current) {
                if (seen.has(current)) return '[Circular]';
                seen.add(current);
            }
            return current;
        }, 2);
        return json ?? String(value ?? '');
    };

    // Google's batchexecute responses (Gemini lives entirely on
    // /_/BardChatUi/data/batchexecute) are not plain JSON. They are an
    // anti-JSON-hijack prefix `)]}'`, then a sequence of length-prefixed
    // chunks: a line with a byte count, then a line with a JSON array. Each
    // array holds `["wrb.fr", <rpcid>, "<stringified-inner-json>", ...]` rows.
    // This decodes every chunk and returns the parsed inner payloads keyed by
    // rpcid. (background.js keeps its own copy; the background page cannot
    // see this content-script namespace.)
    const decodeBatchExecute = (text) => {
        if (typeof text !== 'string') return [];
        const body = text.replace(/^\)\]\}'?\s*/, '');
        const lines = body.split('\n');
        const payloads = [];
        for (let i = 0; i < lines.length; i++) {
            if (!/^\d+$/.test(lines[i].trim())) continue;
            const chunk = lines[i + 1];
            if (!chunk) continue;
            let parsed;
            try { parsed = JSON.parse(chunk); } catch { continue; }
            if (!Array.isArray(parsed)) continue;
            for (const row of parsed) {
                if (Array.isArray(row) && row[0] === 'wrb.fr' && typeof row[2] === 'string') {
                    let data = null;
                    try { data = JSON.parse(row[2]); } catch {}
                    if (data != null) payloads.push({ rpcid: row[1], data });
                }
            }
        }
        return payloads;
    };

    // Pull the parsed payload for a given rpcid out of a decoded batch.
    const batchPayload = (payloads, rpcid) =>
        (payloads || []).find((p) => p.rpcid === rpcid)?.data ?? null;

    window.__chatToolkit = {
        PLATFORM,
        isGoogle: PLATFORM === 'gemini' || PLATFORM === 'aistudio',
        safeStringify,
        decodeBatchExecute,
        batchPayload,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    };
})();
