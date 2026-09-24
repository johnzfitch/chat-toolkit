import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Window } from 'happy-dom';
import { loadGrokToolkit } from '../helpers/toolkit.js';

const root = resolve(import.meta.dir, '../..');
const source = (name) => readFileSync(resolve(root, 'extension-src/lib', name), 'utf8');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

function fetchers(platform = 'chatgpt', url = 'https://chatgpt.com/c/synthetic') {
    const calls = [];
    let response = () => json({ result: 'synthetic conversation' });
    const toolkit = { PLATFORM: platform, safeStringify: JSON.stringify };
    const context = createContext({ window: { __chatToolkit: toolkit },
        location: new URL(url), document: { cookie: '', title: 'Synthetic fixture' },
        navigator: { language: 'en-US' }, URL, URLSearchParams, Headers, crypto, console,
        fetch: async (url, options) => {
            calls.push({ url, options });
            return new URL(url).pathname === '/api/auth/session'
                ? json({ accessToken: 'synthetic-token-for-test' }) : response(url, options);
        } });
    runInContext(source('api-fetchers.js'), context);
    return { toolkit, calls, respond: (fn) => { response = fn; } };
}

describe('Authenticated provider requests', () => {
    test.each(['https://example.invalid/leak', '//example.invalid/leak',
        'http://chatgpt.com/backend-api/conversation', 'https://user:password@chatgpt.com/backend-api/conversation'])
    ('rejects %s before requesting an access token', async (url) => {
        const app = fetchers();
        await expect(app.toolkit.chatGPTFetch(url)).rejects.toThrow('current chat provider');
        expect(app.calls).toHaveLength(0);
    });

    test('a same-origin conversation request uses the session token and forbids redirects on both requests', async () => {
        const app = fetchers();
        const response = await app.toolkit.chatGPTFetch('/backend-api/conversation/synthetic');
        expect(await response.json()).toEqual({ result: 'synthetic conversation' });
        expect(app.calls).toHaveLength(2);
        expect(app.calls.every(({ options }) => options.redirect === 'error')).toBe(true);
        expect(app.calls[1].options.headers.get('authorization')).toBe('Bearer synthetic-token-for-test');
        expect(app.calls[1].options.credentials).toBe('include');
    });

    test('a 401 refreshes the token once and returns the retry response', async () => {
        const app = fetchers();
        let attempts = 0;
        app.respond(() => ++attempts === 1 ? json({ error: 'expired' }, 401) : json({ result: 'retry' }));
        expect(await (await app.toolkit.chatGPTFetch('/backend-api/conversation/synthetic')).json()).toEqual({ result: 'retry' });
        expect(app.calls).toHaveLength(4);
    });

    test('the ChatGPT fetcher cannot acquire credentials while running on Grok', async () => {
        const app = fetchers('grok', 'https://grok.com/c/synthetic');
        await expect(app.toolkit.chatGPTFetch('/backend-api/conversation/synthetic')).rejects.toThrow();
        expect(app.calls).toHaveLength(0);
    });
});

function ui() {
    const window = new Window();
    const roots = [];
    // Test-only access to closed roots; the runtime never exports these refs.
    const attach = window.HTMLElement.prototype.attachShadow;
    window.HTMLElement.prototype.attachShadow = function (options) {
        const root = attach.call(this, options); roots.push(root); return root;
    };
    const toolkit = { PLATFORM: 'grok', COLORS: { grok: '#888' }, safeStringify: JSON.stringify };
    window.__chatToolkit = toolkit;
    const context = createContext({ window, document: window.document, navigator: {}, Blob, setTimeout() {} });
    runInContext(source('ui-model.js'), context);
    runInContext(source('ui-panel.js'), context);
    return { window, toolkit, roots };
}

describe('Private extension UI and literal exports', () => {
    test('reports stay outside ordinary page DOM queries and synthetic clicks cannot copy or save them', () => {
        const { window, toolkit, roots } = ui();
        const actions = [];
        toolkit.showReport({ report: { title: 'Synthetic secret title', data: { secret: 'Synthetic private report' } },
            onCopy: () => actions.push('copy'), onDownload: () => actions.push('save') });
        const host = window.document.getElementById('chat-toolkit-report');
        expect(host.shadowRoot).toBeNull();
        expect(window.document.body.innerHTML).not.toContain('Synthetic private report');
        expect(window.document.querySelector('pre')).toBeNull();
        expect(roots[0].querySelector('pre').textContent).toContain('Synthetic private report');
        roots[0].querySelector('[data-report="copy"]').click();
        roots[0].querySelector('[data-report="download"]').click();
        expect(actions).toHaveLength(0);
    });

    test('the legacy clipboard fallback keeps its textarea outside page queries and removes the host', async () => {
        const { window, toolkit, roots } = ui();
        window.document.execCommand = (command) => {
            expect(command).toBe('copy');
            expect(window.document.querySelector('textarea')).toBeNull();
            expect(roots[0].querySelector('textarea').value).toBe('Synthetic clipboard secret');
            return true;
        };
        expect(await toolkit.copyToClipboard('<p>text</p>', 'Synthetic clipboard secret')).toBe(true);
        expect(window.document.body.childElementCount).toBe(0);
    });

    test('controls reject synthetic clicks and retain their assigned action if an attribute changes', () => {
        const { window, toolkit, roots } = ui();
        const actions = [];
        const host = toolkit.createPanel((action) => actions.push(action));
        window.document.body.appendChild(host);
        const button = roots[0].querySelector('[data-a="copy"]');
        button.dataset.a = 'export-account-capture';
        button.click();
        expect(actions).toHaveLength(0);
        // Direct unit invocation tests the closure, not browser user activation.
        button.onclick({ isTrusted: true });
        expect(actions).toEqual(['copy']);
        expect(host.shadowRoot).toBeNull();
        expect(window.document.querySelector('[data-a]')).toBeNull();
    });

    test('HTML exports render malicious message markup as text and exclude executable source links', () => {
        const { toolkit } = loadGrokToolkit({ url: 'https://grok.com/c/synthetic' });
        const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>';
        const raw = { id: 'synthetic', title: attack, messages: [{ role: 'assistant', content: attack,
            sources: [{ url: 'javascript:alert(3)', title: attack }, { url: 'https://example.com/', title: attack }] }] };
        const html = toolkit.runParserCommand('html', { platform: 'grok', raw });
        const window = new Window();
        window.document.write(html);
        expect(window.document.querySelectorAll('script,img,[onerror],[onclick]')).toHaveLength(0);
        expect([...window.document.querySelectorAll('a')].every((a) => /^https?:/.test(a.href))).toBe(true);
        expect(window.document.body.textContent).toContain(attack);
    });

    test.each(['constructor', 'toString', '__proto__'])('the parser rejects inherited command %s', (cmd) => {
        const { toolkit } = loadGrokToolkit({ url: 'https://grok.com/c/synthetic' });
        expect(() => toolkit.runParserCommand(cmd, {})).toThrow(`unknown command: ${cmd}`);
    });
});

function hooks() {
    class Socket extends EventTarget {
        constructor(url) { super(); this.url = url; }
        send() {}
    }
    class Events extends EventTarget {
        constructor(url) { super(); this.url = url; }
    }
    class XHR extends EventTarget {
        open() {}
        send() { this.status = 200; this.responseType = ''; this.responseText = '{"value":"synthetic xhr"}'; this.dispatchEvent(new Event('loadend')); }
    }
    let body = 'Synthetic response';
    let nextResponse;
    const page = { fetch: async () => nextResponse || new Response(body), XMLHttpRequest: XHR, WebSocket: Socket, EventSource: Events };
    const toolkit = { PLATFORM: 'chatgpt', safeStringify: JSON.stringify, decodeBatchExecute: () => [] };
    const context = createContext({ window: { __chatToolkit: toolkit, wrappedJSObject: page, addEventListener() {} },
        browser: { extension: { inIncognitoContext: false } }, exportFunction: (fn) => fn,
        location: new URL('https://chatgpt.com/c/synthetic'), URL, Response, TextDecoder,
        Date: class extends Date { static now() { return 1000; } },
        ArrayBuffer, Blob, FormData, console });
    runInContext(source('page-bridge.js'), context);
    toolkit.enablePageHooks();
    return { toolkit, page, setBody: (value) => { body = value; }, defer: (value) => { nextResponse = value; } };
}
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 10));

describe('Opt-in page diagnostics', () => {
    test('a request started before Clear cannot populate the next capture even within the same clock tick', async () => {
        const app = hooks();
        let finish;
        app.defer(new Promise((resolveResponse) => { finish = resolveResponse; }));
        await app.toolkit.setPageCapture('start');
        const pending = app.page.fetch('/backend-api/conversation/old');
        await app.toolkit.setPageCapture('clear');
        await app.toolkit.setPageCapture('start');
        finish(new Response('Old capture secret'));
        expect(await (await pending).text()).toBe('Old capture secret');
        await tick();
        expect(app.toolkit.getPageState().network.requests).toHaveLength(0);
        expect(app.toolkit.getPageState().captures._entries).toBeUndefined();
    });

    test('fetch hooks leave authentication and foreign responses uncaptured and deliver their original bytes', async () => {
        const app = hooks();
        await app.toolkit.setPageCapture('start');
        for (const url of ['https://example.invalid/data', '/api/auth/session?next=/conversation', '/api/%61uth/session']) {
            expect(await (await app.page.fetch(url)).text()).toBe('Synthetic response');
        }
        await tick();
        expect(app.toolkit.getPageState().network.requests).toHaveLength(0);
        expect(app.toolkit.getPageState().captures._entries).toBeUndefined();
    });

    test('diagnostic bodies are bounded while the page still receives the entire response', async () => {
        const app = hooks();
        const full = 'x'.repeat(300000);
        app.setBody(full);
        await app.toolkit.setPageCapture('start');
        expect(await (await app.page.fetch('/backend-api/conversation/synthetic', { body: full })).text()).toBe(full);
        await tick();
        const state = app.toolkit.getPageState();
        expect(state.captures._entries[0].text).toHaveLength(256000);
        expect(state.network.requests[0].body).toHaveLength(256000);
    });

    test('XHR request bodies stay off page objects and authentication XHRs are excluded', async () => {
        const app = hooks();
        await app.toolkit.setPageCapture('start');
        const xhr = new app.page.XMLHttpRequest();
        xhr.open('POST', '/backend-api/conversation/synthetic');
        xhr.send('Synthetic private request');
        expect(JSON.stringify(xhr)).not.toContain('Synthetic private request');
        expect(Object.keys(xhr).some((key) => key.startsWith('__ct'))).toBe(false);
        expect(app.toolkit.getPageState().network.requests[0].body).toBe('Synthetic private request');
        const auth = new app.page.XMLHttpRequest();
        auth.open('POST', '/api/auth/session'); auth.send('Synthetic token');
        expect(app.toolkit.getPageState().network.requests).toHaveLength(1);
    });

    test.each(['WebSocket', 'EventSource'])('%s retains listener removal and bounded private state across Clear', async (kind) => {
        const app = hooks();
        const streamType = kind === 'WebSocket' ? 'websocket' : 'eventsource';
        const url = kind === 'WebSocket' ? 'wss://chatgpt.com/stream' : 'https://chatgpt.com/stream';
        await app.toolkit.setPageCapture('start');
        const socket = new app.page[kind](url);
        let received = 0;
        const listener = () => received++;
        socket.addEventListener('message', listener);
        socket.addEventListener('message', () => {});
        socket.removeEventListener('message', listener);
        for (let i = 0; i < 30; i++) socket.dispatchEvent(new MessageEvent('message', { data: `Synthetic secret ${i}` }));
        expect(received).toBe(0);
        expect(Object.keys(socket).some((key) => key.startsWith('__ct'))).toBe(false);
        expect(JSON.stringify(socket)).not.toContain('Synthetic secret');
        const before = app.toolkit.getPageState().streams[streamType][0].messages;
        expect(before).toHaveLength(24);
        expect(before[0].payload).toBe('Synthetic secret 6');
        await app.toolkit.setPageCapture('clear');
        await app.toolkit.setPageCapture('start');
        socket.dispatchEvent(new MessageEvent('message', { data: 'New session' }));
        expect(app.toolkit.getPageState().streams[streamType][0].messages.map((m) => m.payload)).toEqual(['New session']);
    });
});
