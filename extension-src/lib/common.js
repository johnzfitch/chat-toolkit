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

    const COLORS = {
        claude: '#d4a574',
        chatgpt: '#74aa9c',
        grok: '#6b7280',
        openrouter: '#6566f1',
        gemini: '#8ab4f8',
        aistudio: '#a78bfa'
    };

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

    const escapeHTML = (text) => (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // Google's batchexecute responses (Gemini lives entirely on
    // /_/BardChatUi/data/batchexecute) are not plain JSON. They are an
    // anti-JSON-hijack prefix `)]}'`, then a sequence of length-prefixed
    // chunks: a line with a byte count, then a line with a JSON array. Each
    // array holds `["wrb.fr", <rpcid>, "<stringified-inner-json>", ...]` rows.
    // This decodes every chunk and returns the parsed inner payloads keyed by
    // rpcid. (A copy lives in injected.js, which runs in the page world and
    // can't see this namespace.)
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

    const compactObject = (obj) => Object.fromEntries(Object.entries(obj).filter(([, value]) => {
        if (value == null) return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value).length > 0;
        if (typeof value === 'string') return value.trim().length > 0;
        return true;
    }));

    const unwrap = (value) => {
        try { return typeof XPCNativeWrapper !== 'undefined' && value ? XPCNativeWrapper.unwrap(value) : value; }
        catch { return value; }
    };

    // Re-serialize across the content-script / page boundary so we never leak
    // wrapped references into the page (or vice versa).
    const cloneForPage = (value) => {
        const plain = (() => {
            try { return JSON.parse(safeStringify(value)); }
            catch { return { value: String(value ?? '') }; }
        })();

        try { return typeof cloneInto === 'function' ? cloneInto(plain, window) : plain; }
        catch { return plain; }
    };

    window.__chatToolkit = {
        PLATFORM,
        COLORS,
        isGoogle: PLATFORM === 'gemini' || PLATFORM === 'aistudio',
        pageColor: COLORS[PLATFORM],
        safeStringify,
        escapeHTML,
        decodeBatchExecute,
        batchPayload,
        compactObject,
        unwrap,
        cloneForPage,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    };
})();
