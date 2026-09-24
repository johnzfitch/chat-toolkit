import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dir, '../..');
const source = (name) => readFileSync(resolve(root, 'extension-src', name), 'utf8');
const page = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const sender = (id = 1, incognito = false) => ({ url: page, tab: { id, url: page, incognito } });
const probe = { app_uri: 'connectors://connector_openai_deep_research', tool_name: 'get_state',
    conversation_id: '11111111-1111-4111-8111-111111111111', message_id: 'message-one',
    tool_input: { session_id: 'research-one' } };
const response = JSON.stringify({ _meta: { deep_research_widget_messages: [] }, content: 'Synthetic report' });

function background() {
    const listeners = {};
    const filters = new Map();
    const storageCalls = [];
    const legacyKey = 'chatToolkitPassive:legacy';
    const storage = { [legacyKey]: '{"secret":"legacy private data"}' };
    Object.defineProperties(storage, {
        getItem: { value(key) { storageCalls.push(['get', key]); return storage[key]; } },
        setItem: { value(key, value) { storageCalls.push(['set', key]); storage[key] = value; } },
        removeItem: { value(key) { storageCalls.push(['remove', key]); delete storage[key]; } }
    });
    const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
    let opened = 0;
    const context = createContext({
        URL, URLSearchParams, Blob, TextDecoder, TextEncoder, ArrayBuffer, Uint8Array,
        console, localStorage: storage, setTimeout() {},
        browser: {
            tabs: { onRemoved: event('removed'), onUpdated: event('updated') },
            runtime: { onMessage: event('message'), async openOptionsPage() { opened++; } },
            downloads: { async download() { return 1; } },
            webRequest: {
                onBeforeRequest: event('before'), onCompleted: event('completed'), onErrorOccurred: event('error'),
                filterResponseData(id) {
                    const filter = { written: [], closed: false,
                        write(chunk) { this.written.push(new Uint8Array(chunk)); },
                        close() { this.closed = true; }, disconnect() {} };
                    filters.set(id, filter);
                    return filter;
                }
            }
        }
    });
    runInContext(source('lib/background.js'), context);
    const send = (message, from = sender()) => {
        let result;
        listeners.message(message, from, (value) => { result = value; });
        return result;
    };
    let sequence = 0;
    const request = (overrides = {}) => {
        const details = { requestId: `req-${++sequence}`, tabId: 1, frameId: 0, incognito: false,
            documentUrl: page, url: 'https://chatgpt.com/backend-api/ecosystem/call_mcp',
            method: 'POST', timeStamp: Date.now(), type: 'xmlhttprequest',
            requestBody: { raw: [{ bytes: new TextEncoder().encode(JSON.stringify(probe)).buffer }] }, ...overrides };
        listeners.before(details);
        return details;
    };
    const finish = (details) => {
        const filter = filters.get(details.requestId);
        if (filter) {
            const data = new TextEncoder().encode(response).buffer;
            filter.ondata({ data });
            filter.onstop();
        }
        listeners.completed({ ...details, statusCode: 200 });
        return filter;
    };
    return { send, request, finish, filters, listeners, storageCalls, storage, legacyKey,
        status: (from = sender()) => send({ action: 'passive-store-status', full: true, create: true }, from),
        opened: () => opened };
}

describe('Public release diagnostic behavior', () => {
    test('loading the extension does not record requests, restore old caches, or write chat data to disk', () => {
        const app = background();
        app.finish(app.request());
        const status = app.status();
        expect(status.enabled).toBe(false);
        expect(status.summary.capture_count).toBe(0);
        expect(status.summary.request_count).toBe(0);
        expect(app.filters.size).toBe(0);
        expect(app.storageCalls).toEqual([]);
        expect(app.storage[app.legacyKey]).toContain('legacy private data');
    });

    test('Record captures only the opted-in tab and forwards response bytes unchanged', () => {
        const app = background();
        expect(app.send({ action: 'diagnostics-start' }).enabled).toBe(true);
        app.finish(app.request({ tabId: 2 }));
        app.finish(app.request({ tabId: -1 }));
        const filter = app.finish(app.request());
        expect(app.filters.size).toBe(1);
        expect(new TextDecoder().decode(filter.written[0])).toBe(response);
        expect(filter.closed).toBe(true);
        expect(app.status().summary.capture_count).toBe(1);
        expect(app.status(sender(2)).summary.capture_count).toBe(0);
        app.send({ action: 'diagnostics-start' }, sender(2));
        expect(app.status(sender(2)).summary.capture_count).toBe(0);
        expect(app.storageCalls).toEqual([]);
    });

    test('Stop retains earlier research data but ignores later responses and new requests', () => {
        const app = background();
        app.send({ action: 'diagnostics-start' });
        app.finish(app.request());
        const inFlight = app.request();
        app.send({ action: 'diagnostics-stop' });
        app.finish(inFlight);
        app.finish(app.request());
        expect(app.status().enabled).toBe(false);
        expect(app.status().summary.capture_count).toBe(1);
        expect(app.filters.size).toBe(2);
    });

    test('research event markers are retained only after Record and can identify missing research state', () => {
        const app = background();
        const eventRequest = { url: 'https://chatgpt.com/ces/v1/t', requestBody: { raw: [{
            bytes: new TextEncoder().encode(JSON.stringify({ type: 'track', event: 'research-opened',
                properties: { conversation_id: probe.conversation_id, message_id: probe.message_id,
                    session_id: probe.tool_input.session_id } })).buffer
        }] } };
        app.finish(app.request(eventRequest));
        expect(app.status().summary.marker_count).toBe(0);
        app.send({ action: 'diagnostics-start' });
        app.finish(app.request(eventRequest));
        expect(app.status().summary.marker_count).toBe(1);
        expect(app.status().missing_probes[0].session_id).toBe('research-one');
        expect(app.filters.size).toBe(0);
    });

    test('Clear removes current and legacy caches and a late response cannot restore them', () => {
        const app = background();
        app.send({ action: 'diagnostics-start' });
        const inFlight = app.request();
        app.send({ action: 'diagnostics-clear' });
        app.finish(inFlight);
        expect(app.status().summary.capture_count).toBe(0);
        expect(app.status().summary.request_count).toBe(0);
        expect(app.status().enabled).toBe(false);
        expect(app.storage[app.legacyKey]).toBeUndefined();
        expect(app.storageCalls).toEqual([['remove', app.legacyKey]]);
    });

    test.each(['navigation', 'reload', 'close'])('%s clears recording in that tab without erasing another tab', (action) => {
        const app = background();
        for (const id of [1, 2]) {
            app.send({ action: 'diagnostics-start' }, sender(id));
            app.finish(app.request({ tabId: id }));
        }
        if (action === 'close') app.listeners.removed(1);
        else app.listeners.updated(1, action === 'reload' ? { status: 'loading' } : { url: `${page}?changed=1` });
        expect(app.status().summary.capture_count).toBe(0);
        expect(app.status().enabled).toBe(false);
        expect(app.status(sender(2)).summary.capture_count).toBe(1);
        expect(app.status(sender(2)).enabled).toBe(true);
    });

    test('private windows cannot record, retrieve, or inject diagnostic data', () => {
        const app = background();
        for (const action of ['diagnostics-start', 'network-capture-start', 'network-capture-get',
            'network-capture-stop', 'passive-store-ingest-mcp']) {
            expect(app.send({ action, request: probe, response }, sender(1, true)).success).toBe(false);
        }
        app.finish(app.request({ incognito: true }));
        expect(app.filters.size).toBe(0);
        expect(app.status(sender(1, true)).enabled).toBe(false);
        expect(app.storageCalls).toEqual([]);
    });

    test('an explicit capture works without continuous recording and excludes the login-token response', () => {
        const app = background();
        app.send({ action: 'network-capture-start', platform: 'chatgpt', url: page, reason: 'capture-export' });
        app.finish(app.request({ url: 'https://chatgpt.com/api/auth/session' }));
        app.finish(app.request({ tabId: -1 }));
        app.finish(app.request());
        const result = app.send({ action: 'network-capture-stop' });
        expect(app.filters.size).toBe(1);
        expect(result.captures._entries).toHaveLength(1);
        expect(result.network.requests).toHaveLength(2);
        expect(result.network.requests[0].request_body).toBe('');
        expect(result.capture.active).toBe(false);
        expect(app.status().enabled).toBe(false);
    });

    test('the Network tool records metadata without filtering response bodies', () => {
        const app = background();
        app.send({ action: 'network-capture-start', platform: 'chatgpt', url: page, reason: 'network-inspector' });
        app.finish(app.request());
        const result = app.send({ action: 'network-capture-stop' });
        expect(result.network.requests).toHaveLength(1);
        expect(result.captures._entries).toHaveLength(0);
        expect(app.filters.size).toBe(0);
    });

    test.each([false, true])('authentication endpoints cannot evade exclusion through query strings or encoded paths (Record=%s)', (record) => {
        const app = background();
        if (record) app.send({ action: 'diagnostics-start' });
        app.send({ action: 'network-capture-start', platform: 'chatgpt', url: page, reason: 'capture-export' });
        for (const path of ['/api/auth/session?next=/conversation', '/api/%61uth/session?next=/backend-api/', '/api/auth/session?next=/backend-api/ecosystem/call_mcp']) {
            app.finish(app.request({ url: `https://chatgpt.com${path}` }));
        }
        expect(app.filters.size).toBe(0);
        expect(app.status().summary.capture_count).toBe(0);
        expect(app.send({ action: 'network-capture-get' }).network.requests.every((request) => !request.request_body)).toBe(true);
    });

    test('network capture cannot claim a provider other than the sender tab', () => {
        const app = background();
        expect(app.send({ action: 'network-capture-start', platform: 'claude', url: 'https://claude.ai/chat/example' }).success).toBe(false);
        expect(app.send({ action: 'network-capture-get' }).success).toBe(false);
    });

    test('the download bridge refuses remote URLs instead of fetching them with extension permissions', () => {
        const app = background();
        expect(app.send({ action: 'download', url: 'https://example.invalid/private', filename: 'leak.json' }).success).toBe(false);
    });

    test('the Help action opens the packaged options page', async () => {
        const app = background();
        const result = await new Promise((resolveMessage) => app.listeners.message({ action: 'open-help' }, sender(), resolveMessage));
        expect(result.success).toBe(true);
        expect(app.opened()).toBe(1);
    });
});

describe('Public release page surfaces', () => {
    test('Capture and API inspection do not request account data; the separate account action does', async () => {
        let listener;
        let finish;
        let accountRequests = 0;
        const downloads = [];
        const raw = { uuid: 'synthetic-chat', name: 'Synthetic conversation', chat_messages: [{ text: 'Hello' }] };
        const clean = { title: raw.name, messages: [{ role: 'user', content: 'Hello' }] };
        const toolkit = {
            PLATFORM: 'claude', getCurrentId: () => raw.uuid, getClaudeOrgId: () => 'synthetic-org',
            safeStringify: JSON.stringify, fetchClaude: async () => raw,
            fetchClaudeRawAndMessages: async () => ({ raw, messages: raw }),
            fetchClaudeSessionBundle: async () => { accountRequests++; return { explicitAccountData: true }; },
            parserCall: async (cmd) => cmd === 'discoverClaude' ? { org_id: 'synthetic-org' } : clean,
            withPageCapture: async (fn) => fn(), getPageState: () => ({}),
            captureDOMSnapshot: () => ({ messages: [], code_blocks: [], attachments: [], selector_counts: {} }),
            notify: (title) => finish?.(title), showReport: () => finish?.('Report opened')
        };
        const context = createContext({
            window: { __chatToolkit: toolkit }, location: new URL('https://claude.ai/chat/synthetic-chat'),
            document: { title: raw.name, readyState: 'loading', addEventListener() {} }, console,
            browser: { runtime: {
                onMessage: { addListener(fn) { listener = fn; } },
                async sendMessage(message) {
                    if (message.action === 'download') downloads.push(JSON.parse(message.content));
                    return { success: true };
                }
            } }
        });
        runInContext(source('lib/content.js'), context);
        const act = async (action) => {
            const title = await new Promise((resolveAction) => { finish = resolveAction; listener({ action }); });
            expect(title).not.toMatch(/failed|busy/i);
            await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        };
        await act('export-capture');
        await act('run-explorer');
        expect(accountRequests).toBe(0);
        expect(downloads[0].session_bundle).toBeNull();
        await act('export-account-capture');
        expect(accountRequests).toBe(1);
        expect(downloads[1].session_bundle.explicitAccountData).toBe(true);
    });

    test('opening ChatGPT does not fetch research state even when the page sets legacy opt-in flags', () => {
        const timers = [];
        const messages = [];
        const toolkit = { PLATFORM: 'chatgpt', createPanel: () => ({}), getCurrentId: () => 'synthetic-chat',
            chatGPTFetch: () => { throw new Error('Page load must not make authenticated requests'); } };
        const context = createContext({
            window: { __chatToolkit: toolkit }, location: new URL(page),
            document: { readyState: 'complete', body: { appendChild() {} }, getElementById() {} },
            sessionStorage: { getItem: () => '1' }, localStorage: { getItem: () => '1' },
            setTimeout(fn) { timers.push(fn); }, setInterval() {}, console,
            browser: { runtime: { onMessage: { addListener() {} },
                async sendMessage(message) { messages.push(message); return { success: false, enabled: false }; } } }
        });
        runInContext(source('lib/content.js'), context);
        timers[0]();
        expect(messages.map((message) => message.action)).toEqual(['passive-store-status']);
        expect(messages[0].create).toBe(false);
    });

    test.each([false, true])('page-owned storage cannot enable request hooks (private=%s)', async (privateWindow) => {
        const nativeFetch = async () => new Response('{"result":"synthetic"}');
        const pageWindow = { fetch: nativeFetch };
        const toolkit = { PLATFORM: 'chatgpt', safeStringify: JSON.stringify };
        const context = createContext({
            window: { __chatToolkit: toolkit, wrappedJSObject: pageWindow, addEventListener() {} },
            browser: { extension: { inIncognitoContext: privateWindow } },
            localStorage: { getItem: () => '1' }, sessionStorage: { getItem: () => '1' },
            exportFunction: (fn) => fn, console, Blob, Response, ArrayBuffer, FormData
        });
        runInContext(source('lib/page-bridge.js'), context);
        await toolkit.setPageCapture('start');
        expect(pageWindow.fetch).toBe(nativeFetch);
        expect(toolkit.__hookState().page_hooks_enabled).toBe(false);
        toolkit.enablePageHooks();
        await toolkit.setPageCapture('start');
        expect(toolkit.__hookState().fetch).toBe(!privateWindow);
        if (privateWindow) expect(pageWindow.fetch).toBe(nativeFetch);
        else expect(pageWindow.fetch).not.toBe(nativeFetch);
        await toolkit.setPageCapture('clear');
        expect(toolkit.getPageState().capture.active).toBe(false);
        expect(toolkit.getPageState().network.requests).toHaveLength(0);
    });

    test('notification titles and errors stay literal text even when they contain HTML', () => {
        const window = new Window();
        const roots = [];
        const attach = window.HTMLElement.prototype.attachShadow;
        window.HTMLElement.prototype.attachShadow = function (options) {
            const root = attach.call(this, options); roots.push(root); return root;
        };
        const toolkit = { PLATFORM: 'grok', COLORS: { grok: '#888' } };
        const context = createContext({ window: { __chatToolkit: toolkit }, setTimeout() {},
            document: window.document });
        runInContext(source('lib/ui-panel.js'), context);
        const attack = '<img src=x onerror=alert(1)>';
        toolkit.notify(attack, attack);
        expect(roots[0].querySelector('strong').textContent).toBe(attack);
        expect(roots[0].querySelector('small').textContent).toBe(attack);
        expect(roots[0].querySelector('img')).toBeNull();
        expect(window.document.body.textContent).toBe('');
        expect(window.document.body.firstElementChild.shadowRoot).toBeNull();
    });

    test('the manifest declares built-in consent and points to a real local help page', () => {
        const manifest = JSON.parse(source('manifest.json'));
        expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('140.0');
        expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required)
            .toEqual(['authenticationInfo', 'websiteContent']);
        expect(existsSync(resolve(root, 'extension-src', manifest.options_ui.page))).toBe(true);
        expect(manifest.permissions).toContain('clipboardWrite');
        expect(manifest.permissions).not.toContain('https://x.com/*');
    });
});
