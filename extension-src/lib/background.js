// Background page: privileged downloads plus tab-scoped network capture.
//
// Network capture intentionally uses Firefox's webRequest APIs instead of
// patching page-world fetch/XHR/WebSocket objects. That keeps Claude,
// ChatGPT, and Gemini startup code untouched while still allowing the
// Network inspector and diagnostic capture tools to inspect API traffic.
//
// The webRequest listeners are attached only while a capture or research
// recording is active, so ordinary browsing and ordinary exports never route
// provider requests through this page.

const activeObjectUrls = new Set();
const activeCaptures = new Map();
const passiveStores = new Map();
const recordingTabs = new Set();
const requestStates = new Map();

const MAX_REQUESTS = 120;
const MAX_CAPTURE_ENTRIES = 24;
const MAX_PASSIVE_REQUESTS = 120;
const MAX_PASSIVE_CAPTURE_ENTRIES = 4;
const MAX_PASSIVE_MARKERS = 120;
const MAX_PASSIVE_STORES = 8;
const MAX_BODY_TEXT = 16000;
const MAX_LARGE_BODY_TEXT = 256000;
const MAX_BODY_PREVIEW = 4096;
const MAX_TELEMETRY_BODY_PREVIEW = 16000;
const CAPTURE_TTL_MS = 15000;
const PASSIVE_STORE_TTL_MS = 2 * 60 * 60 * 1000;
const PASSIVE_STORAGE_PREFIX = 'chatToolkitPassive:';

const REQUEST_FILTER = {
    urls: [
        'https://claude.ai/*',
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
        'https://gemini.google.com/*',
        'https://aistudio.google.com/*',
        'https://grok.com/*',
        'https://openrouter.ai/*'
    ]
};

const PLATFORM_HINTS = {
    claude: [
        '/api/', '/edge-api/', '/v1/', '/i18n/'
    ],
    chatgpt: [
        // Never capture /api/auth/session response bodies: they contain the
        // short-lived bearer token used by authenticated backend requests.
        '/backend-api/', '/public-api/', '/conversation'
    ],
    gemini: [
        '/_/BardChatUi/data/', '/_/BardChatUi/jserror'
    ],
    aistudio: [
        '/_/AiStudioUi/data/', '/_/BardChatUi/data/', '/v1internal/'
    ],
    grok: [
        '/rest/app-chat/', '/i/grok'
    ],
    openrouter: [
        '/chat'
    ]
};

const platformFromUrl = (urlString) => {
    try {
        const { hostname, pathname } = new URL(urlString);
        if (hostname === 'claude.ai') return 'claude';
        if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'chatgpt';
        if (hostname === 'gemini.google.com') return 'gemini';
        if (hostname === 'aistudio.google.com') return 'aistudio';
        if (hostname === 'grok.com') return 'grok';
        if (hostname === 'openrouter.ai') return 'openrouter';
    } catch {}
    return '';
};

const shouldObserveUrl = (state, urlString) => {
    const platform = platformFromUrl(urlString);
    if (!platform) return false;
    if (state.platform && platform !== state.platform) return false;
    return true;
};

const shouldCaptureBodyUrl = (state, urlString) => {
    if (!shouldObserveUrl(state, urlString)) return false;
    const platform = platformFromUrl(urlString);
    const hints = PLATFORM_HINTS[platform] || [];
    let path;
    try { path = decodeURIComponent(new URL(urlString).pathname); }
    catch { return false; }
    if (/\/(?:auth|oauth|login|signin|token)(?:\/|$)/i.test(path)) return false;
    return hints.some((hint) => path.startsWith(hint));
};

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

const safeJSON = (text) => {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed || !/^[{\[]/.test(trimmed)) return null;
    try { return JSON.parse(trimmed); } catch { return null; }
};

const previewText = (value, max = 1000) => {
    if (value == null) return '';
    const text = typeof value === 'string' ? value : (() => {
        try { return JSON.stringify(value); }
        catch { return String(value); }
    })();
    return text.replace(/\s+/g, ' ').trim().slice(0, max);
};

const rememberLimited = (list, item, max) => {
    list.push(item);
    if (list.length > max) list.shift();
    return item;
};

const captureSummary = (capture) => ({
    request_id: capture?.request_id || '',
    url: capture?.url || '',
    method: capture?.method || '',
    status: capture?.status || 0,
    timestamp: capture?.timestamp || Date.now(),
    duration_ms: capture?.duration_ms || 0,
    kind: capture?.kind || '',
    response_size: capture?.response_size || 0,
    preview: previewText(capture?.preview || '', MAX_BODY_PREVIEW),
    rpcids: Array.isArray(capture?.rpcids) ? capture.rpcids.slice(0, 20) : [],
    json_keys: Array.isArray(capture?.json_keys) ? capture.json_keys.slice(0, 30) : [],
    mcp: capture?.mcp || null
});

const requestSummary = (request) => ({
    request_id: request?.request_id || '',
    method: request?.method || 'GET',
    url: request?.url || '',
    type: request?.type || '',
    tab_id: request?.tab_id,
    frame_id: request?.frame_id,
    started_at: request?.started_at || 0,
    status: request?.status || 0,
    size: request?.size || 0,
    duration_ms: request?.duration_ms || 0,
    from_cache: !!request?.from_cache,
    source: request?.source || '',
    error: previewText(request?.error || request?.filter_error || '', 240)
});

const clonePlain = (value) => {
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return value; }
};

const makeDownloadUrl = (message) => {
    if (message.url) throw new Error('Only locally generated export content can be downloaded');
    const blob = new Blob([message.content || ''], {
        type: message.type || 'application/octet-stream'
    });
    const url = URL.createObjectURL(blob);
    activeObjectUrls.add(url);
    return url;
};

const releaseDownloadUrl = (url) => {
    if (!url || !activeObjectUrls.has(url)) return;
    activeObjectUrls.delete(url);
    URL.revokeObjectURL(url);
};

const makeCaptureState = (tabId, platform, pageUrl, reason) => ({
    tabId,
    platform: platform || platformFromUrl(pageUrl) || '',
    page_url: pageUrl || '',
    reason: reason || '',
    active: true,
    started_at: Date.now(),
    stopped_at: null,
    network: { started: Date.now(), requests: [] },
    captures: { _entries: [] },
    streams: { websocket: [], eventsource: [] },
    requestIndex: {},
    errors: [],
    capture_bodies: reason !== 'network-inspector',
    max_requests: MAX_REQUESTS,
    max_capture_entries: MAX_CAPTURE_ENTRIES,
    filter_response_available: !!browser.webRequest.filterResponseData
});

const makePassiveStore = (key, tabId, pageUrl) => ({
    tabId,
    passive_key: key,
    platform: 'chatgpt',
    page_url: pageUrl || '',
    reason: 'passive-chatgpt-store',
    passive: true,
    active: false,
    started_at: Date.now(),
    updated_at: Date.now(),
    stopped_at: null,
    network: { started: Date.now(), requests: [] },
    captures: { _entries: [] },
    streams: { websocket: [], eventsource: [] },
    requestIndex: {},
    errors: [],
    markers: [],
    probes: [],
    capture_bodies: true,
    filter_response_available: !!browser.webRequest.filterResponseData,
    max_requests: MAX_PASSIVE_REQUESTS,
    max_capture_entries: MAX_PASSIVE_CAPTURE_ENTRIES
});

const prunePassiveStores = (keepKey = '') => {
    const now = Date.now();
    for (const [key, state] of passiveStores) {
        if ((now - (state.updated_at || state.started_at || 0)) > PASSIVE_STORE_TTL_MS) {
            passiveStores.delete(key);
        }
    }
    if (passiveStores.size < MAX_PASSIVE_STORES) return;
    const oldest = [...passiveStores.entries()]
        .filter(([key]) => key !== keepKey)
        .sort((a, b) => (a[1].updated_at || 0) - (b[1].updated_at || 0));
    while (passiveStores.size >= MAX_PASSIVE_STORES && oldest.length) {
        passiveStores.delete(oldest.shift()[0]);
    }
};

const extractConversationId = (urlString) => {
    try {
        const path = new URL(urlString || '').pathname;
        const match = path.match(/\/c\/([a-f0-9-]{8,})/i) ||
            path.match(/\/conversation\/([a-f0-9-]{8,})/i);
        return match?.[1] || '';
    } catch {
        return '';
    }
};

const isChatGPTUrl = (urlString) => platformFromUrl(urlString) === 'chatgpt';
const requestPath = (urlString) => {
    try { return decodeURIComponent(new URL(urlString).pathname); }
    catch { return ''; }
};
const isMcpUrl = (urlString) => requestPath(urlString) === '/backend-api/ecosystem/call_mcp';
const isCesSignalUrl = (urlString) =>
    /^\/ces\/(?:v1\/(?:t|m|telemetry\/intake)|statsc\/flush)\/?$/.test(requestPath(urlString));

const shouldPassiveStoreUrl = (urlString) =>
    isChatGPTUrl(urlString) && (isMcpUrl(urlString) || isCesSignalUrl(urlString));

const maxRequestBodyTextForUrl = (urlString) =>
    isCesSignalUrl(urlString) ? MAX_TELEMETRY_BODY_PREVIEW : MAX_BODY_PREVIEW;

const passiveKeyForDetails = (details) => {
    if (details?.incognito || !recordingTabs.has(details?.tabId) || !shouldPassiveStoreUrl(details?.url)) return '';
    const convId = extractConversationId(details.documentUrl || details.originUrl || details.url);
    return convId ? `tab:${details.tabId}:chatgpt:${convId}` : passiveKeyForTab(details.tabId);
};

const passiveKeyForPage = (urlString, tabId) => {
    const convId = extractConversationId(urlString);
    if (convId && tabId >= 0) return `tab:${tabId}:chatgpt:${convId}`;
    return passiveKeyForTab(tabId);
};

const passiveKeyForTab = (tabId) => (
    tabId != null && tabId >= 0 ? `tab:${tabId}` : ''
);

const summarizePassiveStore = (state) => ({
    request_count: state?.network?.requests?.length || 0,
    capture_count: state?.captures?._entries?.length || 0,
    marker_count: state?.markers?.length || 0,
    probe_count: state?.probes?.length || 0,
    stored_sessions: [...new Set((state?.captures?._entries || [])
        .map((capture) => capture?.mcp?.session_id)
        .filter(Boolean))],
    known_sessions: [...new Set((state?.probes || [])
        .map((probe) => probe?.session_id)
        .filter(Boolean))],
    latest_marker: state?.markers?.[state.markers.length - 1] || null,
    latest_capture: state?.captures?._latest?.mcp || null
});

const passiveStoreSnapshot = (state) => clonePlain({
    success: !!state,
    passive: true,
    platform: state?.platform || 'chatgpt',
    tab_id: state?.tabId,
    page_url: state?.page_url || '',
    started_at: state?.started_at || 0,
    updated_at: state?.updated_at || 0,
    network: state?.network || { started: 0, requests: [] },
    captures: state?.captures || { _entries: [] },
    streams: state?.streams || { websocket: [], eventsource: [] },
    errors: state?.errors || [],
    markers: state?.markers || [],
    probes: state?.probes || [],
    storage_error: state?.storage_error || '',
    summary: summarizePassiveStore(state)
});

const passiveStoreSummarySnapshot = (state) => clonePlain({
    success: !!state,
    passive: true,
    platform: state?.platform || 'chatgpt',
    tab_id: state?.tabId,
    page_url: state?.page_url || '',
    started_at: state?.started_at || 0,
    updated_at: state?.updated_at || 0,
    storage_error: state?.storage_error || '',
    summary: summarizePassiveStore(state),
    markers: (state?.markers || []).slice(-40),
    probes: (state?.probes || []).slice(-20)
});

const persistPassiveStore = (state) => {
    // Diagnostics are session memory only. Never persist chat/account content
    // to disk or restore it into another tab, account, or Firefox container.
    if (!state?.passive_key || state.retired) return;
    state.updated_at = Date.now();
};

const passiveStoreForDetails = (details, create = false) => {
    const key = passiveKeyForDetails(details);
    if (!key) return null;
    prunePassiveStores(key);
    let state = passiveStores.get(key);
    if (!state && create) {
        state = makePassiveStore(key, details.tabId, details.documentUrl || details.originUrl || details.url);
        passiveStores.set(key, state);
    }
    return state;
};

const passiveStoreForTab = (tabId, create = false) => {
    const key = passiveKeyForTab(tabId);
    if (!key) return null;
    prunePassiveStores(key);
    let state = passiveStores.get(key);
    if (!state && create && recordingTabs.has(tabId)) {
        state = makePassiveStore(key, tabId, '');
        passiveStores.set(key, state);
    }
    return state;
};

const passiveStoreForPage = (urlString, tabId, create = false) => {
    const key = passiveKeyForPage(urlString, tabId);
    if (!key) return null;
    prunePassiveStores(key);
    let state = passiveStores.get(key);
    if (!state && create && recordingTabs.has(tabId)) {
        state = makePassiveStore(key, tabId, urlString);
        passiveStores.set(key, state);
    }
    return state;
};

const registerRequestState = (requestId, state) => {
    if (!requestId || !state) return;
    let set = requestStates.get(requestId);
    if (!set) {
        set = new Set();
        requestStates.set(requestId, set);
    }
    set.add(state);
};

const statesForRequest = (details) => {
    const set = new Set(requestStates.get(details.requestId) || []);
    const direct = activeCaptures.get(details.tabId);
    if (direct?.requestIndex?.[details.requestId]) set.add(direct);
    const active = activeStateForDetails(details);
    if (active?.requestIndex?.[details.requestId]) set.add(active);
    const passive = passiveStoreForDetails(details, false);
    if (passive?.requestIndex?.[details.requestId]) set.add(passive);
    return [...set];
};

const markerFromSegmentBody = (entry, body) => {
    const props = body.properties || {};
    const page = body.context?.page || {};
    const conversationId = props.conversation_id ||
        props.client_thread_id ||
        props.conversationId ||
        extractConversationId(page.path || page.url || '');
    const messageId = props.message_id || props.suggestion_message_id || '';
    const sessionId = props.session_id || '';

    return {
        at: body.timestamp || new Date(entry.started_at || Date.now()).toISOString(),
        event: body.event || '',
        type: body.type || '',
        url: entry.url,
        request_id: entry.request_id,
        conversation_id: conversationId || '',
        message_id: messageId || '',
        session_id: sessionId,
        plan_id: props.plan_id || '',
        turn_index: props.turn_index ?? '',
        include_all_history: props.include_all_history ?? '',
        source: props.source || '',
        attribution_id: props.attribution_id || '',
        app_version: props.app_version || ''
    };
};

const telemetryBodies = (text) => {
    if (!text || typeof text !== 'string') return [];
    const parsed = parseRequestJSON(text);
    if (parsed) return Array.isArray(parsed) ? parsed : [parsed];

    const bodies = [];
    for (const line of text.split(/\n+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const item = parseRequestJSON(trimmed);
        if (item) bodies.push(item);
    }
    return bodies;
};

const markerFromTelemetryBody = (entry, body) => {
    if (!body || typeof body !== 'object') return null;
    const text = (() => {
        try { return JSON.stringify(body); }
        catch { return ''; }
    })();
    if (!/conversation_id|message_id|model_slug|thinking|reasoning|render|deep-research/i.test(text)) return null;

    const url = body.url || body.view?.url || body.body?.documentURL || '';
    const tags = body.tags || body.body?.tags || {};
    return {
        at: body.date ? new Date(body.date).toISOString() : new Date(entry.started_at || Date.now()).toISOString(),
        event: body.message || body.metric || body.type || body.stage || '',
        type: body.type || body.status || '',
        url: entry.url,
        request_id: entry.request_id,
        conversation_id: body.conversation_id || body.client_thread_id || body.conversationId || extractConversationId(url),
        message_id: body.message_id || '',
        session_id: body.session_id || body.session?.id || '',
        model_slug: body.model_slug || tags.model_slug || '',
        message_author_role: body.message_author_role || '',
        message_channel: body.message_channel || '',
        stage: body.stage || '',
        render_skip_reason: body.render_skip_reason || '',
        render_observer_result: body.render_observer_result || '',
        source: body.origin || body.logger?.name || '',
        app_version: body.ddtags || ''
    };
};

const markersFromRequest = (entry) => {
    if (!isCesSignalUrl(entry.url)) return [];
    return telemetryBodies(entry.request_body).map((body) => {
        if (body?.type === 'track' || body?.event || body?.properties) {
            return markerFromSegmentBody(entry, body);
        }
        return markerFromTelemetryBody(entry, body);
    }).filter(Boolean);
};

const rememberPassiveProbe = (state, probe) => {
    if (!state || !probe?.conversation_id || !probe?.message_id) return null;
    const normalized = {
        app_uri: probe.app_uri || 'connectors://connector_openai_deep_research',
        tool_name: 'get_state',
        conversation_id: probe.conversation_id || '',
        message_id: probe.message_id || '',
        session_id: probe.session_id || '',
        plan_id: probe.plan_id || '',
        include_all_history: probe.include_all_history ?? '',
        source: probe.source || '',
        first_seen_at: probe.first_seen_at || Date.now(),
        last_seen_at: Date.now()
    };
    const key = normalized.session_id ||
        `${normalized.conversation_id}:${normalized.message_id}`;
    const probes = Array.isArray(state.probes) ? state.probes : (state.probes = []);
    const existing = probes.find((item) => (
        (normalized.session_id && item.session_id === normalized.session_id) ||
        (!normalized.session_id && item.conversation_id === normalized.conversation_id && item.message_id === normalized.message_id)
    ));
    if (existing) {
        Object.assign(existing, Object.fromEntries(Object.entries(normalized)
            .filter(([, value]) => value !== '' && value != null)));
        existing.last_seen_at = Date.now();
    } else {
        probes.push({ ...normalized, passive_probe_key: key });
        if (probes.length > 40) probes.shift();
    }
    persistPassiveStore(state);
    return existing || probes[probes.length - 1];
};

const rememberPassiveMarker = (state, entry) => {
    const markers = markersFromRequest(entry);
    if (!state || !markers.length) return;
    for (const marker of markers) {
        rememberLimited(state.markers, marker, MAX_PASSIVE_MARKERS);
        if (marker.session_id && marker.conversation_id && marker.message_id) {
            rememberPassiveProbe(state, {
                app_uri: marker.attribution_id === 'connector_openai_deep_research'
                    ? 'connectors://connector_openai_deep_research'
                    : '',
                conversation_id: marker.conversation_id,
                message_id: marker.message_id,
                session_id: marker.session_id,
                plan_id: marker.plan_id,
                include_all_history: marker.include_all_history,
                source: 'telemetry'
            });
        }
    }
    persistPassiveStore(state);
};

const rememberMcpRequestProbe = (state, entry) => {
    const req = parseRequestJSON(entry?.request_body);
    if (!state || !req || req.app_uri !== 'connectors://connector_openai_deep_research') return;
    if (req.tool_name === 'get_state') {
        rememberPassiveProbe(state, {
            app_uri: req.app_uri,
            conversation_id: req.conversation_id,
            message_id: req.message_id,
            session_id: req.tool_input?.session_id || '',
            source: 'mcp-request'
        });
    }
};

const storedSessionIds = (state) => new Set((state?.captures?._entries || [])
    .map((capture) => capture?.mcp?.session_id)
    .filter(Boolean));

const missingPassiveProbes = (state) => {
    const stored = storedSessionIds(state);
    return (state?.probes || [])
        .filter((probe) => probe.session_id && !stored.has(probe.session_id))
        .slice(0, 4);
};

const passiveStatus = (message, sender, create = false) => {
    const tabId = sender?.tab?.id;
    if (sender?.tab?.incognito) return { success: false, enabled: false, error: 'Diagnostic recording is disabled in private windows' };
    const pageUrl = message?.url || sender?.tab?.url || '';
    const state = passiveStoreForPage(pageUrl, tabId, create);
    const snapshot = message?.full
        ? passiveStoreSnapshot(state)
        : passiveStoreSummarySnapshot(state);
    snapshot.missing_probes = missingPassiveProbes(state);
    snapshot.enabled = recordingTabs.has(tabId);
    return snapshot;
};

const cleanupCapture = (tabId) => {
    const state = activeCaptures.get(tabId);
    if (!state || state.active) return;
    activeCaptures.delete(tabId);
};

const activeStateForDetails = (details) => {
    if (details.incognito) return null;
    const direct = activeCaptures.get(details.tabId);
    if (direct?.active && shouldObserveUrl(direct, details.url)) return direct;
    // Unattributed requests may belong to a different tab/account/container.
    return null;
};

const limitedByteView = (bytes, maxBytes) => {
    if (!bytes || !Number.isFinite(maxBytes) || maxBytes <= 0) return new Uint8Array(0);
    const length = Math.min(bytes.byteLength || 0, maxBytes);
    if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, length);
    }
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes, 0, length);
    return bytes;
};

const decodeRawBytes = (rawItems, maxText = MAX_BODY_PREVIEW) => {
    if (!Array.isArray(rawItems) || !rawItems.length) return '';
    try {
        const decoder = new TextDecoder();
        let text = '';
        for (const item of rawItems) {
            if (!item?.bytes || text.length >= maxText) continue;
            const remaining = maxText - text.length;
            const view = limitedByteView(item.bytes, remaining * 4);
            text += decoder.decode(view, { stream: true }).slice(0, remaining);
        }
        if (text.length < maxText) text += decoder.decode().slice(0, maxText - text.length);
        return text.slice(0, maxText);
    } catch {
        return '';
    }
};

const requestBodyText = (details) => {
    const body = details.requestBody;
    const maxText = maxRequestBodyTextForUrl(details.url);
    if (!body) return '';
    if (body.formData && typeof URLSearchParams !== 'undefined') {
        const params = new URLSearchParams();
        for (const [key, values] of Object.entries(body.formData)) {
            for (const value of values || []) params.append(key, value);
        }
        return params.toString().slice(0, maxText);
    }
    return decodeRawBytes(body.raw, maxText);
};

const maxBodyTextForUrl = (url) =>
    /\/backend-api\/ecosystem\/call_mcp\b/.test(url || '') ? MAX_LARGE_BODY_TEXT : MAX_BODY_TEXT;

const parseRequestJSON = (text) => {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch { return null; }
};

const summarizeMcpCapture = (parsed, requestBody) => {
    const req = parseRequestJSON(requestBody) || {};
    const meta = parsed?._meta || parsed?.meta || {};
    const deepMessages = meta.deep_research_widget_messages;
    const sourceSearches = meta.source_searches;
    const widgetTypeCounts = Array.isArray(deepMessages)
        ? deepMessages.reduce((counts, message) => {
            const type = message?.content?.content_type || 'unknown';
            counts[type] = (counts[type] || 0) + 1;
            return counts;
        }, {})
        : {};
    const thoughtCount = Array.isArray(deepMessages)
        ? deepMessages.reduce((total, message) => total + (Array.isArray(message?.content?.thoughts) ? message.content.thoughts.length : 0), 0)
        : 0;
    const thoughtContainerCount = Array.isArray(deepMessages)
        ? deepMessages.filter((message) => Array.isArray(message?.content?.thoughts) && message.content.thoughts.length).length
        : 0;
    const thoughtSamples = Array.isArray(deepMessages)
        ? deepMessages.flatMap((message) => (message?.content?.thoughts || []).map((thought) => ({
            summary: previewText(thought?.summary || '', 220),
            content: previewText(thought?.content || '', 360),
            finished: !!thought?.finished,
            source_analysis_msg_id: message?.content?.source_analysis_msg_id || ''
        }))).filter((thought) => thought.summary || thought.content).slice(0, 8)
        : [];

    return {
        app_uri: req.app_uri || '',
        tool_name: req.tool_name || '',
        conversation_id: req.conversation_id || '',
        message_id: req.message_id || '',
        session_id: req.tool_input?.session_id || '',
        deep_research_widget_message_count: Array.isArray(deepMessages) ? deepMessages.length : 0,
        deep_research_widget_type_counts: widgetTypeCounts,
        deep_research_thought_container_count: thoughtContainerCount,
        deep_research_thought_count: thoughtCount,
        deep_research_thought_samples: thoughtSamples,
        source_search_count: Array.isArray(sourceSearches) ? sourceSearches.length : 0,
        is_error: !!parsed?.isError,
        meta_keys: Object.keys(meta || {}).slice(0, 20)
    };
};

const rememberCapture = (state, capture, entry) => {
    const entries = Array.isArray(state.captures._entries)
        ? state.captures._entries
        : (state.captures._entries = []);
    const maxEntries = state.max_capture_entries || MAX_CAPTURE_ENTRIES;

    if (state.passive && capture?.mcp) {
        const key = capture.mcp.session_id ||
            `${capture.mcp.conversation_id || ''}:${capture.mcp.message_id || ''}:${capture.mcp.tool_name || ''}`;
        capture.passive_capture_key = key;
        const index = entries.findIndex((item) => item.passive_capture_key === key);
        if (index !== -1) {
            const existing = entries[index];
            const oldScore = (existing.mcp?.deep_research_widget_message_count || 0) +
                (existing.mcp?.deep_research_thought_count || 0) +
                Math.floor((existing.response_size || 0) / 1000);
            const newScore = (capture.mcp?.deep_research_widget_message_count || 0) +
                (capture.mcp?.deep_research_thought_count || 0) +
                Math.floor((capture.response_size || 0) / 1000);
            if (newScore >= oldScore) entries[index] = capture;
        } else {
            rememberLimited(entries, capture, maxEntries);
        }
    } else {
        rememberLimited(entries, capture, maxEntries);
    }

    const summary = captureSummary(capture);
    state.captures._latest = summary;
    try {
        state.captures[new URL(entry.url).origin + new URL(entry.url).pathname] = summary;
    } catch {
        state.captures[String(entry.url || '').split('?')[0]] = summary;
    }
    if (state.passive) persistPassiveStore(state);
};

const mirrorPassiveCapture = (entry, capture) => {
    if (!entry?.passive_key || capture?.kind !== 'mcp') return;
    const passive = passiveStores.get(entry.passive_key);
    if (!passive || passive.retired || !recordingTabs.has(passive.tabId)) return;
    rememberCapture(passive, {
        ...clonePlain(capture),
        source: 'webRequest-passive-mirror'
    }, entry);
};

const processCaptureText = (state, entry, text) => {
    if (!text || state.retired || (state.passive && !recordingTabs.has(state.tabId))) return null;
    const capture = {
        request_id: entry.request_id,
        url: entry.url,
        method: entry.method,
        status: entry.status || 0,
        timestamp: Date.now(),
        source: 'webRequest',
        request_body: entry.request_body || '',
        request_preview: previewText(entry.request_body, 1000),
        response_size: entry.size || 0
    };

    const isBatch = /\/batchexecute/.test(entry.url) || /^\)\]\}'/.test(text);
    if (isBatch) {
        const batch = decodeBatchExecute(text);
        capture.kind = 'batchexecute';
        capture.rpcids = [...new Set(batch.map((item) => item.rpcid).filter(Boolean))];
        capture.preview = previewText(batch.length ? batch.map((item) => item.rpcid).join(', ') : text);
        if (batch.length) capture.batch = batch;
        else capture.text = text.slice(0, MAX_BODY_TEXT);
    } else {
        const parsed = safeJSON(text.replace(/^\)\]\}'?\n?/, '').split('\n')[0] || text);
        if (parsed != null) {
            capture.kind = /\/backend-api\/ecosystem\/call_mcp\b/.test(entry.url || '') ? 'mcp' : 'json';
            capture.json_keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 30) : [];
            capture.preview = previewText(parsed);
            capture.json = parsed;
            if (capture.kind === 'mcp') capture.mcp = summarizeMcpCapture(parsed, entry.request_body);
        } else {
            capture.kind = 'text';
            capture.preview = previewText(text);
            capture.text = text.slice(0, MAX_BODY_TEXT);
        }
    }

    rememberCapture(state, capture, entry);
    if (!state.passive) mirrorPassiveCapture(entry, capture);
    return capture;
};

const attachResponseFilter = (state, details, entry) => {
    if (!browser.webRequest.filterResponseData) return;

    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (error) {
        entry.filter_error = error?.message || String(error);
        return;
    }

    let text = '';
    let size = 0;
    const decoder = new TextDecoder();
    const maxText = maxBodyTextForUrl(details.url);

    filter.ondata = (event) => {
        const chunk = event.data;
        size += chunk?.byteLength || 0;
        if (text.length < maxText) {
            try {
                const remaining = maxText - text.length;
                const view = limitedByteView(chunk, remaining * 4);
                text += decoder.decode(view, { stream: true });
                if (text.length > maxText) text = text.slice(0, maxText);
            } catch {}
        }
        filter.write(chunk);
    };

    filter.onstop = () => {
        try { text += decoder.decode(); } catch {}
        entry.size = size;
        processCaptureText(state, entry, text);
        try { filter.close(); } catch {}
    };

    filter.onerror = () => {
        entry.filter_error = filter.error || 'Stream filter error';
        try { filter.disconnect(); } catch {}
    };
};

const rememberRequest = (state, details) => {
    const startedAt = Math.round(details.timeStamp || Date.now());
    const bodyCapture = state.capture_bodies !== false && (
        shouldCaptureBodyUrl(state, details.url) ||
        (state.passive && shouldPassiveStoreUrl(details.url))
    );
    const entry = {
        request_id: details.requestId,
        method: details.method || 'GET',
        url: details.url || '',
        type: details.type || '',
        tab_id: details.tabId,
        frame_id: details.frameId,
        document_url: details.documentUrl || details.originUrl || '',
        started_at: startedAt,
        status: 0,
        size: 0,
        duration_ms: 0,
        source: 'webRequest',
        request_body: bodyCapture ? requestBodyText(details) : '',
        body_capture: bodyCapture
    };
    state.requestIndex[details.requestId] = entry;
    registerRequestState(details.requestId, state);
    return rememberLimited(state.network.requests, entry, state.max_requests || MAX_REQUESTS);
};

const onBeforeRequest = (details) => {
    if (details.incognito) return {};
    const state = activeStateForDetails(details);
    const passive = passiveStoreForDetails(details, true);
    let passiveEntry = null;
    if (passive) {
        passiveEntry = rememberRequest(passive, details);
        rememberPassiveMarker(passive, passiveEntry);
        rememberMcpRequestProbe(passive, passiveEntry);
    }

    if (!state) {
        if (passiveEntry && isMcpUrl(details.url)) attachResponseFilter(passive, details, passiveEntry);
        return {};
    }

    const entry = rememberRequest(state, details);
    if (passive?.passive_key) entry.passive_key = passive.passive_key;
    if (entry.body_capture) attachResponseFilter(state, details, entry);
    return {};
};

const updateCompletedState = (state, details) => {
    const entry = state?.requestIndex?.[details.requestId];
    if (!entry) return false;
    entry.status = details.statusCode || 0;
    entry.from_cache = !!details.fromCache;
    entry.duration_ms = Math.max(0, Math.round((details.timeStamp || Date.now()) - entry.started_at));
    for (const capture of state.captures._entries || []) {
        if (capture.request_id !== details.requestId) continue;
        capture.status = entry.status;
        capture.duration_ms = entry.duration_ms;
    }
    delete state.requestIndex[details.requestId];
    if (state.passive) persistPassiveStore(state);
    return true;
};

const onCompleted = (details) => {
    for (const state of statesForRequest(details)) updateCompletedState(state, details);
    requestStates.delete(details.requestId);
};

const updateErrorState = (state, details) => {
    const entry = state?.requestIndex?.[details.requestId];
    if (!entry) return false;
    entry.status = 0;
    entry.error = details.error || 'Request failed';
    entry.duration_ms = Math.max(0, Math.round((details.timeStamp || Date.now()) - entry.started_at));
    for (const capture of state.captures._entries || []) {
        if (capture.request_id !== details.requestId) continue;
        capture.status = 0;
        capture.error = entry.error;
        capture.duration_ms = entry.duration_ms;
    }
    rememberLimited(state.errors, {
        at: Date.now(),
        url: details.url,
        request_id: details.requestId,
        error: entry.error
    }, 40);
    delete state.requestIndex[details.requestId];
    if (state.passive) persistPassiveStore(state);
    return true;
};

const onErrorOccurred = (details) => {
    for (const state of statesForRequest(details)) updateErrorState(state, details);
    requestStates.delete(details.requestId);
};

const mergeCaptureObjects = (primary = {}, passive = {}, includeBodies = true) => {
    const merged = { ...(passive || {}), ...(primary || {}) };
    const seen = new Set();
    const entries = [...(passive?._entries || []), ...(primary?._entries || [])]
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .filter((capture) => {
            const key = capture.passive_capture_key || capture.request_id || `${capture.url}:${capture.timestamp}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    if (entries.length) {
        merged._entries = includeBodies ? entries : entries.map(captureSummary);
        merged._latest = captureSummary(entries[entries.length - 1]);
    }
    return merged;
};

const mergeSnapshotState = (state, passive) => {
    const activeRequests = state?.network?.requests || [];
    const passiveRequests = passive?.network?.requests || [];
    const includeBodies = state?.capture_bodies !== false;
    const seenRequests = new Set();
    const requests = [...activeRequests, ...passiveRequests]
        .sort((a, b) => (a.started_at || 0) - (b.started_at || 0))
        .filter((request) => {
            const key = request.request_id || `${request.method}:${request.url}:${request.started_at}`;
            if (seenRequests.has(key)) return false;
            seenRequests.add(key);
            return true;
        })
        .slice(-MAX_REQUESTS)
        .map((request) => includeBodies ? request : requestSummary(request));
    const startedValues = [
        state?.network?.started,
        passive?.network?.started
    ].filter(Boolean);

    return {
        network: {
            started: startedValues.length ? Math.min(...startedValues) : 0,
            requests
        },
        captures: mergeCaptureObjects(state?.captures, passive?.captures, includeBodies),
        streams: {
            websocket: [
                ...(passive?.streams?.websocket || []),
                ...(state?.streams?.websocket || [])
            ],
            eventsource: [
                ...(passive?.streams?.eventsource || []),
                ...(state?.streams?.eventsource || [])
            ]
        },
        errors: [
            ...(passive?.errors || []),
            ...(state?.errors || [])
        ]
    };
};

const snapshotCapture = (state, tabId, pageUrl) => {
    const passive = passiveStoreForPage(pageUrl || state?.page_url || '', tabId ?? state?.tabId, false) ||
        passiveStoreForTab(tabId ?? state?.tabId, false);
    const merged = mergeSnapshotState(state, passive);

    if (!state && !passive) return {
        success: false,
        error: 'No active network capture for this tab',
        network: { started: 0, requests: [] },
        captures: { _entries: [] },
        streams: { websocket: [], eventsource: [] },
        passive_store: { success: false, passive: true }
    };

    return clonePlain({
        success: true,
        platform: state?.platform || passive?.platform || '',
        tab_id: state?.tabId ?? passive?.tabId,
        page_url: state?.page_url || passive?.page_url || pageUrl || '',
        reason: state?.reason || passive?.reason || '',
        capture: {
            active: !!state?.active,
            started_at: state?.started_at || passive?.started_at || 0,
            stopped_at: state?.stopped_at || null,
            capture_bodies: state?.capture_bodies !== false,
            filter_response_available: !!(state?.filter_response_available || passive?.filter_response_available)
        },
        network: merged.network,
        captures: merged.captures,
        streams: merged.streams,
        errors: merged.errors,
        passive_store: passiveStoreSummarySnapshot(passive)
    });
};

const startCapture = (message, sender) => {
    const tabId = sender?.tab?.id;
    if (sender?.tab?.incognito) return { success: false, error: 'Diagnostic recording is disabled in private windows' };
    if (tabId == null) return { success: false, error: 'No sender tab for network capture' };
    const pageUrl = sender.url || sender.tab.url || '';
    const platform = platformFromUrl(pageUrl);
    if (!platform || (message.platform && message.platform !== platform)) {
        return { success: false, error: 'Network capture must match the current chat provider' };
    }
    const state = makeCaptureState(tabId, platform, pageUrl, message.reason);
    activeCaptures.set(tabId, state);
    attachRequestListeners();
    return snapshotCapture(state, tabId, message.url);
};

const stopCapture = (sender) => {
    if (sender?.tab?.incognito) return { success: false, error: 'Diagnostic recording is disabled in private windows' };
    const tabId = sender?.tab?.id;
    const state = activeCaptures.get(tabId);
    if (state) {
        state.active = false;
        state.stopped_at = Date.now();
        setTimeout(() => cleanupCapture(tabId), CAPTURE_TTL_MS);
        scheduleDetach();
    }
    return snapshotCapture(state, tabId, sender?.tab?.url);
};

const getCapture = (sender) => {
    if (sender?.tab?.incognito) return { success: false, error: 'Diagnostic recording is disabled in private windows' };
    const tabId = sender?.tab?.id;
    return snapshotCapture(activeCaptures.get(tabId), tabId, sender?.tab?.url);
};

const ingestPassiveMcp = (message, sender) => {
    const tabId = sender?.tab?.id;
    if (sender?.tab?.incognito || !recordingTabs.has(tabId)) return { success: false, error: 'Diagnostic recording is off' };
    const pageUrl = message?.url || sender?.tab?.url || '';
    const state = passiveStoreForPage(pageUrl, tabId, true);
    if (!state) return { success: false, error: 'No passive store for this page' };

    const request = message.request || {};
    const response = message.response || {};
    const responseText = (typeof response === 'string' ? response : (() => {
        try { return JSON.stringify(response); }
        catch { return ''; }
    })()).slice(0, MAX_LARGE_BODY_TEXT);
    const entry = {
        request_id: `manual:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        method: 'POST',
        url: `${new URL(pageUrl || 'https://chatgpt.com/').origin}/backend-api/ecosystem/call_mcp`,
        type: 'xmlhttprequest',
        tab_id: tabId,
        frame_id: 0,
        document_url: pageUrl,
        started_at: Date.now(),
        status: message.status || 0,
        size: responseText.length,
        duration_ms: message.duration_ms || 0,
        source: 'content-research-state',
        request_body: JSON.stringify(request).slice(0, MAX_BODY_PREVIEW),
        body_capture: true
    };
    rememberLimited(state.network.requests, entry, state.max_requests || MAX_PASSIVE_REQUESTS);
    rememberMcpRequestProbe(state, entry);
    processCaptureText(state, entry, responseText);
    persistPassiveStore(state);
    const snapshot = passiveStoreSnapshot(state);
    snapshot.missing_probes = missingPassiveProbes(state);
    return snapshot;
};

const clearTabDiagnostics = (tabId) => {
    recordingTabs.delete(tabId);
    const capture = activeCaptures.get(tabId);
    if (capture) capture.retired = true;
    activeCaptures.delete(tabId);
    for (const [key, state] of passiveStores) {
        if (state.tabId !== tabId) continue;
        state.retired = true;
        passiveStores.delete(key);
    }
    for (const [id, states] of requestStates) {
        for (const state of states) if (state.tabId === tabId) states.delete(state);
        if (!states.size) requestStates.delete(id);
    }
};

const changeDiagnostics = (message, sender) => {
    const tabId = sender?.tab?.id;
    if (tabId == null || sender.tab.incognito || !platformFromUrl(sender.url || sender.tab.url)) {
        return { success: false, error: 'Open a supported chat in a non-private tab to record diagnostics' };
    }
    if (message.action === 'diagnostics-start') {
        recordingTabs.add(tabId);
        attachRequestListeners();
    }
    if (message.action === 'diagnostics-stop') {
        recordingTabs.delete(tabId);
        scheduleDetach();
    }
    if (message.action === 'diagnostics-status') {
        return { success: true, enabled: recordingTabs.has(tabId) };
    }
    if (message.action === 'diagnostics-clear') {
        clearTabDiagnostics(tabId);
        // Only the user's explicit Clear action removes legacy disk caches.
        // No new version writes or restores these old localStorage entries.
        if (typeof localStorage !== 'undefined') {
            for (const key of Object.keys(localStorage)) {
                if (key.startsWith(PASSIVE_STORAGE_PREFIX)) localStorage.removeItem(key);
            }
        }
        detachRequestListenersIfIdle();
    }
    return { success: true, enabled: recordingTabs.has(tabId) };
};

let listenersAttached = false;
let detachTimer = null;

const diagnosticsActive = () => recordingTabs.size > 0 ||
    [...activeCaptures.values()].some((state) => state.active);

const attachRequestListeners = () => {
    if (detachTimer) { clearTimeout(detachTimer); detachTimer = null; }
    if (listenersAttached) return;
    browser.webRequest.onBeforeRequest.addListener(
        onBeforeRequest,
        REQUEST_FILTER,
        ['blocking', 'requestBody']
    );
    browser.webRequest.onCompleted.addListener(onCompleted, REQUEST_FILTER);
    browser.webRequest.onErrorOccurred.addListener(onErrorOccurred, REQUEST_FILTER);
    listenersAttached = true;
};

const detachRequestListenersIfIdle = () => {
    if (!listenersAttached || diagnosticsActive()) return;
    browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    browser.webRequest.onCompleted.removeListener(onCompleted);
    browser.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
    requestStates.clear();
    listenersAttached = false;
};

// Requests already in flight when recording stops still report completion
// for a short grace period before the listeners are removed.
const scheduleDetach = () => {
    if (detachTimer) clearTimeout(detachTimer);
    detachTimer = setTimeout(() => {
        detachTimer = null;
        detachRequestListenersIfIdle();
    }, CAPTURE_TTL_MS);
};

browser.tabs.onRemoved.addListener((tabId) => {
    clearTabDiagnostics(tabId);
    detachRequestListenersIfIdle();
});
browser.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url && change.status !== 'loading') return;
    clearTabDiagnostics(tabId);
    detachRequestListenersIfIdle();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'open-help') {
        browser.runtime.openOptionsPage().then(
            () => sendResponse({ success: true }),
            (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
    }
    if (/^diagnostics-(?:start|stop|clear|status)$/.test(message?.action || '')) {
        sendResponse(changeDiagnostics(message, sender));
        return;
    }
    if (message?.action === 'download') {
        let url;
        try { url = makeDownloadUrl(message); }
        catch (error) { sendResponse({ success: false, error: error.message }); return; }
        browser.downloads.download({ url, filename: message.filename, saveAs: false })
            .then((downloadId) => {
                setTimeout(() => releaseDownloadUrl(url), 1000);
                sendResponse({ success: true, downloadId });
            })
            .catch((err) => {
                releaseDownloadUrl(url);
                sendResponse({ success: false, error: err.message });
            });

        return true;
    }

    if (message?.action === 'network-capture-start') {
        sendResponse(startCapture(message, sender));
        return;
    }
    if (message?.action === 'network-capture-get') {
        sendResponse(getCapture(sender));
        return;
    }
    if (message?.action === 'network-capture-stop') {
        sendResponse(stopCapture(sender));
        return;
    }
    if (message?.action === 'passive-store-status') {
        sendResponse(passiveStatus(message, sender, !!message.create));
        return;
    }
    if (message?.action === 'passive-store-ingest-mcp') {
        sendResponse(ingestPassiveMcp(message, sender));
    }
});
