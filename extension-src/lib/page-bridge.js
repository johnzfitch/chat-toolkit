// Bridge between the content-script world and the parser worker.
//
// Page-world fetch/XHR/WebSocket/EventSource hooks used to be installed at
// document_start. Modern Claude/ChatGPT/Gemini bootstrap code now wraps and
// brand-checks fetch aggressively enough that replacing page globals can make
// the host app fail before React hydrates. Keep the hook implementation for
// opt-in debugging, but do not install it during normal page load.
//
// The hook implementation installs directly from the content script via
// `exportFunction` + `wrappedJSObject`. We never append a <script> element to
// the page, which:
//   1. Sidesteps strict-CSP sites — Gemini sends
//      `require-trusted-types-for 'script'` plus a `script-src` allowlist that
//      excludes `moz-extension://`, so the old `<script src=...>` approach was
//      blocked or silently ignored.
//   2. Lets a user opt into hooks from the extension's Diagnostics controls.
//
// All capture state lives in content-script world. `setPageCapture` just
// flips a flag unless hooks were explicitly enabled.

(function () {
    'use strict';

    const CT = window.__chatToolkit;
    if (!CT) return;

    const { PLATFORM, pageColor, safeStringify, decodeBatchExecute, sleep } = CT;
    let pageHooksEnabled = false;
    const MAX_CAPTURE_TEXT = 256000;
    const MAX_CAPTURE_ENTRIES = 24;
    const MAX_REQUESTS = 120;
    let captureGeneration = 0;

    const canCaptureURL = (input) => {
        try {
            const url = new URL(input, location.origin);
            if (url.protocol === 'wss:') url.protocol = 'https:';
            const path = decodeURIComponent(url.pathname);
            return url.protocol === 'https:' && url.origin === location.origin &&
                !/\/(?:auth|oauth|login|signin|token)(?:\/|$)/i.test(path);
        } catch { return false; }
    };

    const readCaptureText = async (response) => {
        const reader = response.body?.getReader?.();
        if (!reader) return (await response.text()).slice(0, MAX_CAPTURE_TEXT);
        const decoder = new TextDecoder();
        let text = '';
        while (text.length < MAX_CAPTURE_TEXT) {
            const { done, value } = await reader.read();
            if (done) return (text + decoder.decode()).slice(0, MAX_CAPTURE_TEXT);
            text += decoder.decode(value, { stream: true }).slice(0, MAX_CAPTURE_TEXT - text.length);
        }
        // Do not await cancellation of a tee: the page may still be reading
        // its original stream. Its response must continue untouched.
        void reader.cancel().catch(() => {});
        return text;
    };

    // ---- capture state ---------------------------------------------------

    const STATE = {
        platform: PLATFORM,
        network: { requests: [], started: 0 },
        captures: {},
        streams: { websocket: [], eventsource: [] },
        capture: { active: false, started_at: null, stopped_at: null },
        hooks: { installed: false, fetch: false, xhr: false, websocket: false, eventsource: false }
    };

    const pageHooksAllowed = () => pageHooksEnabled && !browser.extension?.inIncognitoContext;

    const hookState = () => ({
        ...STATE.hooks,
        page_hooks_enabled: pageHooksAllowed(),
        page_hooks_control: 'Diagnostics > Enable page hooks'
    });

    const clearState = () => {
        captureGeneration++;
        STATE.network = { requests: [], started: Date.now() };
        STATE.captures = {};
        STATE.streams = { websocket: [], eventsource: [] };
        registeredStreams = new WeakSet();
        streamStates = new WeakMap();
    };

    const shouldRemember = (startedAt, generation = captureGeneration) =>
        generation === captureGeneration && STATE.capture.active &&
        (!STATE.capture.started_at || !startedAt || startedAt >= STATE.capture.started_at);

    const rememberRequest = (entry, generation = captureGeneration) => {
        if (!shouldRemember(entry.started_at, generation) || !canCaptureURL(entry.url)) return null;
        STATE.network.requests.push(entry);
        if (STATE.network.requests.length > MAX_REQUESTS) STATE.network.requests.shift();
        return entry;
    };

    let registeredStreams = new WeakSet();
    let streamStates = new WeakMap();
    const xhrRequests = new WeakMap();
    const rememberStream = (type, stream) => {
        if (!STATE.capture.active || !canCaptureURL(stream.url)) return null;
        if (!registeredStreams.has(stream)) {
            registeredStreams.add(stream);
            STATE.streams[type].push(stream);
            if (STATE.streams[type].length > MAX_CAPTURE_ENTRIES) STATE.streams[type].shift();
        }
        return stream;
    };

    const rememberStreamEvent = (type, stream, event) => {
        if (!shouldRemember(event.at)) return null;
        if (!rememberStream(type, stream)) return null;
        stream.messages.push(event);
        if (stream.messages.length > MAX_CAPTURE_ENTRIES) stream.messages.shift();
        return event;
    };

    const captureValue = (value) => {
        if (value == null) return '';
        if (typeof value === 'string') return value.slice(0, MAX_CAPTURE_TEXT);
        try {
            if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
            if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
            if (typeof Blob !== 'undefined' && value instanceof Blob) return `[Blob ${value.type} ${value.size} bytes]`;
            if (typeof FormData !== 'undefined' && value instanceof FormData) {
                const pairs = [];
                value.forEach((entry, key) => pairs.push([key, typeof Blob !== 'undefined' && entry instanceof Blob ? '[Blob]' : String(entry)]));
                return JSON.stringify(pairs).slice(0, MAX_CAPTURE_TEXT);
            }
            return JSON.stringify(value)?.slice(0, MAX_CAPTURE_TEXT) || '';
        } catch {
            return String(value).slice(0, MAX_CAPTURE_TEXT);
        }
    };

    const processCapture = (url, status, text, startedAt, generation = captureGeneration) => {
        if (!shouldRemember(startedAt, generation) || !canCaptureURL(url) || text == null) return;
        text = text.slice(0, MAX_CAPTURE_TEXT);
        const capture = { url, status, timestamp: Date.now() };
        const isBatch = /\/batchexecute/.test(url) || /^\)\]\}'/.test(text);
        if (isBatch) {
            // Gemini's chunked, length-prefixed RPC envelope. Keep the decoded
            // wrb.fr payloads; only fall back to raw text if nothing decoded.
            const batch = decodeBatchExecute(text);
            if (batch.length) capture.batch = batch;
            else capture.text = text.slice(0, 20000);
        } else {
            try {
                const clean = text.replace(/^\)\]\}'?\n?/, '');
                capture.json = JSON.parse(clean.split('\n')[0] || clean);
            } catch {
                capture.text = text;
            }
        }
        if (!Array.isArray(STATE.captures._entries)) STATE.captures._entries = [];
        STATE.captures._entries.push(capture);
        const entries = STATE.captures._entries.slice(-MAX_CAPTURE_ENTRIES);
        STATE.captures = { _entries: entries, _latest: capture,
            ...Object.fromEntries(entries.map((item) => [String(item.url).split('?')[0], item])) };
    };

    // ---- direct hook install (Firefox: wrappedJSObject + exportFunction) -

    // Returns the page's window object, or null if we can't reach it (Chrome,
    // sandboxed iframe, etc).
    const getPageWindow = () => {
        try { return window.wrappedJSObject || null; }
        catch { return null; }
    };

    // Best-effort safe call into page-world. Page-world functions like fetch
    // are reachable from content-script through Xray vision; `.apply` with
    // the page window as `this` Just Works.
    const callPageFn = (fn, thisArg, args) => {
        try { return fn.apply(thisArg, args); }
        catch (e) { throw e; }
    };

    const installHooks = () => {
        if (STATE.hooks.installed) return true;
        if (!pageHooksAllowed()) return false;
        const win = getPageWindow();
        if (!win || typeof exportFunction !== 'function') return false;
        STATE.hooks.installed = true;

        // ---- fetch -------------------------------------------------------
        try {
            const nativeFetch = win.fetch;
            const hookedFetch = exportFunction(function (input, init) {
                const started = Date.now();
                const generation = captureGeneration;
                let url = '';
                let method = 'GET';
                try {
                    url = typeof input === 'string' ? input : (input && input.url) || '';
                    method = (init && init.method) || (input && input.method) || 'GET';
                } catch {}
                if (!canCaptureURL(url)) return nativeFetch.apply(this, arguments);
                const bodyText = captureValue(init && init.body);

                // Even when capture is inactive, sniff Gemini batchexecute
                // tokens so the API fetcher always has fresh signing data.
                try { CT.noteGeminiTokens?.(url, bodyText); } catch {}

                let promise;
                try {
                    promise = nativeFetch.apply(this, arguments);
                } catch (e) {
                    rememberRequest({
                        method, url, started_at: started, status: 0, size: 0,
                        duration_ms: Date.now() - started, source: 'fetch',
                        body: bodyText, error: String(e && e.message || e)
                    }, generation);
                    throw e;
                }

                // Chain on the page's Promise so cloning runs before its
                // consumer can drain the body, and the result is a page-world
                // Promise rather than an inaccessible content-world object.
                const onResponse = exportFunction(function (response) {
                    if (!response || !shouldRemember(started, generation)) return response;
                    let clone;
                    try { clone = response.clone(); } catch { clone = null; }
                    const finish = (text) => {
                        rememberRequest({
                            method, url, started_at: started, status: response.status,
                            size: (text && text.length) || 0,
                            duration_ms: Date.now() - started, source: 'fetch', body: bodyText
                        }, generation);
                        if (text != null) processCapture(url, response.status, text, started, generation);
                    };
                    if (!clone) { finish(null); return response; }
                    readCaptureText(clone).then(finish, () => finish(null));
                    return response;
                }, win);
                return promise.then(onResponse);
            }, win);
            win.fetch = hookedFetch;
            STATE.hooks.fetch = true;
        } catch (e) {
            console.warn('[Chat Toolkit] fetch hook install failed', e);
        }

        // ---- XHR ---------------------------------------------------------
        // Hook prototype methods so every XHR created by the page (even ones
        // constructed before our hooks ran — those instances share the same
        // prototype) is intercepted. Per-instance state stays in a content-
        // script WeakMap; no request bodies are written into the page object.
        try {
            const XHR = win.XMLHttpRequest;
            if (XHR && XHR.prototype) {
                const proto = XHR.prototype;
                const nativeOpen = proto.open;
                const nativeSend = proto.send;

                proto.open = exportFunction(function (method, url) {
                    try {
                        xhrRequests.set(this, { method: String(method || ''), url: String(url || ''),
                            started: Date.now(), generation: captureGeneration, body: '' });
                    } catch {}
                    return nativeOpen.apply(this, arguments);
                }, win);

                proto.send = exportFunction(function (body) {
                    const request = xhrRequests.get(this) || {};
                    try {
                        request.body = canCaptureURL(request.url) ? captureValue(body) : '';
                        CT.noteGeminiTokens?.(request.url, request.body);
                    } catch {}
                    const xhr = this;
                    // addEventListener on the page-world XHR — Firefox routes
                    // the listener to our CT-world function.
                    try {
                        xhr.addEventListener('loadend', function () {
                            try {
                                const method = request.method || '';
                                const url = request.url || '';
                                const started = request.started || 0;
                                const bodyText = request.body || '';
                                let respText = '';
                                try {
                                    if (xhr.responseType === '' || xhr.responseType === 'text') {
                                        respText = (xhr.responseText || '').slice(0, MAX_CAPTURE_TEXT);
                                    }
                                } catch {}
                                rememberRequest({
                                    method, url, started_at: started,
                                    status: xhr.status,
                                    size: respText.length,
                                    duration_ms: Date.now() - (started || Date.now()),
                                    source: 'xhr', body: bodyText
                                }, request.generation);
                                if (respText) processCapture(url, xhr.status, respText, started, request.generation);
                            } catch {}
                        }, { once: true });
                    } catch {}
                    return nativeSend.apply(this, arguments);
                }, win);
                STATE.hooks.xhr = true;
            }
        } catch (e) {
            console.warn('[Chat Toolkit] XHR hook install failed', e);
        }

        // ---- WebSocket ---------------------------------------------------
        // Add one observer when the page subscribes to messages. Preserve its
        // own listener identity so removeEventListener still works normally.
        try {
            const WS = win.WebSocket;
            if (WS && WS.prototype) {
                const proto = WS.prototype;
                const nativeWSsend = proto.send;
                const nativeWSadd = proto.addEventListener;
                const observedSockets = new WeakSet();

                const streamForSocket = (ws) => {
                    if (!streamStates.has(ws)) {
                        streamStates.set(ws, {
                            url: String(ws.url || ''),
                            opened_at: Date.now(),
                            protocol: ws.protocol || '',
                            messages: []
                        });
                    }
                    return streamStates.get(ws);
                };

                proto.send = exportFunction(function (data) {
                    try {
                        const stream = streamForSocket(this);
                        rememberStreamEvent('websocket', stream, {
                            at: Date.now(), direction: 'out',
                            event: 'send', payload: captureValue(data)
                        });
                    } catch {}
                    return nativeWSsend.apply(this, arguments);
                }, win);

                proto.addEventListener = exportFunction(function (type, listener, options) {
                    const ws = this;
                    if (type === 'message' && !observedSockets.has(ws)) {
                        const observer = exportFunction(function (event) {
                            try {
                                const stream = streamForSocket(ws);
                                rememberStreamEvent('websocket', stream, {
                                    at: Date.now(), direction: 'in',
                                    event: 'message',
                                    payload: captureValue(event && event.data)
                                });
                            } catch {}
                        }, win);
                        nativeWSadd.call(this, type, observer);
                        observedSockets.add(ws);
                    }
                    return nativeWSadd.apply(this, arguments);
                }, win);
                STATE.hooks.websocket = true;
            }
        } catch (e) {
            console.warn('[Chat Toolkit] WebSocket hook install failed', e);
        }

        // ---- EventSource -------------------------------------------------
        try {
            const ES = win.EventSource;
            if (ES && ES.prototype) {
                const proto = ES.prototype;
                const nativeESadd = proto.addEventListener;
                const observedEvents = new WeakMap();

                const streamForES = (es) => {
                    if (!streamStates.has(es)) {
                        streamStates.set(es, {
                            url: String(es.url || ''),
                            opened_at: Date.now(),
                            with_credentials: !!es.withCredentials,
                            messages: []
                        });
                    }
                    return streamStates.get(es);
                };

                proto.addEventListener = exportFunction(function (type, listener, options) {
                    const es = this;
                    const types = observedEvents.get(es) || new Set();
                    if (!types.has(type) && types.size < MAX_CAPTURE_ENTRIES && /^[a-zA-Z]/.test(String(type))) {
                        const observer = exportFunction(function (event) {
                            try {
                                const stream = streamForES(es);
                                const direction = (type === 'open' || type === 'error') ? 'lifecycle' : 'in';
                                rememberStreamEvent('eventsource', stream, {
                                    at: Date.now(), direction,
                                    event: String(type),
                                    last_event_id: (event && event.lastEventId) || '',
                                    payload: captureValue(event && event.data)
                                });
                            } catch {}
                        }, win);
                        nativeESadd.call(this, type, observer);
                        types.add(type);
                        observedEvents.set(es, types);
                    }
                    return nativeESadd.apply(this, arguments);
                }, win);
                STATE.hooks.eventsource = true;
            }
        } catch (e) {
            console.warn('[Chat Toolkit] EventSource hook install failed', e);
        }

        return true;
    };

    // Do not install at content-script load time. Normal page loads must leave
    // native page globals untouched so Claude/ChatGPT/Gemini can bootstrap.

    // ---- bridge API ------------------------------------------------------

    const setPageCapture = async (action) => {
        // Re-attempt install in case the page swapped in a new window object
        // (rare, but Gemini SPA navigations can re-bind globals).
        if (!STATE.hooks.installed && pageHooksAllowed()) installHooks();
        if (action === 'start') {
            clearState();
            STATE.capture = { active: true, started_at: Date.now(), stopped_at: null };
        } else if (action === 'stop') {
            STATE.capture.active = false;
            STATE.capture.stopped_at = Date.now();
        } else if (action === 'clear') {
            STATE.capture.active = false;
            STATE.capture.stopped_at = Date.now();
            clearState();
        }
    };

    const withPageCapture = async (task) => {
        await setPageCapture('start');
        try { return await task(); }
        finally { await setPageCapture('stop'); }
    };

    // STATE is a content-script object; deep-clone so callers can't mutate
    // our internal state by accident.
    const getPageState = () => {
        try {
            const snapshot = JSON.parse(safeStringify(STATE));
            snapshot.hooks = hookState();
            return snapshot;
        } catch {
            return { ...STATE, hooks: hookState() };
        }
    };

    const waitForPageState = async (attempts = 4, delayMs = 100) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
            const pageState = getPageState();
            if (pageState?.network) return pageState;
            await sleep(delayMs);
        }
        return getPageState();
    };

    // Log structured reports to the DevTools console. Content-script
    // console.* lands in the same DevTools panel as the page's own logs
    // (with an extension badge), so this serves the same purpose as the
    // old page-world CustomEvent listener — without a script injection.
    const emitPageReport = (report) => {
        try {
            console.groupCollapsed(`%c[Chat Toolkit] ${report?.title || 'Report'}`, `color:${pageColor};font-weight:bold;`);
            if (report?.summary) console.log(report.summary);
            if (Array.isArray(report?.rows) && report.rows.length) console.table(report.rows);
            if (report?.data !== undefined) console.log(report.data);
            console.groupEnd();
        } catch {
            console.log('[Chat Toolkit/report]', report);
        }
    };

    // Back-compat no-op: callers that imported `injectPageScript` no longer
    // need to do anything. Hooks are available only as an explicit debug opt-in.
    const injectPageScript = async () => {
        if (!STATE.hooks.installed && pageHooksAllowed()) installHooks();
        return STATE.hooks.installed;
    };

    // ---- parser dispatcher ----------------------------------------------
    // Prefer the extension Worker so long conversations never parse or render
    // on the host page's main thread. Keep the content-script parser only as a
    // compatibility fallback for Firefox configurations that reject Workers.

    let worker = null;
    let workerUnavailable = false;
    let workerSeq = 0;
    const pending = new Map();

    const onMessage = (event) => {
        const { id, result, error } = event.data || {};
        const handler = pending.get(id);
        if (!handler) return;
        pending.delete(id);
        if (error) handler.reject(new Error(error));
        else handler.resolve(result);
    };

    const onError = (event) => {
        console.error('[Chat Toolkit] parser worker error', event);
        workerUnavailable = true;
        for (const handler of pending.values()) handler.reject(new Error('Worker error'));
        pending.clear();
        if (worker) { worker.terminate(); worker = null; }
    };

    const ensureWorker = () => {
        if (worker) return worker;
        worker = new Worker(browser.runtime.getURL('lib/parser-worker.js'));
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        return worker;
    };

    const callWorker = (cmd, args) => {
        const w = ensureWorker();
        return new Promise((resolve, reject) => {
            const id = ++workerSeq;
            pending.set(id, { resolve, reject });
            w.postMessage({ id, cmd, args });
        });
    };

    const parserCall = async (cmd, args = {}) => {
        if (!workerUnavailable && typeof Worker !== 'undefined') {
            try {
                return await callWorker(cmd, args);
            } catch (error) {
                workerUnavailable = true;
                console.warn('[Chat Toolkit] parser Worker unavailable; using compatibility parser', error);
            }
        }
        if (typeof CT.runParserCommand === 'function') {
            return Promise.resolve().then(() => CT.runParserCommand(cmd, args));
        }
        throw new Error('Parser unavailable');
    };

    const teardownWorker = () => {
        if (!worker) return;
        try { worker.terminate(); } catch {}
        worker = null;
        for (const handler of pending.values()) handler.reject(new Error('Worker terminated'));
        pending.clear();
    };
    window.addEventListener('pagehide', teardownWorker);

    CT.injectPageScript = injectPageScript;
    CT.enablePageHooks = () => { pageHooksEnabled = true; };
    CT.setPageCapture = setPageCapture;
    CT.withPageCapture = withPageCapture;
    CT.getPageState = getPageState;
    CT.waitForPageState = waitForPageState;
    CT.emitPageReport = emitPageReport;
    CT.parserCall = parserCall;
    // Exposed for tests / debugging.
    CT.__hookState = hookState;
})();
