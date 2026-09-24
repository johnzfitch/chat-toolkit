// Content-script orchestrator. Pulls together platform detection,
// DOM extraction, API fetchers, the page bridge, and the parser worker
// to implement each user-visible action.
//
// All heavy data work (Normalize / CleanJSON / renderers) is dispatched
// to lib/parser-worker.js so the chat site's main thread stays responsive
// on long conversations with lots of latex, thinking blocks, and tool I/O.

(function () {
    'use strict';

    const CT = window.__chatToolkit;
    if (!CT) return;

    const {
        PLATFORM, COLORS, isGoogle, safeStringify, unwrap,
        getCurrentId, getClaudeOrgId,
        fetchClaude, fetchClaudeRawAndMessages, fetchChatGPT, chatGPTFetch, fetchGrok, fetchOpenRouter,
        fetchGemini, extractGeminiConversation,
        fetchChatGPTSessionBundle, fetchClaudeSessionBundle,
        captureDOMSnapshot, DOM, DOM_PROBES,
        setPageCapture, withPageCapture, getPageState, waitForPageState,
        emitPageReport, parserCall,
        notify, copyToClipboard, showReport, createPanel
    } = CT;

    // ---- platform-aware raw data fetch -----------------------------------

    // Pull the assistant text out of the rendered DOM, used to backfill turns
    // where the API tree didn't yield strong model content.
    const domAssistantContents = () => {
        const dom = PLATFORM === 'gemini' ? DOM.gemini() : DOM.aistudio();
        return (dom.messages || []).filter((m) => m.role === 'assistant').map((m) => m.content);
    };

    // If an API-extracted assistant turn came back thin (e.g. the model's reply
    // was a card/artifact the tree-walk under-represents), prefer the matching
    // rendered DOM bubble when it carries meaningfully more text. Positional
    // matching is safe only when the DOM contains the same number of assistant
    // turns; Gemini may virtualize the page down to its newest response.
    const backfillAssistant = (messages) => {
        const domAssistant = domAssistantContents();
        const apiAssistantCount = messages.filter((message) => message.role === 'assistant').length;
        if (domAssistant.length !== apiAssistantCount) return messages;
        let i = 0;
        return messages.map((m) => {
            if (m.role !== 'assistant') return m;
            const domText = domAssistant[i++];
            if (!m.sources?.length && domText && domText.length > (m.content?.length || 0) * 1.5) {
                return { ...m, content: domText };
            }
            return m;
        });
    };

    // Decode any captured batchexecute response into Gemini turns.
    const messagesFromCapture = () => {
        const pageState = getPageState();
        const entries = pageState?.captures?._entries;
        if (!Array.isArray(entries)) return null;
        for (const cap of [...entries].reverse()) {
            if (!cap?.batch || (Date.now() - (cap.timestamp || 0)) > 120000) continue;
            for (const payload of cap.batch) {
                const extracted = extractGeminiConversation({ data: unwrap(payload?.data) });
                if (extracted.messages?.length) {
                    return { name: document.title, ...extracted, _source: 'xhr', _raw: payload.data };
                }
            }
        }
        return null;
    };

    // Gemini/AI Studio extraction, most-reliable source first:
    //   1. Active batchexecute replay (Gemini only) — fresh, full conversation.
    //   2. Passively captured batchexecute traffic, if the hooks saw any.
    //   3. The rendered DOM.
    const extractGoogle = async () => {
        if (PLATFORM === 'gemini') {
            try {
                const id = getCurrentId();
                if (id) {
                    const fetched = await fetchGemini(id);
                    const extracted = extractGeminiConversation(fetched);
                    if (extracted.messages.length) {
                        return {
                            name: document.title,
                            ...extracted,
                            messages: backfillAssistant(extracted.messages),
                            _source: 'api',
                            _raw: fetched.data
                        };
                    }
                }
            } catch (e) {
                console.warn('[Chat Toolkit] Gemini API fetch failed, falling back', e);
            }
        }

        // Make sure hooks are live, then check for captured traffic.
        await setPageCapture('start');
        try {
            const captured = messagesFromCapture();
            if (captured) return captured;
        } catch {}

        return PLATFORM === 'gemini' ? DOM.gemini() : DOM.aistudio();
    };

    const getActiveConversation = async () => {
        let raw;
        let clean;

        if (isGoogle) {
            raw = await extractGoogle();
            if (!raw?.messages?.length) throw new Error('No messages found');
            clean = await parserCall('clean', { platform: 'google', raw });
            return { raw, clean };
        }

        const id = getCurrentId();
        if (!id) {
            if (PLATFORM === 'chatgpt' || PLATFORM === 'openrouter') {
                const domData = DOM[PLATFORM]();
                if (domData.messages.length) {
                    const domClean = PLATFORM === 'openrouter'
                        ? await parserCall('clean', { platform: 'openrouter', raw: domData })
                        : await parserCall('domConversation', { raw: domData });
                    return { raw: domData, clean: domClean };
                }
            }
            throw new Error('No chat ID');
        }

        if (PLATFORM === 'claude') {
            let apiError = null;
            try {
                raw = await fetchClaude(id);
                clean = await parserCall('clean', { platform: 'claude', raw });
                const apiUsable = clean.messages.some((message) =>
                    String(message.content || '').trim() || message.blocks?.length
                );
                if (apiUsable) return { raw, clean };
            } catch (error) {
                apiError = error;
                console.warn('[Chat Toolkit] Claude API fetch failed, falling back to DOM', error);
            }

            const domData = DOM.claude();
            if (domData.messages.length) {
                const enriched = {
                    ...domData,
                    _api_error: apiError?.message || null
                };
                const domClean = await parserCall('clean', { platform: 'claude', raw: enriched });
                return { raw: enriched, clean: domClean };
            }
            if (apiError) throw apiError;
            throw new Error('No Claude messages found');
        }

        if (PLATFORM === 'chatgpt') {
            let apiData = null;
            let apiClean = null;
            let apiError = null;
            try {
                apiData = await fetchChatGPT(id);
                apiClean = await parserCall('clean', { platform: 'chatgpt', raw: apiData });
                const apiUsable = apiClean.messages.length ||
                    await parserCall('hasUsableMessages', { raw: apiData });
                if (apiUsable) return { raw: apiData, clean: apiClean };
            } catch (error) {
                apiError = error;
                console.warn('[Chat Toolkit] ChatGPT API fetch failed, falling back to DOM', error);
            }

            const domData = DOM.chatgpt();
            if (domData.messages.length) {
                const enriched = {
                    ...domData,
                    _api_detail: apiData?.detail || null,
                    _api_error: apiError?.message || null
                };
                const domClean = await parserCall('domConversation', { raw: enriched });
                return { raw: enriched, clean: domClean };
            }
            if (apiError) throw apiError;
            return { raw: apiData, clean: apiClean };
        }

        if (PLATFORM === 'openrouter') {
            let storageError = null;
            try {
                raw = await fetchOpenRouter(id);
                clean = await parserCall('clean', { platform: 'openrouter', raw });
                if (clean.messages.some((message) =>
                    message.content || message.reasoning || message.blocks?.length
                )) return { raw, clean };
            } catch (error) {
                storageError = error;
                console.warn('[Chat Toolkit] OpenRouter storage read failed, falling back to DOM', error);
            }

            const domData = DOM.openrouter();
            if (domData.messages.length) {
                const enriched = {
                    ...domData,
                    _storage_error: storageError?.message || null
                };
                const domClean = await parserCall('clean', { platform: 'openrouter', raw: enriched });
                return { raw: enriched, clean: domClean };
            }
            if (storageError) throw storageError;
            throw new Error('No OpenRouter messages found');
        }

        if (PLATFORM === 'grok') {
            raw = await fetchGrok(id);
            clean = await parserCall('clean', { platform: 'grok', raw });
            if (!clean.messages.length) throw new Error('No saved Grok messages found; wait for the response to finish and try again');
            return { raw, clean };
        }

        throw new Error(`Unsupported platform: ${PLATFORM}`);
    };

    // ---- download bridge -------------------------------------------------

    const download = async (content, filename, type = 'application/json') => {
        const response = await browser.runtime.sendMessage({
            action: 'download', content, filename, type
        });
        if (!response?.success) throw new Error(response?.error || 'Download failed');
        return response;
    };

    const networkCapture = async (action, reason = '') => {
        try {
            return await browser.runtime.sendMessage({
                action: `network-capture-${action}`,
                platform: PLATFORM,
                url: location.href,
                reason
            });
        } catch (error) {
            console.warn('[Chat Toolkit] background network capture failed', error);
            return { success: false, error: error?.message || String(error) };
        }
    };

    const safeParseJSON = (text) => {
        try { return JSON.parse(text); } catch { return null; }
    };

    const readResponseTextLimited = async (res, maxBytes = 256 * 1024) => {
        const declared = Number(res.headers?.get?.('content-length') || 0);
        if (declared > maxBytes) {
            try { await res.body?.cancel?.(); } catch {}
            return { text: '', bytes: declared, truncated: true };
        }
        const reader = res.body?.getReader?.();
        if (!reader) {
            const text = await res.text();
            const bytes = new TextEncoder().encode(text).byteLength;
            return bytes > maxBytes ? { text: '', bytes, truncated: true } : { text, bytes, truncated: false };
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

    const passiveStoreStatus = async (create = false) => {
        if (PLATFORM !== 'chatgpt') return { success: false, passive: true };
        try {
            return await browser.runtime.sendMessage({
                action: 'passive-store-status',
                platform: PLATFORM,
                url: location.href,
                conversation_id: getCurrentId() || '',
                create,
                summary_only: true
            });
        } catch (error) {
            return { success: false, passive: true, error: error?.message || String(error) };
        }
    };

    const panelStoreText = (status) => {
        if (!status?.enabled) return 'Recording: off';
        const summary = status?.summary || {};
        const stored = Array.isArray(summary.stored_sessions) ? summary.stored_sessions.length : 0;
        const known = Array.isArray(summary.known_sessions) ? summary.known_sessions.length : 0;
        const markers = summary.marker_count || 0;
        const captures = summary.capture_count || 0;
        const missing = Array.isArray(status?.missing_probes) ? status.missing_probes.length : 0;
        if (!status?.success && !known && !markers && !captures) return 'Recording: on; waiting for research traffic';
        return `Recording: on | ${stored}/${Math.max(known, stored)} sessions | ${markers} events | ${captures} captures${missing ? ` | ${missing} missing` : ''}`;
    };

    const updatePassiveStoreStatus = async (create = false) => {
        const status = await passiveStoreStatus(create);
        CT.setPanelStatus?.(panelStoreText(status), status?.storage_error || 'Passive ChatGPT MCP/telemetry store');
        return status;
    };

    const mcpRequestFromProbe = (probe) => ({
        app_uri: probe.app_uri || 'connectors://connector_openai_deep_research',
        tool_name: 'get_state',
        conversation_id: probe.conversation_id || getCurrentId() || '',
        message_id: probe.message_id || '',
        tool_input: { session_id: probe.session_id || '' }
    });

    const fetchAndStoreMcpProbe = async (probe) => {
        const body = mcpRequestFromProbe(probe);
        if (!body.conversation_id || !body.message_id || !body.tool_input.session_id) {
            throw new Error('Missing deep-research MCP ids');
        }

        const started = Date.now();
        const res = await chatGPTFetch(`${location.origin}/backend-api/ecosystem/call_mcp`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        const bounded = await readResponseTextLimited(res);
        const parsed = bounded.truncated ? null : safeParseJSON(bounded.text);

        return browser.runtime.sendMessage({
            action: 'passive-store-ingest-mcp',
            platform: PLATFORM,
            url: location.href,
            request: body,
            response: bounded.truncated
                ? { truncated: true, response_bytes: bounded.bytes }
                : (parsed == null ? bounded.text : parsed),
            status: res.status,
            duration_ms: Date.now() - started
        });
    };

    let passivePrimeRunning = false;
    const fetchResearchState = async () => {
        if (PLATFORM !== 'chatgpt' || passivePrimeRunning) return;
        // Called only by the explicit Fetch research state action. Page-owned
        // storage must not be able to turn on authenticated extension requests.
        const recording = await passiveStoreStatus(false);
        if (!recording?.enabled) throw new Error('Start diagnostic recording before fetching research state');
        passivePrimeRunning = true;
        try {
            let status = await updatePassiveStoreStatus(true);
            await CT.sleep(1800);
            status = await updatePassiveStoreStatus(true);
            if (!status?.enabled) throw new Error('Diagnostic recording was stopped');
            const missing = Array.isArray(status?.missing_probes) ? status.missing_probes : [];
            for (const probe of missing.slice(0, 2)) {
                CT.setPanelStatus?.('store: priming mcp', 'Fetching missing deep-research state');
                try {
                    status = await fetchAndStoreMcpProbe(probe);
                } catch (error) {
                    console.warn('[Chat Toolkit] passive MCP prime failed', error);
                }
            }
            await CT.sleep(250);
            await updatePassiveStoreStatus(true);
        } finally {
            passivePrimeRunning = false;
        }
    };

    const captureEntries = (captures) => Array.isArray(captures?._entries) ? captures._entries : [];
    const requestEntries = (state) => Array.isArray(state?.network?.requests) ? state.network.requests : [];

    const mergeCaptures = (pageCaptures = {}, backgroundCaptures = {}) => {
        const merged = { ...(pageCaptures || {}), ...(backgroundCaptures || {}) };
        const entries = [...captureEntries(pageCaptures), ...captureEntries(backgroundCaptures)]
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        if (entries.length) {
            merged._entries = entries;
            merged._latest = entries[entries.length - 1];
        }
        return merged;
    };

    const captureKind = (capture) => capture?.kind || (capture?.batch ? 'batchexecute' : capture?.json ? 'json' : capture?.text ? 'text' : 'response');
    const capturePreview = (capture) => {
        if (!capture) return '';
        if (capture.mcp) {
            const mcp = capture.mcp;
            return [
                mcp.tool_name || 'mcp',
                mcp.session_id ? `session ${mcp.session_id}` : '',
                mcp.deep_research_widget_message_count ? `${mcp.deep_research_widget_message_count} widget rows` : '',
                mcp.deep_research_thought_container_count ? `${mcp.deep_research_thought_container_count} thought containers` : '',
                mcp.deep_research_thought_count ? `${mcp.deep_research_thought_count} flat thoughts` : '',
                mcp.source_search_count ? `${mcp.source_search_count} source searches` : ''
            ].filter(Boolean).join(' | ');
        }
        if (capture.preview) return capture.preview;
        if (Array.isArray(capture.rpcids) && capture.rpcids.length) return `rpcids: ${capture.rpcids.join(', ')}`;
        if (capture.json) {
            try { return JSON.stringify(capture.json).replace(/\s+/g, ' ').slice(0, 220); }
            catch {}
        }
        return String(capture.text || capture.request_body || '').replace(/\s+/g, ' ').slice(0, 220);
    };

    const mcpMeta = (capture) => capture?.json?._meta || capture?.json?.meta || {};

    const deepResearchWidgetRows = (capture) => {
        const messages = mcpMeta(capture).deep_research_widget_messages;
        if (!Array.isArray(messages)) return [];
        return messages.slice(0, 80).map((message, index) => {
            const content = message?.content || {};
            const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
            return {
                capture_request_id: capture.request_id || '',
                index,
                id: message.id || '',
                role: message.author?.role || '',
                content_type: content.content_type || '',
                status: message.status || '',
                reasoning_status: message.metadata?.reasoning_status || '',
                source_analysis_msg_id: content.source_analysis_msg_id || '',
                thought_count: thoughts.length,
                text_preview: Array.isArray(content.parts) ? String(content.parts.join('\n')).slice(0, 500) : String(content.content || '').slice(0, 500)
            };
        });
    };

    const deepResearchThoughts = (capture) => {
        const messages = mcpMeta(capture).deep_research_widget_messages;
        if (!Array.isArray(messages)) return [];
        const out = [];
        for (const [messageIndex, message] of messages.slice(0, 80).entries()) {
            const content = message?.content || {};
            const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
            for (const [thoughtIndex, thought] of thoughts.entries()) {
                if (out.length >= 80) break;
                out.push({
                    capture_request_id: capture.request_id || '',
                    widget_index: messageIndex,
                    widget_id: message.id || '',
                    source_analysis_msg_id: content.source_analysis_msg_id || '',
                    thought_index: thoughtIndex,
                    summary: String(thought?.summary || '').slice(0, 300),
                    content: String(thought?.content || '').slice(0, 1200),
                    finished: !!thought?.finished,
                    widget_status: message.status || '',
                    reasoning_status: message.metadata?.reasoning_status || '',
                    create_time: message.create_time || null
                });
            }
            if (out.length >= 80) break;
        }
        return out;
    };

    const summarizeDeepResearch = (pageState) => {
        const captures = captureEntries(pageState?.captures);
        const mcp = captures.filter((capture) => capture?.mcp);
        const widgetRows = mcp.flatMap(deepResearchWidgetRows).slice(0, 120);
        const thoughts = mcp.flatMap(deepResearchThoughts).slice(0, 120);
        const widgetRowCount = mcp.reduce((sum, capture) => sum + (capture.mcp?.deep_research_widget_message_count || 0), 0);
        const thoughtCount = mcp.reduce((sum, capture) => sum + (capture.mcp?.deep_research_thought_count || 0), 0);
        const requests = requestEntries(pageState);
        const requestMarkers = requests.map((request) => {
            try { return JSON.parse(request.request_body || '{}'); } catch { return null; }
        }).filter((body) => body?.type === 'track' && /deep-research|File Citation|Enhanced Citations|link_action/i.test(body.event || ''))
            .map((body) => ({
                event: body.event || '',
                conversation_id: body.properties?.conversation_id || body.properties?.client_thread_id || body.properties?.conversationId || '',
                message_id: body.properties?.message_id || '',
                session_id: body.properties?.session_id || '',
                turn_index: body.properties?.turn_index ?? '',
                source: body.properties?.source || '',
                type: body.properties?.type || ''
            }));
        const passiveMarkers = [
            ...(pageState?.passive_store?.markers || []),
            ...(pageState?.background_capture?.passive_store?.markers || [])
        ].filter((marker) => /deep-research|File Citation|Enhanced Citations|link_action|Tool:|thinking|reasoning|render/i.test(marker.event || marker.model_slug || marker.stage || ''))
            .map((marker) => ({
                event: marker.event || '',
                conversation_id: marker.conversation_id || '',
                message_id: marker.message_id || '',
                session_id: marker.session_id || '',
                plan_id: marker.plan_id || '',
                turn_index: marker.turn_index ?? '',
                model_slug: marker.model_slug || '',
                stage: marker.stage || '',
                render_skip_reason: marker.render_skip_reason || '',
                source: marker.source || '',
                type: marker.type || ''
            }));
        const seenMarkers = new Set();
        const markers = [...requestMarkers, ...passiveMarkers].filter((marker) => {
            const key = `${marker.event}:${marker.conversation_id}:${marker.message_id}:${marker.session_id}:${marker.turn_index}:${marker.stage}`;
            if (seenMarkers.has(key)) return false;
            seenMarkers.add(key);
            return true;
        });

        return {
            mcp_capture_count: mcp.length,
            widget_row_count: widgetRowCount,
            widget_type_counts: widgetRows.reduce((counts, row) => {
                counts[row.content_type || 'unknown'] = (counts[row.content_type || 'unknown'] || 0) + 1;
                return counts;
            }, {}),
            thought_container_count: widgetRows.filter((row) => row.thought_count > 0).length,
            thought_count: thoughtCount,
            widget_rows: widgetRows,
            thoughts,
            captures: mcp.map((capture) => ({
                status: capture.status || 0,
                response_size: capture.response_size || 0,
                url: capture.url || '',
                mcp: capture.mcp
            })),
            marker_count: markers.length,
            markers: markers.slice(-40)
        };
    };

    const compactRequest = (request) => ({
        method: request?.method || 'GET',
        status: request?.status || 0,
        duration_ms: request?.duration_ms || 0,
        size: request?.size || 0,
        type: request?.type || '',
        source: request?.source || '',
        url: String(request?.url || '').slice(0, 400),
        error: String(request?.error || request?.filter_error || '').slice(0, 240)
    });

    const compactCapture = (capture) => ({
        request_id: capture?.request_id || '',
        method: capture?.method || '',
        status: capture?.status || 0,
        timestamp: capture?.timestamp || 0,
        duration_ms: capture?.duration_ms || 0,
        kind: captureKind(capture),
        response_size: capture?.response_size || 0,
        url: String(capture?.url || '').slice(0, 400),
        preview: capturePreview(capture).slice(0, 500),
        rpcids: Array.isArray(capture?.rpcids) ? capture.rpcids.slice(0, 20) : [],
        json_keys: Array.isArray(capture?.json_keys) ? capture.json_keys.slice(0, 30) : [],
        mcp: capture?.mcp || null
    });

    const compactDOMSnapshot = (snapshot = {}) => ({
        title: String(snapshot.title || document.title).slice(0, 300),
        url: String(snapshot.url || location.href).slice(0, 500),
        captured_at: snapshot.captured_at || null,
        selector_counts: snapshot.selector_counts || {},
        message_count: Array.isArray(snapshot.messages) ? snapshot.messages.length : 0,
        message_samples: (snapshot.messages || []).slice(0, 40).map((message, index) => {
            const value = message?.content ?? message?.text ?? '';
            const text = typeof value === 'string'
                ? value
                : (Array.isArray(value) ? value.filter((item) => typeof item === 'string').join('\n') : '');
            return {
                index,
                role: message?.role || '',
                content_preview: text.replace(/\s+/g, ' ').trim().slice(0, 800)
            };
        })
    });

    const compactPassiveStore = (store) => store ? {
        success: !!store.success,
        updated_at: store.updated_at || 0,
        storage_error: String(store.storage_error || '').slice(0, 240),
        summary: store.summary || {},
        markers: (store.markers || []).slice(-40),
        probes: (store.probes || []).slice(-20)
    } : null;

    const compactPageState = (state = {}) => {
        const requests = requestEntries(state);
        const captures = captureEntries(state?.captures);
        const websocket = state?.streams?.websocket || [];
        const eventsource = state?.streams?.eventsource || [];
        return {
            network: {
                started: state?.network?.started || 0,
                request_count: requests.length,
                recent_requests: requests.slice(-80).map(compactRequest)
            },
            captures: {
                count: captures.length,
                recent: captures.slice(-12).map(compactCapture)
            },
            streams: {
                websocket_count: websocket.length,
                websocket_message_count: websocket.reduce((sum, item) => sum + (item?.messages?.length || 0), 0),
                eventsource_count: eventsource.length,
                eventsource_message_count: eventsource.reduce((sum, item) => sum + (item?.messages?.length || 0), 0)
            },
            errors: (state?.errors || []).slice(-20).map((error) => ({
                at: error?.at || 0,
                url: String(error?.url || '').slice(0, 400),
                error: String(error?.error || '').slice(0, 240)
            })),
            passive_store: compactPassiveStore(state?.passive_store),
            background: state?.background_capture ? {
                success: !!state.background_capture.success,
                error: String(state.background_capture.error || '').slice(0, 240),
                capture: state.background_capture.capture || null
            } : null
        };
    };

    const mergePageState = (pageState = {}, backgroundState = null) => {
        const bgOk = backgroundState?.success && backgroundState.network;
        const backgroundSummary = {
            success: !!backgroundState?.success,
            error: String(backgroundState?.error || '').slice(0, 240),
            capture: backgroundState?.capture || null
        };
        if (!bgOk) return {
            ...pageState,
            background_capture: backgroundSummary
        };

        const pageRequests = requestEntries(pageState);
        const bgRequests = requestEntries(backgroundState);
        const requests = [...pageRequests, ...bgRequests]
            .sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
        const startedValues = [
            pageState?.network?.started,
            backgroundState?.network?.started
        ].filter(Boolean);

        return {
            ...pageState,
            network: {
                ...(pageState.network || {}),
                started: startedValues.length ? Math.min(...startedValues) : Date.now(),
                requests
            },
            captures: mergeCaptures(pageState.captures, backgroundState.captures),
            streams: {
                websocket: [
                    ...(pageState?.streams?.websocket || []),
                    ...(backgroundState?.streams?.websocket || [])
                ],
                eventsource: [
                    ...(pageState?.streams?.eventsource || []),
                    ...(backgroundState?.streams?.eventsource || [])
                ]
            },
            background_capture: backgroundSummary,
            passive_store: backgroundState.passive_store || null
        };
    };

    const safeFilename = (name) => String(name || 'chat').replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_').slice(0, 80);
    const todayStamp = () => new Date().toISOString().slice(0, 10);

    // ---- actions ---------------------------------------------------------

    const exportChat = async (format) => {
        try {
            const { raw, clean } = await getActiveConversation();
            const name = safeFilename(clean.name || clean.title || raw?.name || raw?.title);
            const base = `${PLATFORM}_${name}_${todayStamp()}`;
            const fallbackTitle = clean.name || clean.title || raw?.name || raw?.title || document.title;
            const fallbackId = getCurrentId() || '';

            if (format === 'json') {
                const llm = await parserCall('llm', {
                    platform: PLATFORM, raw, clean, fallbackTitle, fallbackId
                });
                await download(JSON.stringify(llm, null, 2), base + '.json');
            } else if (format === 'md') {
                const md = await parserCall('markdown', { platform: PLATFORM, raw, fallbackTitle });
                await download(md, base + '.md', 'text/markdown');
            } else {
                const html = await parserCall('html', { platform: PLATFORM, raw, fallbackTitle });
                await download(html, base + '.html', 'text/html');
            }

            notify(`Exported ${format.toUpperCase()}`, raw._source === 'dom' ? '(DOM)' : '');
        } catch (e) {
            notify('Export failed', e.message);
            console.error('[Chat Toolkit]', e);
        }
    };

    const exportRoleTurns = async (role) => {
        try {
            const { raw, clean } = await getActiveConversation();
            const name = safeFilename(clean.name || clean.title);
            const filename = `${PLATFORM}_${name}_${todayStamp()}_${role}_turns.md`;
            const fallbackTitle = clean.name || clean.title || raw?.name || raw?.title || document.title;
            const md = await parserCall('role', { platform: PLATFORM, raw, role, fallbackTitle });
            await download(md, filename, 'text/markdown');
            notify(`Exported ${role === 'user' ? 'User' : 'Assistant'} turns`,
                raw._source === 'dom' ? '(DOM)' : '');
        } catch (e) {
            notify('Role export failed', e.message);
            console.error('[Chat Toolkit]', e);
        }
    };

    const copyChat = async () => {
        try {
            const { raw } = await getActiveConversation();
            const fallbackTitle = raw?.name || raw?.title || document.title;
            // Run sequentially so the same raw conversation is never cloned
            // into two Workers at once on very long chats.
            const md = await parserCall('markdown', { platform: PLATFORM, raw, fallbackTitle });
            const html = await parserCall('html', { platform: PLATFORM, raw, fallbackTitle });
            const ok = await copyToClipboard(html, md);
            notify(ok ? 'Copied' : 'Copy failed', ok ? 'Paste into Word or LLM' : '');
        } catch (e) {
            notify('Copy failed', e.message);
            console.error('[Chat Toolkit]', e);
        }
    };

    // ---- drag-to-attach --------------------------------------------------

    let dragPill = null;
    let dragHost = null;
    const showDragPill = async () => {
        if (dragPill) { dragHost?.remove(); dragHost = null; dragPill = null; return; }
        try {
            const { raw } = await getActiveConversation();
            const fallbackTitle = raw?.name || raw?.title || document.title;
            const md = await parserCall('markdown', { platform: PLATFORM, raw, fallbackTitle });
            const name = safeFilename(raw?.name || raw?.title).slice(0, 40);
            const filename = `${PLATFORM}_${name}.md`;

            dragPill = document.createElement('div');
            dragPill.id = 'chat-toolkit-drag';
            dragPill.draggable = true;
            dragPill.textContent = 'Drag to attach';
            dragPill.appendChild(document.createElement('br'));
            const dragFilename = document.createElement('small');
            dragFilename.textContent = filename;
            dragPill.appendChild(dragFilename);
            dragPill.style.cssText = `
                position: fixed; bottom: 80px; right: 20px; z-index: 2147483647;
                background: linear-gradient(135deg, ${COLORS[PLATFORM]}, ${COLORS[PLATFORM]}dd);
                color: #000; padding: 12px 18px; border-radius: 12px;
                font: 13px/1.4 ui-monospace, monospace; cursor: grab;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4); user-select: none;
            `;

            dragPill.addEventListener('dragstart', (e) => {
                if (!e.isTrusted || !e.dataTransfer) return;
                e.dataTransfer.effectAllowed = 'copy';
                let addedFile = false;
                try {
                    if (e.dataTransfer.items?.add) {
                        e.dataTransfer.items.add(new File([md], filename, { type: 'text/markdown' }));
                        addedFile = true;
                    }
                } catch {}
                if (!addedFile) {
                    const dataUrl = 'data:text/markdown;base64,' + btoa(unescape(encodeURIComponent(md)));
                    e.dataTransfer.setData('DownloadURL', `text/markdown:${filename}:${dataUrl}`);
                }
                e.dataTransfer.setData('text/markdown', md);
                e.dataTransfer.setData('text/plain', md);
                dragPill.style.opacity = '0.5';
            });

            dragPill.addEventListener('dragend', () => {
                if (dragPill) dragPill.style.opacity = '1';
                notify('Drag finished', 'Drop into a file target');
            });

            dragPill.addEventListener('click', () => { dragHost?.remove(); dragHost = null; dragPill = null; });

            dragHost = CT.mountPrivateUI(dragPill);
            document.body.appendChild(dragHost);
            notify('Drag pill ready', 'Drag to LLM file drop zone');
        } catch (e) {
            notify('Failed', e.message);
            console.error('[Chat Toolkit]', e);
        }
    };

    // ---- report panel handlers ------------------------------------------

    const reportHandlers = {
        onCopy: async (report) => {
            if (!report) return;
            const ok = await copyToClipboard('', report.text);
            notify(ok ? 'Report copied' : 'Copy failed', ok ? report.filename : '');
        },
        onDownload: async (report) => {
            if (!report) return;
            try {
                await download(report.text, report.filename, report.type);
                notify('Report saved', report.filename);
            } catch (e) {
                notify('Save failed', e.message);
            }
        },
        emitToPage: emitPageReport
    };
    const display = (report) => showReport({ report, ...reportHandlers });

    // ---- diff ------------------------------------------------------------

    const runDiff = async () => {
        try {
            const { raw } = await getActiveConversation();
            const domSnapshot = captureDOMSnapshot(PLATFORM);
            const diff = await parserCall('diff', { platform: PLATFORM, raw, domSnapshot });

            display({
                title: `${PLATFORM.toUpperCase()} Surface Diff`,
                summary: `Compared ${diff.api_block_count} normalized API blocks against ${diff.dom_block_count} visible DOM blocks.`,
                rows: [...diff.dom_only, ...diff.api_only].slice(0, 60),
                data: diff,
                filename: `${PLATFORM}_surface_diff.json`
            });
        } catch (e) {
            notify('Diff failed', e.message);
            console.error('[Chat Toolkit]', e);
        }
    };

    // ---- capture export --------------------------------------------------

    const buildSessionBundle = async (raw) => {
        const id = getCurrentId();
        if (!id) return null;
        if (PLATFORM === 'chatgpt') {
            const discovery = await parserCall('discoverChatGPT', {
                raw: raw || {},
                fallbackId: id,
                fallbackTitle: document.title
            });
            return fetchChatGPTSessionBundle(id, discovery);
        }
        if (PLATFORM === 'claude') {
            const discovery = await parserCall('discoverClaude', {
                raw: raw || {},
                fallbackId: id,
                fallbackTitle: document.title,
                orgId: getClaudeOrgId()
            });
            return fetchClaudeSessionBundle(id, discovery);
        }
        return null;
    };

    const exportCapture = async (includeAccountDetails = false) => {
        let backgroundCapture = null;
        try {
            await networkCapture('start', 'capture-export');
            const manifest = await withPageCapture(async () => {
                const { raw, clean } = await getActiveConversation();
                const fallbackTitle = clean.name || clean.title || raw?.name || raw?.title || document.title;
                const [llm, sessionBundle] = await Promise.all([
                    parserCall('llm', {
                        platform: PLATFORM,
                        raw,
                        clean,
                        fallbackTitle,
                        fallbackId: getCurrentId() || ''
                    }),
                    includeAccountDetails ? buildSessionBundle(raw) : null
                ]);
                backgroundCapture = await networkCapture('get', 'capture-export');
                const pageState = mergePageState(getPageState() || {}, backgroundCapture);
                const deepResearch = summarizeDeepResearch(pageState);
                return {
                    manifest_version: 3,
                    export_kind: 'bounded_chat_capture',
                    platform: PLATFORM,
                    captured_at: new Date().toISOString(),
                    url: location.href,
                    title: fallbackTitle,
                    conversation: llm,
                    session_bundle: sessionBundle,
                    deep_research: deepResearch,
                    dom: compactDOMSnapshot(captureDOMSnapshot(PLATFORM)),
                    page_state: compactPageState(pageState),
                    limits: {
                        canonical_conversation: 'full active-branch history: every turn with reasoning and tool I/O, no character limit',
                        network_requests: 80,
                        response_capture_summaries: 12,
                        dom_message_samples: 40
                    }
                };
            });
            const name = safeFilename(manifest.title);
            await download(safeStringify(manifest),
                `${PLATFORM}_${name}_${todayStamp()}.capture.json`, 'application/json');
            notify('Capture exported', 'Live manifest saved');
        } catch (e) {
            notify('Capture failed', e.message);
            console.error('[Chat Toolkit]', e);
        } finally {
            await networkCapture('stop', 'capture-export');
        }
    };

    // ---- explorer --------------------------------------------------------

    const getAllKeys = (obj, prefix = '', depth = 0) => {
        if (depth > 4 || !obj || typeof obj !== 'object') return [];
        const keys = [];
        if (Array.isArray(obj)) {
            if (obj.length) keys.push(...getAllKeys(obj[0], `${prefix}[0]`, depth + 1));
        } else {
            for (const [k, v] of Object.entries(obj)) {
                const p = prefix ? `${prefix}.${k}` : k;
                keys.push({ path: p, type: Array.isArray(v) ? 'array' : typeof v });
                if (typeof v === 'object' && v) keys.push(...getAllKeys(v, p, depth + 1));
            }
        }
        return keys;
    };

    const runExplorer = async () => {
        try {
            let data;
            let rows;
            let summary;
            if (PLATFORM === 'claude') {
                const id = getCurrentId();
                const { raw, messages } = await fetchClaudeRawAndMessages(id);
                rows = getAllKeys({ raw, messages }).slice(0, 60);
                data = {
                    payload_summary: {
                        raw_messages: raw?.chat_messages?.length || 0,
                        rendered_messages: messages?.chat_messages?.length || 0,
                        conversation_id: raw?.uuid || id || '',
                        title: raw?.name || document.title
                    },
                    schema_paths: rows
                };
                summary = `Fetched Claude conversation metadata. Raw messages: ${data.payload_summary.raw_messages}. Rendered messages: ${data.payload_summary.rendered_messages}.`;
            } else if (PLATFORM === 'chatgpt') {
                const conversation = await fetchChatGPT(getCurrentId());
                const domData = DOM.chatgpt();
                const apiClean = await parserCall('clean', { platform: 'chatgpt', raw: conversation });
                const source = apiClean.messages.length ? 'api' : (domData.messages.length ? 'dom' : 'api');
                rows = getAllKeys(conversation).slice(0, 60);
                const sessionBundle = await buildSessionBundle(conversation);
                const roleCounts = apiClean.messages.reduce((counts, message) => {
                    const role = message.role || 'unknown';
                    counts[role] = (counts[role] || 0) + 1;
                    return counts;
                }, {});
                data = {
                    source,
                    conversation_summary: {
                        id: conversation.conversation_id || conversation.id || getCurrentId() || '',
                        title: conversation.title || document.title,
                        model: conversation.default_model_slug || '',
                        mapping_nodes: Object.keys(conversation.mapping || {}).length,
                        message_count: apiClean.messages.length,
                        role_counts: roleCounts
                    },
                    schema_paths: rows,
                    dom: compactDOMSnapshot(domData),
                    session_bundle: sessionBundle
                };
                summary = `Fetched ChatGPT conversation metadata. Mapping nodes: ${data.conversation_summary.mapping_nodes}. Visible source: ${source}. DOM messages: ${data.dom.message_count}. Lean session resources: ${sessionBundle?.summary?.ok || 0}/${sessionBundle?.summary?.requested || 0}.`;
            } else if (PLATFORM === 'openrouter') {
                const conversation = await fetchOpenRouter(getCurrentId());
                const apiClean = await parserCall('clean', { platform: 'openrouter', raw: conversation });
                rows = getAllKeys(conversation).slice(0, 60);
                const reasoningMessages = apiClean.messages.filter((message) => message.reasoning).length;
                data = {
                    conversation_summary: {
                        id: conversation.id || getCurrentId() || '',
                        title: conversation.title || document.title,
                        model: conversation.model || '',
                        message_count: apiClean.messages.length,
                        reasoning_message_count: reasoningMessages,
                        source: conversation._source || 'indexeddb'
                    },
                    schema_paths: rows
                };
                summary = `Read OpenRouter chat storage. Messages: ${apiClean.messages.length}. Reasoning turns: ${reasoningMessages}.`;
            } else if (PLATFORM === 'grok') {
                const conversation = await fetchGrok(getCurrentId());
                const apiClean = await parserCall('clean', { platform: 'grok', raw: conversation });
                rows = getAllKeys(conversation).slice(0, 60);
                data = {
                    conversation_summary: {
                        id: apiClean.id || getCurrentId() || '',
                        title: apiClean.title || document.title,
                        message_count: apiClean.messages.length,
                        response_node_count: conversation.responseNodes?.length || 0,
                        selected_response_id: conversation._selected_response_id,
                        source: conversation._source,
                        metadata_error: conversation._metadata_error
                    },
                    schema_paths: rows
                };
                summary = `Fetched Grok conversation history. Messages: ${apiClean.messages.length}.`;
            } else {
                const extracted = await extractGoogle();
                rows = getAllKeys(extracted).slice(0, 60);
                data = {
                    conversation_summary: {
                        title: extracted?.name || document.title,
                        message_count: extracted?.messages?.length || 0,
                        source: extracted?._source || 'unknown'
                    },
                    schema_paths: rows
                };
                summary = `Fetched ${PLATFORM} page metadata. Messages: ${data.conversation_summary.message_count}. Source: ${data.conversation_summary.source}.`;
            }

            display({
                title: `${PLATFORM.toUpperCase()} API Explorer`,
                summary,
                rows,
                data,
                filename: `${PLATFORM}_api_explorer.json`
            });
        } catch (e) {
            console.error('[Explorer]', e);
            notify('Explorer failed', e.message);
        }
    };

    // ---- sniffer ---------------------------------------------------------

    const runSniffer = async () => {
        let started = false;
        try {
            const startResult = await networkCapture('start', 'network-inspector');
            started = !!startResult?.success;
            // A short observation window catches in-flight natural traffic.
            // No platform fetch or MCP call is generated by this action.
            await CT.sleep(250);
            const backgroundCapture = await networkCapture('get', 'network-inspector');
            const requests = requestEntries(backgroundCapture);
            const streams = backgroundCapture?.streams || { websocket: [], eventsource: [] };
            const endpoints = {};
            for (const r of requests) {
                const normalized = String(r.url || '').replace(/[a-f0-9-]{36}/gi, '{id}').split('?')[0];
                const key = `${r.method || 'GET'} ${normalized}`;
                if (!endpoints[key]) {
                    endpoints[key] = {
                        method: r.method || 'GET',
                        endpoint: normalized.slice(0, 120),
                        hits: 0, last_status: 0, avg_ms: 0, total_ms: 0,
                        source: r.source || ''
                    };
                }
                endpoints[key].hits += 1;
                endpoints[key].last_status = r.status || 0;
                endpoints[key].total_ms += r.duration_ms || 0;
                endpoints[key].avg_ms = Math.round(endpoints[key].total_ms / endpoints[key].hits);
            }

            const rows = Object.values(endpoints).sort((a, b) => b.hits - a.hits).slice(0, 25);
            const captures = captureEntries(backgroundCapture?.captures);
            const deepResearch = summarizeDeepResearch(backgroundCapture);
            const captureRows = captures.slice(-18).reverse().map((capture) => ({
                kind: captureKind(capture),
                method: capture.method || '',
                status: capture.status || 0,
                size: capture.response_size || 0,
                rpcids: Array.isArray(capture.rpcids) ? capture.rpcids.join(', ') : '',
                keys: Array.isArray(capture.json_keys) ? capture.json_keys.join(', ') : '',
                endpoint: String(capture.url || '').replace(/[a-f0-9-]{36}/gi, '{id}').split('?')[0].slice(0, 120),
                preview: capturePreview(capture)
            }));
            const bodyRows = requests
                .filter((r) => r.request_body || r.filter_error || r.error)
                .slice(-12).reverse().map((r) => ({
                    kind: r.error ? 'error' : r.filter_error ? 'filter_error' : 'request_body',
                    method: r.method || 'GET',
                    status: r.status || 0,
                    endpoint: String(r.url || '').replace(/[a-f0-9-]{36}/gi, '{id}').split('?')[0].slice(0, 120),
                    preview: String(r.error || r.filter_error || r.request_body || '').replace(/\s+/g, ' ').slice(0, 220)
                }));
            const transportRows = [
                ...(streams.websocket || []).slice(-10).map((stream) => ({
                    transport: 'websocket',
                    url: String(stream.url || '').slice(0, 120),
                    messages: Array.isArray(stream.messages) ? stream.messages.length : 0
                })),
                ...(streams.eventsource || []).slice(-10).map((stream) => ({
                    transport: 'eventsource',
                    url: String(stream.url || '').slice(0, 120),
                messages: Array.isArray(stream.messages) ? stream.messages.length : 0
                }))
            ];
            const deepResearchRows = deepResearch.captures.map((item) => ({
                kind: 'deep_research',
                status: item.status || 0,
                size: item.response_size || 0,
                endpoint: String(item.url || '').replace(/[a-f0-9-]{36}/gi, '{id}').split('?')[0].slice(0, 120),
                preview: [
                    item.mcp?.tool_name || 'mcp',
                    item.mcp?.session_id ? `session ${item.mcp.session_id}` : '',
                    item.mcp?.deep_research_widget_message_count ? `${item.mcp.deep_research_widget_message_count} widget rows` : '',
                    item.mcp?.deep_research_thought_container_count ? `${item.mcp.deep_research_thought_container_count} thought containers` : '',
                    item.mcp?.deep_research_thought_count ? `${item.mcp.deep_research_thought_count} flat thoughts` : '',
                    item.mcp?.source_search_count ? `${item.mcp.source_search_count} source searches` : ''
                ].filter(Boolean).join(' | ')
            }));
            const recent = requests.slice(-30).map((r) => ({
                method: r.method || 'GET',
                status: r.status || 0,
                ms: r.duration_ms || 0,
                size: r.size || 0,
                source: r.source || '',
                url: String(r.url || '').slice(0, 140)
            }));

            const backgroundReady = !!backgroundCapture?.success;
            const summary = backgroundReady
                ? `Metadata-only snapshot of ${requests.length} recent requests across ${rows.length} endpoints. Network generated 0 probe requests and captured 0 response bodies.`
                : `Metadata-only capture was unavailable${backgroundCapture?.error ? `: ${backgroundCapture.error}` : ''}. Network generated 0 probe requests.`;

            display({
                title: `${PLATFORM.toUpperCase()} Network Inspector`,
                summary,
                rows: [...deepResearchRows, ...captureRows, ...bodyRows, ...rows, ...transportRows].slice(0, 50),
                data: {
                    mode: 'passive_metadata_only',
                    generated_requests: 0,
                    response_bodies_captured: false,
                    started_at: backgroundCapture?.network?.started || null,
                    capture_settings: backgroundCapture?.capture || null,
                    request_count: requests.length,
                    endpoint_count: Object.keys(endpoints).length,
                    endpoints: rows,
                    capture_count: captures.length,
                    deep_research: deepResearch,
                    capture_summaries: captures.slice(-12).map(compactCapture),
                    recent_requests: recent,
                    passive_store: compactPassiveStore(backgroundCapture?.passive_store),
                    streams: compactPageState(backgroundCapture).streams,
                    errors: (backgroundCapture?.errors || []).slice(-20).map((error) => ({
                        at: error?.at || 0,
                        url: String(error?.url || '').slice(0, 400),
                        error: String(error?.error || '').slice(0, 240)
                    }))
                },
                filename: `${PLATFORM}_network_report.json`
            });
        } catch (e) {
            notify('Sniffer error', e.message);
        } finally {
            if (started) await networkCapture('stop', 'network-inspector');
        }
    };

    // ---- dom inspector ---------------------------------------------------

    const runDOM = () => {
        const probes = DOM_PROBES[PLATFORM] || { messages: [], code: [], attachments: [] };
        const selectors = [...probes.messages, ...probes.code, ...probes.attachments];

        const results = [];
        for (const sel of selectors) {
            try {
                const nodes = Array.from(document.querySelectorAll(sel));
                const sample = CT.cleanText(
                    nodes[0]?.innerText ||
                    nodes[0]?.textContent ||
                    nodes[0]?.getAttribute?.('alt') ||
                    nodes[0]?.getAttribute?.('aria-label') ||
                    nodes[0]?.getAttribute?.('href') ||
                    nodes[0]?.getAttribute?.('src') ||
                    ''
                ).slice(0, 90);
                if (nodes.length) results.push({ selector: sel, count: nodes.length, sample });
            } catch {}
        }

        const snapshot = captureDOMSnapshot(PLATFORM);
        display({
            title: `${PLATFORM.toUpperCase()} DOM Inspector`,
            summary: `Matched ${results.length} platform selectors on the active page.`,
            rows: results,
            data: {
                title: snapshot.title,
                url: snapshot.url,
                ready_state: document.readyState,
                metrics: {
                    pre_blocks: snapshot.selector_counts.code_blocks,
                    code_nodes: document.querySelectorAll('code').length,
                    buttons: document.querySelectorAll('button').length,
                    editable_fields: document.querySelectorAll('textarea, [contenteditable="true"]').length,
                    attachments: snapshot.selector_counts.attachments
                },
                snapshot: compactDOMSnapshot(snapshot)
            },
            filename: `${PLATFORM}_dom_report.json`
        });
    };

    // ---- action dispatch -------------------------------------------------

    const changeRecording = async (mode) => {
        const result = await browser.runtime.sendMessage({ action: `diagnostics-${mode}` });
        if (!result?.success) throw new Error(result?.error || 'Could not change diagnostic recording');
        if (mode === 'clear') await setPageCapture('clear');
        CT.setPanelStatus?.(result.enabled ? 'Recording: on' : 'Recording: off');
        notify('Diagnostics', mode === 'clear' ? 'Recorded data cleared' : result.enabled ? 'Recording this tab locally' : 'Recording stopped');
    };

    const ACTIONS = {
        copy: copyChat,
        drag: showDragPill,
        'export-json': () => exportChat('json'),
        'export-md': () => exportChat('md'),
        'export-html': () => exportChat('html'),
        'export-user-turns': () => exportRoleTurns('user'),
        'export-assistant-turns': () => exportRoleTurns('assistant'),
        'export-capture': () => exportCapture(false),
        'export-account-capture': () => exportCapture(true),
        'diagnostics-start': () => changeRecording('start'),
        'diagnostics-stop': () => changeRecording('stop'),
        'diagnostics-clear': () => changeRecording('clear'),
        'fetch-research-state': async () => {
            if (PLATFORM !== 'chatgpt') throw new Error('Research state retrieval is available on ChatGPT');
            await fetchResearchState();
            notify('Research state', 'Available state saved in this tab’s diagnostics');
        },
        'enable-page-hooks': async () => {
            const result = await browser.runtime.sendMessage({ action: 'diagnostics-start' });
            if (!result?.success) throw new Error(result?.error || 'Diagnostics are unavailable');
            CT.enablePageHooks?.();
            notify('Page hooks enabled', 'Used during captures; reload this tab to remove them');
        },
        'open-help': () => browser.runtime.sendMessage({ action: 'open-help' }),
        'run-explorer': runExplorer,
        'run-sniffer': runSniffer,
        'run-dom': runDOM,
        'run-diff': runDiff
    };
    let activeAction = '';
    const handleAction = async (actionName) => {
        const action = ACTIONS[actionName];
        if (!action) return;
        if (activeAction) {
            notify('Chat Toolkit is busy', `${activeAction} is still running`);
            return;
        }
        activeAction = actionName;
        try {
            await action();
        } catch (error) {
            console.error('[Chat Toolkit] action failed', error);
            notify('Action failed', error?.message || String(error));
        } finally {
            activeAction = '';
        }
    };

    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'ping') { sendResponse({ ok: true }); return; }
        if (msg.action) void handleAction(msg.action);
    });

    const init = () => {
        if (!document.body || document.getElementById('chat-toolkit-panel')) return;
        document.body.appendChild(createPanel(handleAction));
        if (PLATFORM === 'chatgpt') {
            void updatePassiveStoreStatus(false);
            setInterval(() => void updatePassiveStoreStatus(false), 30000);
        }
        // Page transport hooks stay disabled unless explicitly opted into for
        // debugging; normal exports use content-script fetches and DOM parsing.
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }
})();
