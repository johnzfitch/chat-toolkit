// Same-origin fetchers for each platform's chat API.
//
// All fetches go to the host the user is already on — no cross-origin traffic
// leaves the page. The extension makes no calls to anthropic.com,
// openai.com, or anywhere else of its own accord.

(function () {
    'use strict';

    const CT = window.__chatToolkit;
    if (!CT) return;

    const { PLATFORM, safeStringify, decodeBatchExecute, batchPayload } = CT;
    const delay = CT.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    // Validate before reading any credential. Callers can only retrieve data
    // from the provider in this tab, and redirects cannot carry identifiers
    // or authenticated request bodies to an unrelated destination.
    const providerURL = (input) => {
        const allowedHosts = {
            claude: ['claude.ai'], chatgpt: ['chatgpt.com', 'chat.openai.com'],
            grok: ['grok.com'], gemini: ['gemini.google.com'],
            aistudio: ['aistudio.google.com'], openrouter: ['openrouter.ai']
        };
        const target = new URL(input, location.origin);
        if (target.protocol !== 'https:' || target.origin !== location.origin ||
            !allowedHosts[PLATFORM]?.includes(target.hostname) || target.username || target.password) {
            throw new Error('Authenticated requests must stay on the current chat provider');
        }
        return target.href;
    };
    const providerFetch = (url, options = {}) =>
        fetch(providerURL(url), { ...options, redirect: 'error' });

    const getCurrentId = () => {
        if (PLATFORM === 'claude') {
            return location.pathname.match(/\/chat\/([a-f0-9-]+)/i)?.[1] ||
                location.pathname.match(/\/(?:cowork|code)\/(cse_[a-zA-Z0-9]+)/)?.[1];
        }
        if (PLATFORM === 'openrouter') {
            try {
                return new URL(location.href).searchParams.get('room') ||
                    location.pathname.match(/\/chat\/([^/?#]+)/)?.[1];
            } catch {
                return location.pathname.match(/\/chat\/([^/?#]+)/)?.[1];
            }
        }
        const patterns = {
            chatgpt: /\/c\/([a-f0-9-]+)/,
            grok: /^\/(?:c|chat)\/([a-zA-Z0-9_-]+)(?:\/|$)/,
            gemini: /\/app\/([a-z0-9-]+)/i
        };
        return location.pathname.match(patterns[PLATFORM])?.[1];
    };

    const getClaudeOrgId = () => {
        const raw = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1] || '';
        try { return decodeURIComponent(raw); }
        catch { return raw; }
    };

    const safeJSON = (text) => {
        if (typeof text !== 'string') return null;
        const trimmed = text.trim();
        if (!trimmed || !/^[{\[]/.test(trimmed)) return null;
        try { return JSON.parse(trimmed); } catch { return null; }
    };

    // ChatGPT's /backend-api endpoints require the bearer token returned by
    // /api/auth/session. Cookies alone used to be enough, but now commonly
    // produce a 401 payload instead of conversation data. Keep the short-lived
    // token in memory only, share one refresh across concurrent requests, and
    // retry once when ChatGPT expires it.
    let chatGPTAccessToken = '';
    let chatGPTSessionRequest = null;

    const chatGPTDeviceId = (() => {
        try {
            const cookie = document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/)?.[1];
            if (cookie) return decodeURIComponent(cookie);
        } catch {}
        try { return crypto.randomUUID(); }
        catch {
            return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
        }
    })();

    const responseDetail = (text) => {
        const parsed = safeJSON(text);
        const detail = parsed?.detail ||
            parsed?.error?.message ||
            parsed?.error ||
            parsed?.message;
        if (typeof detail === 'string' && detail.trim()) return detail.trim();
        return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    };

    const responseError = (label, res, text) => {
        const status = [res?.status, res?.statusText].filter(Boolean).join(' ');
        const detail = responseDetail(text);
        return new Error(`${label} failed${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`);
    };

    const getChatGPTAccessToken = async (forceRefresh = false) => {
        if (forceRefresh) chatGPTAccessToken = '';
        if (chatGPTAccessToken) return chatGPTAccessToken;
        if (chatGPTSessionRequest) return chatGPTSessionRequest;

        chatGPTSessionRequest = (async () => {
            const res = await providerFetch(`${location.origin}/api/auth/session`, {
                credentials: 'include',
                cache: 'no-store',
                headers: { accept: 'application/json' }
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`ChatGPT session failed (${res.status}); sign in and reload the page`);

            const session = safeJSON(text);
            const token = session?.accessToken;
            if (!token) {
                throw new Error('ChatGPT session did not include an access token; sign in and reload the page');
            }
            chatGPTAccessToken = token;
            return token;
        })();

        try {
            return await chatGPTSessionRequest;
        } finally {
            chatGPTSessionRequest = null;
        }
    };

    const withChatGPTHeaders = (options = {}, token) => {
        const headers = new Headers(options.headers || {});
        headers.set('authorization', `Bearer ${token}`);
        if (!headers.has('accept')) headers.set('accept', 'application/json');
        if (!headers.has('oai-device-id')) headers.set('oai-device-id', chatGPTDeviceId);
        if (!headers.has('oai-language')) headers.set('oai-language', navigator.language || 'en-US');
        return {
            ...options,
            credentials: options.credentials || 'include',
            headers
        };
    };

    const chatGPTFetch = async (url, options = {}) => {
        url = providerURL(url);
        if (PLATFORM !== 'chatgpt') throw new Error('ChatGPT authentication is only available on ChatGPT');
        const token = await getChatGPTAccessToken();
        let res = await providerFetch(url, withChatGPTHeaders(options, token));
        if (res.status !== 401) return res;

        // Invalidate only the token this request actually used. If another
        // concurrent request already refreshed it, reuse that newer token.
        if (chatGPTAccessToken === token) chatGPTAccessToken = '';
        const refreshedToken = await getChatGPTAccessToken();
        res = await providerFetch(url, withChatGPTHeaders(options, refreshedToken));
        return res;
    };

    const readJSONResponse = async (label, res) => {
        const text = await res.text();
        if (!res.ok) throw responseError(label, res, text);
        const parsed = safeJSON(text);
        if (parsed == null) throw new Error(`${label} returned an invalid JSON response`);
        return parsed;
    };

    const isChatGPTApiUrl = (urlString) => {
        try {
            const url = new URL(urlString, location.origin);
            return /^(?:chatgpt\.com|chat\.openai\.com)$/i.test(url.hostname) &&
                /^\/(?:backend-api|public-api|ces)\//.test(url.pathname);
        } catch {
            return false;
        }
    };

    const DEFAULT_BUNDLE_RESPONSE_BYTES = 256 * 1024;
    const MAX_BUNDLE_CONCURRENCY = 3;

    const readResponseTextLimited = async (res, maxBytes) => {
        const declaredBytes = Number(res.headers?.get?.('content-length') || 0);
        if (declaredBytes > maxBytes) {
            try { await res.body?.cancel?.(); } catch {}
            return { text: '', bytes: declaredBytes, truncated: true };
        }

        const reader = res.body?.getReader?.();
        if (!reader) {
            const text = await res.text();
            const bytes = new TextEncoder().encode(text).byteLength;
            return bytes > maxBytes
                ? { text: '', bytes, truncated: true }
                : { text, bytes, truncated: false };
        }

        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value?.byteLength || 0;
            if (bytes > maxBytes) {
                try { await reader.cancel(); } catch {}
                return { text: '', bytes, truncated: true };
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { text, bytes, truncated: false };
    };

    const fetchBundleResource = async (name, url, options = {}) => {
        const started = Date.now();
        const timeoutMs = options.timeoutMs || 12000;
        const responseType = options.responseType || 'json';
        const maxResponseBytes = options.maxResponseBytes || DEFAULT_BUNDLE_RESPONSE_BYTES;
        const fetchOptions = { credentials: 'include', ...options };
        delete fetchOptions.timeoutMs;
        delete fetchOptions.responseType;
        delete fetchOptions.maxResponseBytes;

        const controller = new AbortController();
        fetchOptions.signal = controller.signal;
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = isChatGPTApiUrl(url)
                ? await chatGPTFetch(url, fetchOptions)
                : await providerFetch(url, fetchOptions);
            const body = await readResponseTextLimited(res, maxResponseBytes);
            if (body.truncated) {
                return {
                    name, url, ok: false, status: res.status,
                    ms: Date.now() - started,
                    response_bytes: body.bytes,
                    truncated: true,
                    error: `Skipped response larger than ${maxResponseBytes} bytes`
                };
            }
            const text = body.text;
            const parsed = responseType === 'text' ? null : safeJSON(text.replace(/^\)\]\}'?\n?/, ''));
            return {
                name, url, ok: res.ok, status: res.status,
                ms: Date.now() - started,
                response_bytes: body.bytes,
                data: parsed,
                text: parsed ? '' : text
            };
        } catch (error) {
            return {
                name, url, ok: false, status: 0,
                ms: Date.now() - started,
                error: error?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : (error?.message || String(error))
            };
        } finally {
            clearTimeout(timer);
        }
    };

    const fetchResourceMap = async (endpoints, concurrency = MAX_BUNDLE_CONCURRENCY) => {
        const entries = new Array(endpoints.length);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < endpoints.length) {
                const index = nextIndex++;
                const [name, url, options] = endpoints[index];
                entries[index] = await fetchBundleResource(name, url, options || {});
            }
        };
        const workerCount = Math.min(Math.max(1, concurrency), endpoints.length || 1);
        await Promise.all(Array.from({ length: workerCount }, worker));
        return Object.fromEntries(entries.map((entry) => [entry.name, entry]));
    };

    const isClaudeCoworkId = (id) => /^cse_[a-zA-Z0-9]+$/.test(String(id || ''));

    const claudeCodeHeaders = () => {
        const headers = {
            accept: 'application/json',
            'anthropic-beta': 'ccr-byoc-2025-07-29',
            'anthropic-client-feature': 'ccr',
            'anthropic-client-platform': 'web_claude_ai',
            'anthropic-client-version': '1.0.0',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        };
        const orgId = getClaudeOrgId();
        if (orgId) headers['x-organization-uuid'] = orgId;
        const deviceId = document.cookie.match(/(?:^|;\s*)anthropic-device-id=([^;]+)/)?.[1];
        const activityId = document.cookie.match(/(?:^|;\s*)activitySessionId=([^;]+)/)?.[1];
        if (deviceId) headers['anthropic-device-id'] = decodeURIComponent(deviceId);
        if (activityId) headers['x-activity-session-id'] = decodeURIComponent(activityId);
        return headers;
    };

    const fetchClaudeCodeJSON = async (label, path) => {
        const res = await providerFetch(`${location.origin}${path}`, {
            credentials: 'include',
            cache: 'no-store',
            headers: claudeCodeHeaders()
        });
        return readJSONResponse(label, res);
    };

    const fetchClaudeCoworkMetadata = async (id) => {
        try {
            const detail = await fetchClaudeCodeJSON(
                'Claude cowork session',
                `/v1/code/sessions/${encodeURIComponent(id)}`
            );
            return detail?.data && !Array.isArray(detail.data) ? detail.data : detail;
        } catch (detailError) {
            // The list endpoint is present in the supplied Claude HAR and is
            // a useful fallback when a deployment does not expose GET /{id}.
            const listing = await fetchClaudeCodeJSON('Claude cowork sessions', '/v1/code/sessions');
            const session = (listing?.data || listing?.sessions || [])
                .find((item) => item?.id === id || item?.uuid === id);
            if (session) return session;
            throw detailError;
        }
    };

    const eventPayload = (event) => {
        const value = event?.payload ?? event?.event?.payload ?? event;
        if (typeof value !== 'string') return value;
        return safeJSON(value) || value;
    };

    const eventIdentity = (event) => String(
        event?.event_id || event?.id || event?.uuid ||
        eventPayload(event)?.uuid || eventPayload(event)?.message?.id || ''
    );

    const eventSequence = (event) => {
        const value = event?.sequence_num ?? event?.sequence ?? eventPayload(event)?.sequence_num;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    };

    const eventTimestamp = (event) => Date.parse(
        event?.created_at || event?.timestamp || eventPayload(event)?.timestamp || ''
    ) || 0;

    const fetchClaudeCoworkEvents = async (id) => {
        const events = [];
        const identities = new Set();
        const cursors = new Set();
        let cursor = '';
        let pageCount = 0;

        while (true) {
            const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
            const page = await fetchClaudeCodeJSON(
                'Claude cowork events',
                `/v1/code/sessions/${encodeURIComponent(id)}/events${query}`
            );
            const pageEvents = Array.isArray(page?.data) ? page.data
                : Array.isArray(page?.events) ? page.events
                : Array.isArray(page) ? page : [];

            for (const event of pageEvents) {
                const identity = eventIdentity(event);
                if (identity && identities.has(identity)) continue;
                if (identity) identities.add(identity);
                events.push(event);
            }

            pageCount += 1;
            const nextCursor = String(page?.next_cursor ?? page?.nextCursor ?? '');
            if (!nextCursor || cursors.has(nextCursor)) break;
            // A repeated cursor would silently loop forever. A changing cursor
            // is followed to exhaustion so exports retain the complete log.
            cursors.add(nextCursor);
            cursor = nextCursor;
            if (pageCount >= 10000) {
                throw new Error('Claude cowork event history exceeded the pagination safety limit');
            }
        }

        // The endpoint is reverse-chronological. Sequence numbers are the
        // authoritative order; timestamps cover older payload variants.
        return events
            .map((event, index) => ({ event, index }))
            .sort((left, right) => {
                const leftSequence = eventSequence(left.event);
                const rightSequence = eventSequence(right.event);
                if (leftSequence != null && rightSequence != null && leftSequence !== rightSequence) {
                    return leftSequence - rightSequence;
                }
                const timeDifference = eventTimestamp(left.event) - eventTimestamp(right.event);
                return timeDifference || left.index - right.index;
            })
            .map((item) => item.event);
    };

    const fetchClaudeCowork = async (id) => {
        const [session, events] = await Promise.all([
            fetchClaudeCoworkMetadata(id).catch((error) => ({
                id,
                title: document.title,
                _metadata_error: error?.message || String(error)
            })),
            fetchClaudeCoworkEvents(id)
        ]);

        return {
            ...session,
            id,
            uuid: id,
            name: session?.title || session?.name || document.title,
            model: session?.config?.model || session?.model || '',
            created_at: session?.created_at || null,
            updated_at: session?.last_event_at || session?.updated_at || null,
            code_session: session,
            code_session_events: events,
            _conversation_kind: 'cowork',
            _source: 'cowork_api'
        };
    };

    const fetchClaude = async (id) => {
        if (isClaudeCoworkId(id)) return fetchClaudeCowork(id);
        const orgId = encodeURIComponent(getClaudeOrgId());
        const base = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${encodeURIComponent(id)}`;
        const res = await providerFetch(`${base}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual`, { credentials: 'include' });
        if (res.ok) return readJSONResponse('Claude conversation', res);
        const fallback = await providerFetch(`${base}?tree=false&rendering_mode=raw`, { credentials: 'include' });
        return readJSONResponse('Claude conversation', fallback);
    };

    const fetchClaudeRawAndMessages = async (id) => {
        if (isClaudeCoworkId(id)) {
            const raw = await fetchClaudeCowork(id);
            return { raw, messages: raw };
        }
        const orgId = encodeURIComponent(getClaudeOrgId());
        const base = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${encodeURIComponent(id)}`;
        const [raw, messages] = await Promise.all([
            providerFetch(`${base}?tree=false&rendering_mode=raw`, { credentials: 'include' }).then((r) => readJSONResponse('Claude conversation', r)),
            providerFetch(`${base}?tree=True&rendering_mode=messages&render_all_tools=true&consistency=eventual`, { credentials: 'include' }).then((r) => readJSONResponse('Claude conversation', r))
        ]);
        return { raw, messages };
    };

    const fetchChatGPT = async (id) => {
        if (!id) throw new Error('No ChatGPT conversation ID');
        const res = await chatGPTFetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(id)}`);
        return readJSONResponse('ChatGPT conversation', res);
    };

    const fetchGrok = async (id) => {
        if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('No valid Grok conversation ID');
        if (location.hostname !== 'grok.com') {
            throw new Error('Open this conversation on grok.com to export its saved history');
        }
        const base = `${location.origin}/rest/app-chat`;
        const conversationPath = `${base}/conversations/${encodeURIComponent(id)}`;
        // Grok now separates metadata, the response tree, and message bodies.
        // The September 2026 client uses rid to select a branch and otherwise
        // opens the last non-thread node. Follow parents to the root, without
        // the site's initial 30-response display limit.
        const rid = getCurrentId() === id ? new URL(location.href).searchParams.get('rid') || '' : '';
        const query = new URLSearchParams({ includeWorkspaces: 'true', includeTaskResult: 'true' });
        if (rid) query.set('rid', rid);
        const request = async (label, url, options = {}) => readJSONResponse(label, await providerFetch(url, {
            credentials: 'include', cache: 'no-store', ...options,
            headers: { accept: 'application/json', ...options.headers }
        }));
        const [metadataResult, nodesResult] = await Promise.allSettled([
            request('Grok conversation metadata', `${base}/conversations_v2/${encodeURIComponent(id)}?${query}`),
            request('Grok response tree', `${conversationPath}/response-node`)
        ]);
        if (nodesResult.status === 'rejected') throw nodesResult.reason;
        const tree = nodesResult.value;
        if (!Array.isArray(tree?.responseNodes)) throw new Error('Grok response tree did not include responseNodes');
        const nodes = new Map();
        for (const node of tree.responseNodes) {
            if (!node?.responseId || /^(?:optimistic_|streaming_in_progress_)/.test(node.responseId)) continue;
            nodes.set(node.responseId, node);
        }
        const mainNodes = [...nodes.values()].filter((node) => !node.threadParentId);
        const leaf = rid || mainNodes.at(-1)?.responseId || '';
        if (rid && !nodes.has(rid)) {
            throw new Error(`Grok selected response ${rid} was not found in this conversation; reload the conversation`);
        }
        const branch = [];
        const visited = new Set();
        let nextId = leaf;
        while (nextId && nodes.has(nextId)) {
            if (visited.has(nextId)) throw new Error('Grok response tree contains a parent cycle');
            visited.add(nextId);
            const node = nodes.get(nextId);
            branch.push(node);
            nextId = node.parentResponseId || '';
        }
        // An unlisted parent is normal: the captured first human turn points
        // to a synthetic root that is not returned in responseNodes.
        const responsesById = new Map();
        for (let offset = 0; offset < branch.length; offset += 30) {
            const responseIds = branch.slice(offset, offset + 30).map((node) => node.responseId);
            const page = await request('Grok conversation messages', `${conversationPath}/load-responses`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ responseIds })
            });
            if (!Array.isArray(page?.responses)) throw new Error('Grok message response did not include responses');
            for (const response of page.responses) {
                if (responseIds.includes(response?.responseId)) responsesById.set(response.responseId, response);
            }
            const missing = responseIds.filter((responseId) => !responsesById.has(responseId));
            if (missing.length) {
                throw new Error(`Grok did not return ${missing.length} requested message(s): ${missing.join(', ')}. Reload and retry the export`);
            }
        }
        const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : {};
        const conversation = metadata?.conversation || {};
        if (conversation.conversationId && conversation.conversationId !== id) {
            throw new Error('Grok returned metadata for a different conversation');
        }
        return {
            ...metadata,
            conversation,
            id,
            title: conversation.title || document.title,
            created_at: conversation.createTime || null,
            updated_at: conversation.modifyTime || null,
            responseNodes: tree.responseNodes,
            inflightResponses: tree.inflightResponses || [],
            responses: branch.reverse().map((node) => responsesById.get(node.responseId)),
            _source: 'grok_api',
            _selected_response_id: leaf,
            _branch_selection: rid ? 'url_rid' : 'latest_main_response',
            _root_parent_response_id: nextId,
            _metadata_error: metadataResult.status === 'rejected'
                ? metadataResult.reason?.message || String(metadataResult.reason) : null
        };
    };

    // ---- OpenRouter ------------------------------------------------------
    //
    // OpenRouter's chat UI persists rooms locally instead of exposing a
    // conversation REST endpoint. Its v3 store keeps room metadata, a
    // manifest, messages, model characters, and typed output/reasoning items
    // as separate records in an origin-scoped IndexedDB database. Read those
    // records without mutating the page's store, then hydrate the item refs so
    // the parser can export the final output and the reasoning that produced it.

    const OPENROUTER_DB_PREFIX = 'openrouter:playground';
    const OPENROUTER_KEY_PREFIX = 'v3';
    const OPENROUTER_COMMON_DATABASES = [
        `${OPENROUTER_DB_PREFIX}:guest:v3`,
        `${OPENROUTER_DB_PREFIX}:v3`
    ];

    const idbRequest = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });

    const recordValue = (record) => record && typeof record === 'object' &&
        Object.prototype.hasOwnProperty.call(record, 'value') ? record.value : record;

    const openIndexedDatabase = (factory, name, allowMissingProbe = false) =>
        new Promise((resolve, reject) => {
            let created = false;
            let settled = false;
            const finish = (value, error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve(value);
            };
            let request;
            try { request = factory.open(name); }
            catch (error) { finish(null, error); return; }

            request.onupgradeneeded = () => {
                created = true;
                // A fallback probe must never create an empty OpenRouter DB.
                if (allowMissingProbe) {
                    try { request.transaction.abort(); } catch {}
                }
            };
            request.onsuccess = () => {
                if (created && allowMissingProbe) {
                    try { request.result.close(); } catch {}
                    finish(null);
                    return;
                }
                finish(request.result);
            };
            request.onerror = () => {
                if (created && allowMissingProbe) finish(null);
                else finish(null, request.error || new Error(`Could not open IndexedDB database ${name}`));
            };
            request.onblocked = () => finish(null, new Error(`IndexedDB database ${name} is blocked`));
        });

    const listOpenRouterDatabases = async (factory) => {
        if (typeof factory?.databases === 'function') {
            const databases = await factory.databases();
            return [...new Set((databases || [])
                .map((database) => database?.name || '')
                .filter((name) => name.startsWith(OPENROUTER_DB_PREFIX)))];
        }
        // Firefox versions predating IDBFactory.databases() can still cover
        // guest and non-organization accounts. openIndexedDatabase aborts the
        // version-change transaction if either name does not already exist.
        return OPENROUTER_COMMON_DATABASES;
    };

    const readOpenRouterValues = async (database, storeName, keys) => {
        if (!keys.length) return [];
        const transaction = database.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        // Queue every request before yielding; otherwise IndexedDB may commit
        // the readonly transaction between individual awaits.
        const requests = keys.map((key) => idbRequest(store.get(key)).then(recordValue));
        return Promise.all(requests);
    };

    const asIdList = (value) => Array.isArray(value)
        ? value.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean)
        : value && typeof value === 'object' ? Object.keys(value)
        : [];

    const openRouterDateValue = (value) => {
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return value;
        const parsed = Date.parse(value || '');
        return Number.isFinite(parsed) ? parsed : null;
    };

    const openRouterCharacterLabel = (character) => character?.name ||
        character?.modelInfo?.short_name || character?.modelInfo?.name ||
        character?.model || '';

    const readOpenRouterRoom = async (factory, databaseName, id, allowMissingProbe) => {
        const database = await openIndexedDatabase(factory, databaseName, allowMissingProbe);
        if (!database) return null;
        try {
            if (!database.objectStoreNames?.contains(databaseName)) return null;
            const [roomRecord, manifestRecord] = await readOpenRouterValues(database, databaseName, [
                `${OPENROUTER_KEY_PREFIX}:room:${id}`,
                `${OPENROUTER_KEY_PREFIX}:manifest:${id}`
            ]);
            if (!roomRecord && !manifestRecord) return null;

            const room = roomRecord?.room || roomRecord || {};
            const manifest = manifestRecord?.manifest || manifestRecord || {};
            const messageIds = asIdList(manifest.messageIds || room.messageIds || room.messages);
            const characterIds = asIdList(manifest.characterIds || room.characterIds || room.characters);
            const manifestItemIds = asIdList(manifest.itemIds || room.itemIds || room.items);

            const [messageValues, characterValues, legacyContentValues, legacyReasoningValues] = await Promise.all([
                readOpenRouterValues(database, databaseName,
                    messageIds.map((messageId) => `${OPENROUTER_KEY_PREFIX}:message:${messageId}`)),
                readOpenRouterValues(database, databaseName,
                    characterIds.map((characterId) => `${OPENROUTER_KEY_PREFIX}:character:${characterId}`)),
                readOpenRouterValues(database, databaseName,
                    messageIds.map((messageId) => `${OPENROUTER_KEY_PREFIX}:content:${messageId}`)),
                readOpenRouterValues(database, databaseName,
                    messageIds.map((messageId) => `${OPENROUTER_KEY_PREFIX}:reasoning:${messageId}`))
            ]);
            const messagesById = Object.fromEntries(messageIds.map((messageId, index) =>
                [messageId, messageValues[index]]).filter(([, value]) => value));
            const charactersById = Object.fromEntries(characterIds.map((characterId, index) =>
                [characterId, characterValues[index]]).filter(([, value]) => value));

            const referencedItemIds = Object.values(messagesById).flatMap((message) =>
                asIdList(message?.items));
            const itemIds = [...new Set([...manifestItemIds, ...referencedItemIds])];
            const itemValues = await readOpenRouterValues(database, databaseName,
                itemIds.map((itemId) => `${OPENROUTER_KEY_PREFIX}:item:${itemId}`));
            const itemsById = Object.fromEntries(itemIds.map((itemId, index) =>
                [itemId, itemValues[index]]).filter(([, value]) => value));

            const hydratedMessages = messageIds.map((messageId, sourceIndex) => {
                const message = messagesById[messageId];
                if (!message) return null;
                const character = charactersById[message.characterId] || null;
                const model = message?.metadata?.variantSlug || character?.model || '';
                const itemRefs = Array.isArray(message.items) ? message.items : [];
                return {
                    ...message,
                    id: message.id || messageId,
                    role: message.role || message.type || '',
                    name: openRouterCharacterLabel(character),
                    model,
                    content: message.content || legacyContentValues[sourceIndex] || undefined,
                    reasoning: message.reasoning || legacyReasoningValues[sourceIndex] || undefined,
                    character: character || undefined,
                    items: itemRefs.map((ref) => {
                        const itemId = typeof ref === 'string' ? ref : ref?.id;
                        const stored = itemsById[itemId];
                        if (!stored) return typeof ref === 'string' ? { id: ref } : ref;
                        return {
                            ...(typeof ref === 'object' ? ref : { id: itemId }),
                            ...stored,
                            id: stored.id || itemId
                        };
                    }),
                    _source_index: sourceIndex
                };
            }).filter(Boolean);

            hydratedMessages.sort((left, right) => {
                const leftDate = openRouterDateValue(left.createdAt || left.created_at);
                const rightDate = openRouterDateValue(right.createdAt || right.created_at);
                if (leftDate != null && rightDate != null && leftDate !== rightDate) return leftDate - rightDate;
                if (leftDate != null && rightDate != null && left.type !== right.type) {
                    if (left.type === 'user' && right.type === 'assistant') return -1;
                    if (left.type === 'assistant' && right.type === 'user') return 1;
                }
                if (leftDate != null && rightDate != null) {
                    const byId = String(left.id || '').localeCompare(String(right.id || ''));
                    if (byId) return byId;
                }
                return left._source_index - right._source_index;
            });

            const models = [...new Set(hydratedMessages.map((message) => message.model).filter(Boolean))];
            return {
                id: room.id || id,
                uuid: room.id || id,
                title: room.title || room.name || document.title,
                name: room.title || room.name || document.title,
                model: models.length === 1 ? models[0] : '',
                created_at: room.createdAt || room.created_at || null,
                updated_at: room.updatedAt || room.updated_at || null,
                chat_messages: hydratedMessages,
                characters: charactersById,
                items: itemsById,
                _conversation_kind: 'openrouter_chat',
                _source: 'indexeddb',
                _schema: 'orpg.3.0'
            };
        } finally {
            try { database.close(); } catch {}
        }
    };

    const fetchOpenRouter = async (id) => {
        if (!id) throw new Error('No OpenRouter room ID in the URL');
        const factory = typeof indexedDB !== 'undefined' ? indexedDB : window.indexedDB;
        if (!factory) throw new Error('OpenRouter chat storage is unavailable in this browser');

        let lastError = null;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const hasEnumeration = typeof factory.databases === 'function';
                const discoveredNames = await listOpenRouterDatabases(factory);
                const databaseNames = [...new Set([...discoveredNames, ...OPENROUTER_COMMON_DATABASES])];
                for (const databaseName of databaseNames) {
                    const room = await readOpenRouterRoom(
                        factory,
                        databaseName,
                        id,
                        !hasEnumeration || !discoveredNames.includes(databaseName)
                    );
                    if (room?.chat_messages?.length) return room;
                }
            } catch (error) {
                lastError = error;
            }
            if (attempt < 3) await delay(250);
        }
        if (lastError) throw lastError;
        throw new Error('OpenRouter room was not found in local chat storage; wait for it to finish loading and try again');
    };

    // ---- Gemini (batchexecute) -------------------------------------------
    //
    // Gemini has no REST conversation endpoint; the SPA talks to its backend
    // only through /_/BardChatUi/data/batchexecute RPCs. We replay the same
    // conversation-load RPC (hNvQHb) the page itself fires on load, signed
    // with the page's own tokens, so this is a same-origin, credentialed
    // request identical to what Gemini already does.

    // WIZ_global_data carries the request-signing tokens. In Firefox we can
    // reach the page's copy via wrappedJSObject; we also scrape inline
    // bootstrap scripts and stash tokens seen on live batchexecute fetches as
    // a backstop — the SPA reuses one token set across many requests, so
    // sniffing one is usually enough.
    const WIZ_KEYS = {
        at: ['SNlM0e'],
        sid: ['FdrFJe'],
        bl: ['cfb2h'],
        hl: ['cd9b16', 'hl']
    };

    const sniffedTokens = { at: '', sid: '', bl: '', hl: '' };

    const fromObj = (wiz) => {
        if (!wiz) return null;
        const out = {};
        for (const [field, candidates] of Object.entries(WIZ_KEYS)) {
            for (const key of candidates) {
                const value = wiz[key];
                if (typeof value === 'string' && value) { out[field] = value; break; }
            }
        }
        if (!out.hl) out.hl = 'en';
        return out.at ? out : null;
    };

    const scrapeInlineScripts = () => {
        const out = { at: '', sid: '', bl: '', hl: '' };
        // Regex-scrape individual tokens. This survives inline scripts that
        // span multiple statements, contain comments, or include values the
        // JSON.parse path can't handle (function calls, /Date(...)/, etc).
        const tokenPattern = (keys) =>
            new RegExp(`"(?:${keys.join('|')})"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`);
        const patterns = Object.fromEntries(
            Object.entries(WIZ_KEYS).map(([field, keys]) => [field, tokenPattern(keys)])
        );

        for (const script of document.querySelectorAll('script')) {
            const text = script.textContent || '';
            if (!text || text.indexOf('WIZ_global_data') === -1 && !out.at) continue;
            for (const [field, regex] of Object.entries(patterns)) {
                if (out[field]) continue;
                const m = text.match(regex);
                if (m) out[field] = m[1];
            }
            if (out.at && out.sid && out.bl) break;
        }
        return out.at ? out : null;
    };

    const readWizData = () => {
        try {
            const direct = fromObj(window.wrappedJSObject?.WIZ_global_data) || fromObj(window.WIZ_global_data);
            if (direct?.at) return direct;
        } catch {}

        const scraped = scrapeInlineScripts();
        if (scraped?.at) return scraped;

        if (sniffedTokens.at) return { ...sniffedTokens, hl: sniffedTokens.hl || 'en' };
        return null;
    };

    // Called by page-bridge.js whenever a hooked fetch hits a batchexecute
    // endpoint — we lift the `at` and `f.sid` out of the form body so we
    // always have a working set even when WIZ_global_data isn't scrapable.
    const noteGeminiTokens = (urlString, bodyString) => {
        try {
            const target = new URL(urlString, location.origin);
            if (PLATFORM !== 'gemini' || target.origin !== location.origin ||
                target.pathname !== '/_/BardChatUi/data/batchexecute') return;
            if (typeof urlString === 'string' && /\/_\/BardChatUi\/data\/batchexecute/.test(urlString)) {
                const url = new URL(urlString, location.origin);
                const bl = url.searchParams.get('bl');
                const hl = url.searchParams.get('hl');
                // f.sid lives in the URL on Gemini's batchexecute calls, not
                // the form body.
                const sidQuery = url.searchParams.get('f.sid') || url.searchParams.get('fsid');
                if (bl) sniffedTokens.bl = bl;
                if (hl) sniffedTokens.hl = hl;
                if (sidQuery) sniffedTokens.sid = sidQuery;
            }
            if (typeof bodyString === 'string' && bodyString.indexOf('at=') !== -1) {
                const params = new URLSearchParams(bodyString);
                const at = params.get('at');
                if (at) sniffedTokens.at = at;
                const sidBody = params.get('f.sid') || params.get('fsid');
                if (sidBody) sniffedTokens.sid = sidBody;
            }
        } catch {}
    };

    let geminiReqSeq = 1000;

    const fetchGemini = async (id) => {
        if (!id) throw new Error('No Gemini conversation id in URL');
        const wiz = readWizData();
        if (!wiz?.at) throw new Error('Could not read Gemini session tokens (WIZ_global_data)');

        const convId = id.startsWith('c_') ? id : `c_${id}`;
        const urlId = id.replace(/^c_/, '');
        const params = new URLSearchParams({
            rpcids: 'hNvQHb',
            'source-path': `/app/${urlId}`,
            bl: wiz.bl,
            'f.sid': wiz.sid,
            hl: wiz.hl,
            _reqid: String((geminiReqSeq += 100000)),
            rt: 'c'
        });
        const inner = JSON.stringify([convId, 10, null, 1, [1], [4], null, 1]);
        const freq = JSON.stringify([[['hNvQHb', inner, null, 'generic']]]);
        const body = new URLSearchParams({ 'f.req': freq, at: wiz.at });

        const res = await providerFetch(`${location.origin}/_/BardChatUi/data/batchexecute?${params.toString()}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: body.toString()
        });
        const text = await res.text();
        const payloads = decodeBatchExecute(text);
        const data = batchPayload(payloads, 'hNvQHb');
        if (!data) throw new Error(`Gemini RPC returned no hNvQHb payload (status ${res.status})`);
        return { conversation_id: convId, status: res.status, data, payloads, _source: 'api' };
    };

    // Turn the conversation tree into [{role, content}]. Current hNvQHb
    // responses contain reverse-chronological turn records. A record's prompt
    // is at turn[2][0][0], while turn[3][0] holds response candidates and
    // turn[3][3] names the candidate the user is actually viewing.
    //
    // Do not confuse that candidate list with the conversation list: both use
    // arrays whose second member contains text. That confusion reduced every
    // current Gemini conversation to its newest response and labelled it as a
    // user message. We locate the record list by its prompt/response shape and
    // retain the older heuristic only as a fallback for legacy payloads.
    const looksLikeText = (s) => typeof s === 'string' && s.trim().length > 1 && (/\s/.test(s) || s.length > 20);
    const cleanGeminiText = (value) => typeof value === 'string' ? value.trim() : '';

    const collectGeminiText = (node, skip, depth = 0) => {
        if (depth > 40 || node == null || skip.has(node)) return [];
        if (typeof node === 'string') return looksLikeText(node) ? [node] : [];
        if (Array.isArray(node)) {
            let out = [];
            for (const v of node) out = out.concat(collectGeminiText(v, skip, depth + 1));
            return out;
        }
        return [];
    };

    const isGeminiConversationTurn = (node) => Array.isArray(node) &&
        typeof node?.[2]?.[0]?.[0] === 'string' &&
        (Array.isArray(node?.[0]) || Array.isArray(node?.[3]));

    const findGeminiConversationTurns = (data) => {
        let best = [];
        const visit = (node, depth = 0) => {
            if (!Array.isArray(node) || depth > 16) return;
            const records = node.filter(isGeminiConversationTurn);
            if (records.length > best.length) best = records;
            for (const child of node) visit(child, depth + 1);
        };
        visit(data);
        return best;
    };

    const geminiTurnTimestamp = (turn) => {
        const stamp = turn?.[4];
        if (Array.isArray(stamp) && Number.isFinite(Number(stamp[0]))) {
            return Number(stamp[0]) + (Number(stamp[1]) || 0) / 1e9;
        }
        if (stamp == null) return null;
        return Number.isFinite(Number(stamp)) ? Number(stamp) : null;
    };

    const chronologicalGeminiTurns = (turns) => {
        const timed = turns.map((turn, index) => ({ turn, index, time: geminiTurnTimestamp(turn) }));
        if (timed.every(({ time }) => time != null)) {
            return timed.sort((left, right) => left.time - right.time || left.index - right.index)
                .map(({ turn }) => turn);
        }
        // hNvQHb record lists are newest-first even when a record has no
        // timestamp. Preserve the historical single-record case unchanged.
        return turns.length > 1 ? [...turns].reverse() : turns;
    };

    const geminiCandidateText = (candidate) => {
        const content = candidate?.[1];
        if (typeof content === 'string') return cleanGeminiText(content);
        if (!Array.isArray(content)) return '';
        const direct = content.map(cleanGeminiText).filter(Boolean);
        if (direct.length) return direct.join('\n\n');
        const nested = collectGeminiText(content, new Set()).sort((a, b) => b.length - a.length);
        return cleanGeminiText(nested[0]);
    };

    const selectedGeminiCandidate = (turn) => {
        const response = turn?.[3];
        const candidates = Array.isArray(response?.[0]) ? response[0] : [];
        const selectedId = response?.[3];
        const selected = candidates.find((candidate) => candidate?.[0] === selectedId);
        if (geminiCandidateText(selected)) return selected;
        return candidates.find((candidate) => geminiCandidateText(candidate)) || null;
    };

    const geminiCandidateThinking = (candidate) =>
        cleanGeminiText(candidate?.[37]?.[0]?.[0]);

    const GEMINI_TRACKING_PARAM = /^(?:utm_.+|gclid|dclid|fbclid|msclkid|twclid|yclid|gbraid|wbraid|srsltid|mc_cid|mc_eid|_ga|_gl|igshid|si|ved|usg|sa|source|ref|ref_.+)$/i;

    const canonicalGeminiSourceURL = (value) => {
        try {
            const url = new URL(String(value || ''));
            if (!/^https?:$/.test(url.protocol)) return '';
            url.hash = '';
            for (const key of [...url.searchParams.keys()]) {
                if (GEMINI_TRACKING_PARAM.test(key)) url.searchParams.delete(key);
            }
            url.searchParams.sort();
            return url.toString();
        } catch {
            return '';
        }
    };

    const geminiSearchQueries = (turn) => {
        const rows = Array.isArray(turn?.[3]?.[1]) ? turn[3][1] : [];
        const seen = new Set();
        const queries = [];
        for (const row of rows) {
            const query = cleanGeminiText(row?.[0]).replace(/\s+/g, ' ');
            const key = query.toLowerCase();
            if (!query || seen.has(key)) continue;
            seen.add(key);
            queries.push(query);
        }
        return queries;
    };

    const annotateGeminiGrounding = (answer, candidate, registerSource) => {
        const rows = Array.isArray(candidate?.[2]?.[1]) ? candidate[2][1] : [];
        const insertions = new Map();
        const messageSources = [];
        const seenMessageSources = new Set();

        for (const row of rows) {
            const sourceNumbers = [];
            for (const rawSource of Array.isArray(row?.[2]) ? row[2] : []) {
                const url = canonicalGeminiSourceURL(rawSource?.[0]);
                if (!url) continue;
                const sourceNumber = registerSource({
                    title: cleanGeminiText(rawSource?.[1]),
                    url
                });
                if (!sourceNumber) continue;
                sourceNumbers.push(sourceNumber);
                if (!seenMessageSources.has(sourceNumber)) {
                    seenMessageSources.add(sourceNumber);
                    messageSources.push(sourceNumber);
                }
            }
            if (!sourceNumbers.length) continue;

            const citedText = typeof row?.[0]?.[0] === 'string' ? row[0][0] : '';
            const seenSpans = new Set();
            for (const span of Array.isArray(row?.[0]?.[3]) ? row[0][3] : []) {
                const start = Number(span?.[0]);
                const end = Number(span?.[1]);
                const spanKey = `${start}:${end}`;
                if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start ||
                    end > answer.length || seenSpans.has(spanKey)) continue;
                if (citedText && answer.slice(start, end) !== citedText) continue;
                seenSpans.add(spanKey);
                const numbers = insertions.get(end) || new Set();
                sourceNumbers.forEach((number) => numbers.add(number));
                insertions.set(end, numbers);
            }
        }

        let content = answer;
        const orderedInsertions = [...insertions.entries()].sort((left, right) => right[0] - left[0]);
        for (const [offset, numbers] of orderedInsertions) {
            const marker = [...numbers].sort((left, right) => left - right)
                .map((number) => `[${number}]`).join('');
            content = `${content.slice(0, offset)}${marker}${content.slice(offset)}`;
        }
        return { content, messageSources };
    };

    const getLegacyGeminiTurns = (raw) => {
        const data = raw?.data || raw;
        const hasUser = (list) => Array.isArray(list) && list.some((t) => Array.isArray(t) && typeof t?.[1]?.[0] === 'string');
        for (const candidate of [data?.[0]?.[0]?.[3]?.[0], data?.[0]?.[0]?.[3], data?.[0]?.[0]]) {
            if (hasUser(candidate)) return candidate;
        }
        return [];
    };

    const extractGeminiConversation = (raw) => {
        const data = raw?.data || raw;
        const conversationTurns = findGeminiConversationTurns(data);
        const messages = [];
        const sources = [];
        const sourceIndexes = new Map();
        const searchQueries = [];
        const seenQueries = new Set();

        const registerSource = (source) => {
            const key = source.url;
            if (sourceIndexes.has(key)) {
                const index = sourceIndexes.get(key);
                if (!sources[index].title && source.title) sources[index].title = source.title;
                return index + 1;
            }
            sourceIndexes.set(key, sources.length);
            sources.push(source);
            return sources.length;
        };

        if (conversationTurns.length) {
            for (const turn of chronologicalGeminiTurns(conversationTurns)) {
                const userText = cleanGeminiText(turn?.[2]?.[0]?.[0]);
                if (userText) messages.push({ role: 'user', content: userText });
                const candidate = selectedGeminiCandidate(turn);
                const answer = geminiCandidateText(candidate);
                const grounded = annotateGeminiGrounding(answer, candidate, registerSource);
                const thinking = geminiCandidateThinking(candidate);
                const turnQueries = geminiSearchQueries(turn);
                for (const query of turnQueries) {
                    const key = query.toLowerCase();
                    if (!seenQueries.has(key)) {
                        seenQueries.add(key);
                        searchQueries.push(query);
                    }
                }
                if (grounded.content || thinking) {
                    const assistant = { role: 'assistant', content: grounded.content };
                    if (thinking) assistant.thinking = thinking;
                    if (turnQueries.length) assistant.search_queries = turnQueries;
                    if (grounded.messageSources.length) {
                        assistant.sources = grounded.messageSources.map((number) => sources[number - 1]);
                    }
                    messages.push(assistant);
                }
            }
            return { messages, sources, search_queries: searchQueries };
        }

        const turns = getLegacyGeminiTurns(raw);
        for (const turn of turns) {
            if (!Array.isArray(turn)) continue;
            const userText = turn?.[1]?.[0];
            if (looksLikeText(userText)) messages.push({ role: 'user', content: userText });

            const skip = new Set();
            if (turn[1] != null) skip.add(turn[1]);   // user query subtree
            if (turn[37] != null) skip.add(turn[37]); // chain-of-thought subtree
            const blocks = collectGeminiText(turn, skip).sort((a, b) => b.length - a.length);
            if (blocks.length) messages.push({ role: 'assistant', content: blocks[0] });
        }
        return { messages, sources, search_queries: searchQueries };
    };

    const extractGeminiTurns = (raw) => extractGeminiConversation(raw).messages;

    const summarizeResources = (resources) => {
        const entries = Object.values(resources || {});
        return {
            requested: entries.length,
            ok: entries.filter((entry) => entry.ok).length,
            failed: entries.filter((entry) => !entry.ok).length
        };
    };

    const fetchChatGPTSessionBundle = async (id, discovery) => {
        const gizmoId = discovery.gizmo_id || discovery.conversation_template_id || '';
        const endpoints = [];

        if (/^g-/.test(gizmoId)) {
            endpoints.push(['gizmo', `${location.origin}/backend-api/gizmos/${encodeURIComponent(gizmoId)}`, { maxResponseBytes: 256 * 1024 }]);
        }

        const resources = await fetchResourceMap(endpoints);
        return {
            version: 2,
            platform: 'chatgpt',
            mode: 'lean',
            captured_at: new Date().toISOString(),
            primary_resource: 'conversation',
            discovery,
            limits: {
                concurrency: MAX_BUNDLE_CONCURRENCY,
                default_response_bytes: DEFAULT_BUNDLE_RESPONSE_BYTES,
                max_file_resources: 0,
                note: 'Attachment IDs are recorded in discovery but never probed automatically'
            },
            summary: summarizeResources(resources),
            resources
        };
    };

    const fetchClaudeSessionBundle = async (id, discovery) => {
        const orgId = encodeURIComponent(discovery.org_id || '');
        const projectId = encodeURIComponent(discovery.project_uuid || '');
        const cowork = isClaudeCoworkId(id);
        const codeHeaders = { headers: claudeCodeHeaders() };
        const endpoints = [
            ['app_start', `https://claude.ai/edge-api/bootstrap/${orgId}/app_start`, { timeoutMs: 18000 }],
            ['organization', `https://claude.ai/api/organizations/${orgId}`],
            ['organizations_discoverable', `https://claude.ai/api/organizations/discoverable`],
            ['domain_density', `https://claude.ai/api/account/domain_density`],
            ['gift_purchase_eligibility', `https://claude.ai/api/billing/${orgId}/gift/purchase_eligibility`],
            ['pending_domain_claim', `https://claude.ai/api/organizations/${orgId}/pending_domain_claim`],
            ['sync_settings', `https://claude.ai/api/organizations/${orgId}/sync/settings`],
            ['projects', `https://claude.ai/api/organizations/${orgId}/projects`, { timeoutMs: 18000 }],
            ['experiences', `https://claude.ai/api/organizations/${orgId}/experiences/claude_web`],
            ['notification_preferences', `https://claude.ai/api/organizations/${orgId}/notification/preferences`],
            ['list_styles', `https://claude.ai/api/organizations/${orgId}/list_styles`],
            ['cowork_settings', `https://claude.ai/api/organizations/${orgId}/cowork_settings`],
            ['memory_settings', `https://claude.ai/api/organizations/${orgId}/memory/settings`],
            ['memory', `https://claude.ai/api/organizations/${orgId}/memory`],
            ['claude_code_user_settings', `https://claude.ai/api/claude_code/organizations/${orgId}/user_settings`],
            ['marketplaces', `https://claude.ai/api/organizations/${orgId}/marketplaces/list-default-marketplaces`],
            ['skills', `https://claude.ai/api/organizations/${orgId}/skills/list-skills`],
            ['sessions', `https://claude.ai/v1/code/sessions`, { ...codeHeaders, timeoutMs: 18000 }],
            ['environments', `https://claude.ai/v1/environment_providers/private/organizations/${orgId}/environments`],
            ['i18n_en_us', `https://claude.ai/i18n/en-US.json`, { timeoutMs: 18000 }],
            ['i18n_statsig_en_us', `https://claude.ai/i18n/statsig/en-US.json`, { timeoutMs: 18000 }]
        ];

        if (cowork) {
            endpoints.push([
                'code_session',
                `https://claude.ai/v1/code/sessions/${encodeURIComponent(id)}`,
                codeHeaders
            ]);
        } else {
            endpoints.push([
                'artifact_versions',
                `https://claude.ai/api/organizations/${orgId}/artifacts/${encodeURIComponent(id)}/versions`
            ]);
        }

        if (projectId) {
            endpoints.push(
                ['project', `https://claude.ai/api/organizations/${orgId}/projects/${projectId}`],
                ['project_kb_stats', `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/kb/stats`],
                ['project_syncs', `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/syncs`],
                ['project_files', `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/files`, { timeoutMs: 18000 }],
                ['project_docs', `https://claude.ai/api/organizations/${orgId}/projects/${projectId}/docs`, { timeoutMs: 18000 }]
            );
        }

        if (orgId) {
            endpoints.push(['mcp_bootstrap', `https://claude.ai/api/organizations/${orgId}/mcp/v2/bootstrap`, { responseType: 'text', timeoutMs: 3500 }]);
        }

        const resources = await fetchResourceMap(endpoints);
        return {
            version: 1,
            platform: 'claude',
            captured_at: new Date().toISOString(),
            primary_resource: 'raw',
            discovery,
            summary: summarizeResources(resources),
            resources
        };
    };

    CT.getCurrentId = getCurrentId;
    CT.getClaudeOrgId = getClaudeOrgId;
    CT.fetchClaude = fetchClaude;
    CT.fetchClaudeCowork = fetchClaudeCowork;
    CT.fetchClaudeCoworkEvents = fetchClaudeCoworkEvents;
    CT.fetchClaudeRawAndMessages = fetchClaudeRawAndMessages;
    CT.fetchChatGPT = fetchChatGPT;
    CT.chatGPTFetch = chatGPTFetch;
    CT.getChatGPTAccessToken = getChatGPTAccessToken;
    CT.fetchGrok = fetchGrok;
    CT.fetchOpenRouter = fetchOpenRouter;
    CT.fetchGemini = fetchGemini;
    CT.extractGeminiConversation = extractGeminiConversation;
    CT.extractGeminiTurns = extractGeminiTurns;
    CT.fetchChatGPTSessionBundle = fetchChatGPTSessionBundle;
    CT.fetchClaudeSessionBundle = fetchClaudeSessionBundle;
    CT.noteGeminiTokens = noteGeminiTokens;
    CT.readWizData = readWizData;
})();
