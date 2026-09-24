// DOM extraction helpers. Anything that touches `document` lives here so it
// stays on the main thread; everything else gets dispatched to the worker.

(function () {
    'use strict';

    const CT = window.__chatToolkit;
    if (!CT) return;

    // Lightweight whitespace/emoji cleanup so DOM snapshots aren't ragged
    // before the worker even sees them. Mirrors the worker's Clean.* but
    // we keep a copy on the main thread to avoid round-tripping every cell
    // through the worker just to trim it.
    const stripEmoji = (t) => t.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu, '');
    const isArt = (line) => /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬┃┏┓┗┛┣┫┳┻╋▀▄█▌▐░▒▓]/.test(line);
    const stripUnsupported = (t) => t.replace(/```\s*\n\s*This block is not supported[^\n]*\n\s*```\s*\n?/g, '');
    const collapseWhitespace = (t) => {
        const lines = t.split('\n');
        const result = [];
        let blanks = 0;
        for (const line of lines) {
            const trimmed = line.trimEnd();
            if (!trimmed) {
                if (++blanks <= 1) result.push('');
            } else {
                blanks = 0;
                result.push(isArt(line) || line.startsWith('    ') ? line.trimEnd() : trimmed);
            }
        }
        return result.join('\n');
    };
    const cleanText = (t) => collapseWhitespace(stripEmoji(stripUnsupported(t || ''))).trim();
    const comparableText = (text) => cleanText(String(text || '')).toLowerCase().replace(/\s+/g, ' ').trim();

    const readNodeText = (node) => {
        if (!node) return '';
        const clone = node.cloneNode(true);
        clone.querySelectorAll('button, nav, form, textarea, style, script, svg').forEach((el) => el.remove());
        return cleanText(clone.innerText || clone.textContent || '');
    };

    const DOM_PROBES = {
        claude: {
            messages: [
                '[data-message-author-role]',
                '[data-testid="user-message"]',
                '[data-testid="assistant-message"]',
                '[data-testid*="human-message"]',
                '[data-testid*="agent-message"]',
                '[data-role="user"]',
                '[data-role="assistant"]',
                '[data-message-id]'
            ],
            code: ['pre', 'pre code', 'code'],
            attachments: ['a[href]', 'img', '[data-testid*="artifact"]']
        },
        chatgpt: {
            messages: ['div[data-message-author-role]', '[data-message-id]', 'article'],
            code: ['pre', 'pre code', 'code'],
            attachments: ['a[download]', 'img']
        },
        grok: {
            messages: ['.message-bubble', '[data-message-id]'],
            code: ['pre', 'pre code', 'code'],
            attachments: ['a[download]', 'img']
        },
        openrouter: {
            messages: [
                '[data-message-id] [data-testid="user-message"]',
                '[data-message-id] [data-testid="assistant-message"]',
                '[data-message-id] [data-testid="system-message"]',
                '[data-testid="playground-message-list"] [data-message-bubble]'
            ],
            code: ['[data-message-id] pre', '[data-message-id] pre code', '[data-message-id] code'],
            attachments: ['[data-message-id] a[href]', '[data-message-id] img']
        },
        gemini: {
            messages: ['user-query-content', 'message-content', 'model-response'],
            code: ['pre', 'pre code', 'code'],
            attachments: ['img', 'a[download]']
        },
        aistudio: {
            messages: ['ms-chat-turn', 'ms-text-chunk', 'mat-expansion-panel'],
            code: ['pre', 'pre code', 'code'],
            attachments: ['img', 'a[download]']
        }
    };

    const dedupeByText = (items) => {
        const seen = new Set();
        const unique = [];
        for (const item of items) {
            const key = comparableText(item.text || item.content || item.preview || '');
            if (!key || seen.has(key)) continue;
            // Drop wrappers that fully contain a shorter earlier item.
            if (unique.some((existing) => key.length > existing.key.length * 1.25 &&
                existing.key.length > 80 && key.includes(existing.key))) continue;
            seen.add(key);
            unique.push(Object.assign({}, item, { key }));
        }
        return unique;
    };

    const sourceReferenceFromLink = (link) => {
        if (!link?.href) return null;
        let url;
        try {
            url = new URL(link.href, location.href);
            // Claude sometimes wraps citation targets in a same-origin
            // redirect. Prefer the external target when it is present.
            if (url.origin === location.origin) {
                const target = url.searchParams.get('url') ||
                    url.searchParams.get('target') || url.searchParams.get('redirect');
                if (!target) return null;
                url = new URL(target, location.href);
            }
        } catch {
            return null;
        }
        if (!/^https?:$/.test(url.protocol)) return null;
        const text = readNodeText(link);
        const title = text && !/^\[?\d+\]?$/.test(text) ? text : url.hostname;
        return {
            type: 'dom_link',
            title: title.slice(0, 300),
            url: url.href,
            attribution: url.hostname
        };
    };

    const claudeRole = (node) => {
        const hint = [
            node?.getAttribute?.('data-message-author-role'),
            node?.getAttribute?.('data-role'),
            node?.getAttribute?.('data-author'),
            node?.getAttribute?.('data-testid'),
            typeof node?.className === 'string' ? node.className : ''
        ].filter(Boolean).join(' ');
        if (/(?:^|[-_\s])(user|human|prompt)(?:$|[-_\s])/i.test(hint)) return 'user';
        if (/(?:^|[-_\s])(assistant|claude|agent|response)(?:$|[-_\s])/i.test(hint)) return 'assistant';
        const roleNode = node?.querySelector?.(
            '[data-message-author-role], [data-role="user"], [data-role="assistant"]'
        );
        if (roleNode && roleNode !== node) return claudeRole(roleNode);
        return '';
    };

    const DOM = {
        claude: () => {
            const messages = [];
            const seen = new Set();
            const preciseSelector = [
                '[data-message-author-role]',
                '[data-testid="user-message"]',
                '[data-testid="assistant-message"]',
                '[data-testid*="human-message"]',
                '[data-testid*="agent-message"]',
                '[data-role="user"]',
                '[data-role="assistant"]',
                '[data-author="user"]',
                '[data-author="assistant"]'
            ].join(', ');
            let nodes = Array.from(document.querySelectorAll(preciseSelector));
            if (!nodes.length) {
                nodes = Array.from(document.querySelectorAll('[data-message-id], [data-testid*="message"]'))
                    .filter((node) => claudeRole(node));
            }

            for (const node of nodes) {
                const role = claudeRole(node);
                if (!role) continue;
                const text = readNodeText(node);
                const key = `${role}:${comparableText(text)}`;
                if (!text || seen.has(key)) continue;
                seen.add(key);
                const references = Array.from(node.querySelectorAll('a[href]'))
                    .map(sourceReferenceFromLink)
                    .filter(Boolean);
                messages.push({
                    role,
                    content: text,
                    ...(references.length ? { metadata: { content_references: references } } : {})
                });
            }

            return {
                name: document.title.replace(/\s*[|\-]\s*Claude.*$/i, ''),
                messages,
                _source: 'dom'
            };
        },

        chatgpt: () => {
            const messages = [];
            const seen = new Set();
            document.querySelectorAll('div[data-message-author-role]').forEach((node) => {
                const role = node.getAttribute('data-message-author-role');
                if (!/^(user|assistant)$/i.test(role || '')) return;
                const text = readNodeText(node);
                const key = comparableText(text);
                if (!text || seen.has(key)) return;
                seen.add(key);
                messages.push({ role: role.toLowerCase(), content: text });
            });
            return {
                title: document.title.replace(/ \| ChatGPT$/, ''),
                messages,
                _source: 'dom'
            };
        },

        openrouter: () => {
            const messages = [];
            const seen = new Set();
            document.querySelectorAll('[data-message-id]').forEach((wrapper) => {
                const roleNode = wrapper.querySelector(
                    '[data-testid="user-message"], [data-testid="assistant-message"], [data-testid="system-message"]'
                );
                if (!roleNode) return;
                const testId = roleNode.getAttribute('data-testid') || '';
                const role = testId.includes('user') ? 'user'
                    : testId.includes('system') ? 'system'
                    : 'assistant';
                const bubble = roleNode.querySelector('[data-message-bubble]') || roleNode;
                const text = readNodeText(bubble);
                const key = `${role}:${comparableText(text)}`;
                if (!text || seen.has(key)) return;
                seen.add(key);
                messages.push({
                    id: wrapper.getAttribute('data-message-id') || '',
                    role,
                    content: text
                });
            });
            return {
                id: new URL(location.href).searchParams.get('room') || '',
                title: document.title.replace(/\s*[|\-]\s*OpenRouter.*$/i, ''),
                messages,
                _source: 'dom',
                _reasoning_notice: 'Only reasoning currently rendered in the page is available in this fallback.'
            };
        },

        gemini: () => {
            const messages = [];
            const seen = new Set();
            const push = (role, node) => {
                const text = readNodeText(node);
                const key = comparableText(text);
                if (!text || text.length < 2 || seen.has(key)) return;
                seen.add(key);
                messages.push({ role, content: text });
            };

            // Gemini renders user turns as <user-query-content> and model turns
            // as <model-response>; walking both in document order preserves the
            // conversation sequence. For model turns we drill into the inner
            // <message-content> to skip the action bar / feedback chrome.
            const turns = document.querySelectorAll('user-query-content, model-response');
            turns.forEach((el) => {
                const isUser = el.tagName.toLowerCase().includes('user');
                if (isUser) push('user', el);
                else push('assistant', el.querySelector('message-content') || el);
            });
            if (messages.length) return { name: document.title, messages, _source: 'dom' };

            // Fallback for layouts without the custom elements: class heuristics.
            document.querySelectorAll('[class*="query-text"], [class*="user-query"], [class*="markdown"], [class*="model-response"]').forEach((el) => {
                if (readNodeText(el).length < 10) return;
                const cls = el.className || '';
                const isUser = /query|user/i.test(cls);
                push(isUser ? 'user' : 'assistant', el);
            });
            return { name: document.title, messages, _source: 'dom' };
        },

        aistudio: () => {
            const messages = [];
            const turns = document.querySelectorAll('ms-chat-turn, [class*="chat-turn"], .prompt-turn, .response-turn, mat-expansion-panel');
            for (const turn of turns) {
                const chunks = turn.querySelectorAll('ms-text-chunk, .text-chunk, .markdown-content, .response-text');
                let text = chunks.length ? Array.from(chunks).map((c) => readNodeText(c)).join('\n') : readNodeText(turn);
                text = text?.trim();
                if (text?.length > 5) {
                    const isUser = turn.classList.contains('prompt-turn') ||
                        turn.classList.contains('user-turn') ||
                        turn.querySelector('[class*="user"]') ||
                        turn.getAttribute('data-role') === 'user';
                    messages.push({ role: isUser ? 'user' : 'assistant', content: text });
                }
            }
            return { name: document.title.replace(/ - Google.*$/, ''), messages, _source: 'dom' };
        }
    };

    const captureDOMSnapshot = (platform) => {
        const probes = DOM_PROBES[platform] || { messages: [], code: [], attachments: [] };
        const collect = (kind, selectors) => dedupeByText(selectors.flatMap((selector) => {
            try {
                return Array.from(document.querySelectorAll(selector)).map((node) => ({
                    kind,
                    selector,
                    tag: node.tagName?.toLowerCase() || '',
                    text: cleanText(
                        node.innerText ||
                        node.textContent ||
                        node.getAttribute?.('alt') ||
                        node.getAttribute?.('aria-label') ||
                        node.getAttribute?.('href') ||
                        node.getAttribute?.('src') ||
                        ''
                    )
                }));
            } catch {
                return [];
            }
        }));

        const messages = collect('message', probes.messages);
        const codeBlocks = collect('code', probes.code);
        const attachments = collect('attachment', probes.attachments);

        return {
            title: document.title,
            url: location.href,
            generated_at: new Date().toISOString(),
            selector_counts: {
                messages: messages.length,
                code_blocks: codeBlocks.length,
                attachments: attachments.length
            },
            messages,
            code_blocks: codeBlocks,
            attachments
        };
    };

    CT.cleanText = cleanText;
    CT.comparableText = comparableText;
    CT.readNodeText = readNodeText;
    CT.DOM = DOM;
    CT.DOM_PROBES = DOM_PROBES;
    CT.captureDOMSnapshot = captureDOMSnapshot;
})();
