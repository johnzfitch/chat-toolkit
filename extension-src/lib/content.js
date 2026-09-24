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
        PLATFORM, isGoogle, safeStringify,
        getCurrentId, getClaudeOrgId,
        fetchClaude, fetchClaudeRawAndMessages, fetchChatGPT, chatGPTFetch, fetchGrok, fetchOpenRouter,
        fetchGemini, extractGeminiConversation,
        fetchChatGPTSessionBundle, fetchClaudeSessionBundle,
        captureDOMSnapshot, DOM, DOM_PROBES,
        setPageCapture, withPageCapture, getPageState,
        emitPageReport, parserCall,
        notify, copyToClipboard, showReport, createPanel
    } = CT;
    const model = CT.model || globalThis.ChatToolkitModel || null;
    const panel = () => CT.panel?.() || null;
    const providerName = model?.PROVIDERS?.[PLATFORM]?.name || PLATFORM;

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

    // Gemini/AI Studio extraction, most-reliable source first:
    //   1. Active batchexecute replay (Gemini only) — fresh, full conversation.
    //   2. The rendered DOM.
    // (Earlier versions also looked for page-hook captures here, but reset the
    // capture buffer immediately before reading it, so that step never ran.)
    const extractGoogle = async () => {
        if (PLATFORM === 'gemini') {
            try {
                const id = getCurrentId();
                if (id) {
                    const fetched = await fetchGemini(id);
                    const extracted = extractGeminiConversation(fetched);
                    if (extracted.messages.length) {
                        return {
                            name: CT.geminiTitle?.() || document.title,
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

    // Readable footer text. Detailed counters stay in the footer's tooltip
    // and in diagnostic reports.
    const researchText = (status) => {
        if (!status?.enabled) return 'Research recording off';
        const summary = status?.summary || {};
        const stored = Array.isArray(summary.stored_sessions) ? summary.stored_sessions.length : 0;
        const known = Array.isArray(summary.known_sessions) ? summary.known_sessions.length : 0;
        const markers = summary.marker_count || 0;
        const captures = summary.capture_count || 0;
        if (!status?.success && !known && !markers && !captures) return 'Research recording on, waiting for research activity';
        const total = Math.max(known, stored);
        return `Research recording on, ${stored} of ${total} research session${total === 1 ? '' : 's'} stored`;
    };
    const researchDetail = (status) => {
        const summary = status?.summary || {};
        const missing = Array.isArray(status?.missing_probes) ? status.missing_probes.length : 0;
        return [`${summary.marker_count || 0} events`, `${summary.capture_count || 0} captures`,
            missing ? `${missing} sessions missing` : '', status?.storage_error || ''].filter(Boolean).join(', ');
    };

    let researchStatus = null;
    let researchTimer = null;
    let snifferActive = false;

    // Shown only while a diagnostic is actually running; nothing is shown
    // when all of them are off.
    const renderFooter = () => {
        const parts = [];
        if (PLATFORM === 'chatgpt' && researchStatus?.enabled) parts.push(researchText(researchStatus));
        if (snifferActive) parts.push('Network inspector recording');
        if (CT.pageHooksEnabled?.()) parts.push('Page hooks on');
        panel()?.setActivity(parts);
    };

    const updatePassiveStoreStatus = async (create = false) => {
        const status = await passiveStoreStatus(create);
        researchStatus = status;
        renderFooter();
        // Poll only while recording is on, so an idle tab sends no messages.
        if (status?.enabled && !researchTimer) {
            researchTimer = setInterval(() => void updatePassiveStoreStatus(false), 15000);
        } else if (!status?.enabled && researchTimer) {
            clearInterval(researchTimer);
            researchTimer = null;
        }
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
                panel()?.setActivity(['Fetching missing research state…']);
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

    // ---- exports ---------------------------------------------------------

    const EXPORT_FORMATS = {
        md: { label: 'Markdown', extension: 'md', type: 'text/markdown' },
        json: { label: 'JSON', extension: 'json', type: 'application/json' },
        html: { label: 'HTML', extension: 'html', type: 'text/html' }
    };
    const SCOPE_LABELS = { all: '', user: 'user ', assistant: 'assistant ' };

    // Scope and format come from the clicked surface (panel or popup). A
    // legacy caller without them uses the panel's remembered selection.
    const resolveSelection = (options = {}) => {
        const prefs = panel()?.prefs || {};
        const scope = ['all', 'user', 'assistant'].includes(options.scope) ? options.scope
            : ['all', 'user', 'assistant'].includes(prefs.scope) ? prefs.scope : 'all';
        const format = EXPORT_FORMATS[options.format] ? options.format
            : EXPORT_FORMATS[prefs.format] ? prefs.format : 'md';
        return { scope, format };
    };

    // One message per line: valid JSON with little whitespace, which keeps
    // token counts down while staying readable and diff-friendly.
    const formatExportJSON = (value) => {
        const { messages = [], ...rest } = value || {};
        const fields = Object.entries(rest).map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`);
        fields.push(`"messages": [${messages.length ? `\n${messages.map((message) => JSON.stringify(message)).join(',\n')}\n` : ''}]`);
        return `{\n${fields.join(',\n')}\n}\n`;
    };

    // Retrieves the conversation and renders it in the selected format and
    // message scope. Markdown role exports use the existing role renderer, so
    // their content is unchanged from earlier versions.
    const buildExport = async ({ scope, format }) => {
        const { raw, clean } = await getActiveConversation();
        const name = safeFilename(clean.name || clean.title || raw?.name || raw?.title);
        const fallbackTitle = clean.name || clean.title || raw?.name || raw?.title || document.title;
        const role = scope === 'all' ? '' : scope;
        const spec = EXPORT_FORMATS[format];
        let content;
        if (format === 'json') {
            content = formatExportJSON(await parserCall('llm', {
                platform: PLATFORM, raw, clean, fallbackTitle, fallbackId: getCurrentId() || '', role
            }));
        } else if (format === 'md') {
            content = role
                ? await parserCall('role', { platform: PLATFORM, raw, role, fallbackTitle })
                : await parserCall('markdown', { platform: PLATFORM, raw, fallbackTitle });
        } else {
            content = await parserCall('html', { platform: PLATFORM, raw, fallbackTitle, role });
        }
        let counts = null;
        try { counts = await parserCall('count', { platform: PLATFORM, raw }); } catch {}
        return {
            raw, content, role, format, scope, fallbackTitle,
            type: spec.type,
            filename: `${PLATFORM}_${name}_${todayStamp()}${role ? `_${role}_turns` : ''}.${spec.extension}`,
            counts
        };
    };

    // Completeness wording: say where the messages came from instead of
    // implying a complete backup.
    const describeExport = (prepared) => {
        const n = Number(prepared.scope === 'all' ? prepared.counts?.total : prepared.counts?.[prepared.scope]);
        const count = Number.isFinite(n) ? `${n} ${SCOPE_LABELS[prepared.scope] || ''}message${n === 1 ? '' : 's'}` : 'Messages';
        const source = prepared.raw?._source;
        if (source === 'dom') {
            return { kind: 'warn', detail: `${count} from the loaded page. Messages the page has not loaded are missing.` };
        }
        if (source === 'indexeddb') return { kind: 'ok', detail: `${count} from OpenRouter's chat storage in this browser.` };
        return { kind: 'ok', detail: `${count} from ${providerName}.` };
    };

    const saveChat = async (options) => {
        const prepared = await buildExport(resolveSelection(options));
        await download(prepared.content, prepared.filename, prepared.type);
        const described = describeExport(prepared);
        return { kind: described.kind, title: `Saved ${EXPORT_FORMATS[prepared.format].label} to Downloads`,
            detail: `${prepared.filename}. ${described.detail}` };
    };

    const copyChat = async (options) => {
        const prepared = await buildExport(resolveSelection(options));
        // Markdown copies also carry rendered HTML so rich editors paste
        // formatted text; plain-text destinations receive the Markdown.
        const html = prepared.format === 'md'
            ? await parserCall('html', { platform: PLATFORM, raw: prepared.raw,
                fallbackTitle: prepared.fallbackTitle, role: prepared.role })
            : prepared.format === 'html' ? prepared.content : '';
        const ok = await copyToClipboard(html, prepared.content);
        if (!ok) throw new Error('Firefox did not accept the clipboard write. Try Save file instead.');
        const described = describeExport(prepared);
        return { kind: described.kind, title: `Copied ${EXPORT_FORMATS[prepared.format].label}`, detail: described.detail };
    };

    // ---- report panel handlers ------------------------------------------

    const reportHandlers = {
        onCopy: async (report) => {
            if (!report) return;
            const ok = await copyToClipboard('', report.text);
            announce(ok ? { kind: 'ok', title: 'Report copied', detail: report.filename }
                : { kind: 'error', title: 'Copy failed', detail: 'Firefox did not accept the clipboard write.' });
        },
        onDownload: async (report) => {
            if (!report) return;
            try {
                await download(report.text, report.filename, report.type);
                announce({ kind: 'ok', title: 'Report saved to Downloads', detail: report.filename });
            } catch (e) {
                announce({ kind: 'error', title: 'Save failed', detail: e.message });
            }
        },
        emitToPage: emitPageReport
    };
    const display = (report) => {
        const shown = showReport({ report, ...reportHandlers });
        return { kind: 'info', title: shown?.title || report.title, detail: 'Report opened', quiet: true };
    };

    // ---- diff ------------------------------------------------------------

    const runDiff = async () => {
        const { raw } = await getActiveConversation();
        const domSnapshot = captureDOMSnapshot(PLATFORM);
        const diff = await parserCall('diff', { platform: PLATFORM, raw, domSnapshot });

        return display({
            title: `${providerName} API and page comparison`,
            summary: `Compared ${diff.api_block_count} normalized API blocks against ${diff.dom_block_count} visible page blocks.`,
            rows: [...diff.dom_only, ...diff.api_only].slice(0, 60),
            data: diff,
            filename: `${PLATFORM}_surface_diff.json`
        });
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

    const endSniffer = () => {
        if (!snifferActive) return false;
        snifferActive = false;
        panel()?.setCommand('run-sniffer', { label: 'Network inspector', pressed: null });
        renderFooter();
        return true;
    };

    const exportCapture = async (includeAccountDetails = false) => {
        // A capture replaces this tab's background capture state, which would
        // silently end a running Network inspector session.
        const endedSniffer = endSniffer();
        let backgroundCapture = null;
        try {
            // The background refuses captures in private windows; the export
            // must stop there too, not continue without network data.
            const started = await networkCapture('start', 'capture-export');
            if (!started?.success) throw new Error(started?.error || 'Diagnostic capture is unavailable in this tab');
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
            const filename = `${PLATFORM}_${name}_${todayStamp()}.capture.json`;
            await download(safeStringify(manifest), filename, 'application/json');
            return {
                kind: 'ok',
                title: includeAccountDetails ? 'Account capture saved to Downloads' : 'Diagnostic capture saved to Downloads',
                detail: `${filename}${endedSniffer ? '. The Network inspector session ended.' : ''}`
            };
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
        let data;
        let rows;
        let summary;
        if (PLATFORM === 'claude') {
            const id = getCurrentId();
            if (!id) throw new Error('No chat ID');
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

        return display({
            title: `${providerName} API inspector`,
            summary,
            rows,
            data,
            filename: `${PLATFORM}_api_explorer.json`
        });
    };

    // ---- network inspector -----------------------------------------------

    // First selection starts a metadata-only recording of this tab's provider
    // requests; the next selection shows the report and stops it. No request
    // is generated and no response body is kept.
    const runSniffer = async () => {
        if (!snifferActive) {
            const started = await networkCapture('start', 'network-inspector');
            if (!started?.success) throw new Error(started?.error || 'Network recording is unavailable in this tab');
            snifferActive = true;
            panel()?.setCommand('run-sniffer', { label: 'Show network report', pressed: true });
            renderFooter();
            return { kind: 'info', title: 'Network inspector recording',
                detail: 'Use the site, then select Show network report. Only request metadata is kept, in memory.' };
        }
        try {
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
            const startedAt = backgroundCapture?.network?.started || backgroundCapture?.capture?.started_at || 0;
            const seconds = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
            const summary = backgroundReady
                ? `Metadata-only recording of ${requests.length} requests across ${rows.length} endpoints over ${seconds} s. The inspector generated no requests and kept no response bodies.`
                : `Metadata-only capture was unavailable${backgroundCapture?.error ? `: ${backgroundCapture.error}` : ''}. The inspector generated no requests.`;

            return display({
                title: `${providerName} Network inspector`,
                summary,
                rows: [...deepResearchRows, ...captureRows, ...bodyRows, ...rows, ...transportRows].slice(0, 50),
                data: {
                    mode: 'passive_metadata_only',
                    generated_requests: 0,
                    response_bodies_captured: false,
                    started_at: backgroundCapture?.network?.started || null,
                    duration_seconds: seconds,
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
        } finally {
            endSniffer();
            await networkCapture('stop', 'network-inspector');
        }
    };

    // ---- page inspector --------------------------------------------------

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
        return display({
            title: `${providerName} Page inspector`,
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

    // ---- research recording ---------------------------------------------

    const changeRecording = async (mode) => {
        const result = await browser.runtime.sendMessage({ action: `diagnostics-${mode}` });
        if (!result?.success) throw new Error(result?.error || 'Could not change research recording');
        if (mode === 'clear') await setPageCapture('clear');
        await updatePassiveStoreStatus(false);
        if (mode === 'start') {
            return { kind: 'ok', title: 'Research recording on',
                detail: 'Recording ChatGPT research traffic in this tab, in memory only. Reloading or closing the tab clears it.' };
        }
        if (mode === 'stop') {
            return { kind: 'info', title: 'Research recording stopped',
                detail: 'What was recorded stays in memory until you clear it, reload, or close the tab.' };
        }
        return { kind: 'ok', title: 'Research data cleared', detail: 'Recording is off for this tab.' };
    };

    // ---- action dispatch -------------------------------------------------

    const ACTIONS = {
        copy: copyChat,
        save: saveChat,
        // Earlier direct-export names, kept for compatibility.
        'export-json': () => saveChat({ scope: 'all', format: 'json' }),
        'export-md': () => saveChat({ scope: 'all', format: 'md' }),
        'export-html': () => saveChat({ scope: 'all', format: 'html' }),
        'export-user-turns': () => saveChat({ scope: 'user', format: 'md' }),
        'export-assistant-turns': () => saveChat({ scope: 'assistant', format: 'md' }),
        'export-capture': () => exportCapture(false),
        'export-account-capture': () => exportCapture(true),
        'diagnostics-start': () => changeRecording('start'),
        'diagnostics-stop': () => changeRecording('stop'),
        'diagnostics-clear': () => changeRecording('clear'),
        'fetch-research-state': async () => {
            if (PLATFORM !== 'chatgpt') throw new Error('Research state retrieval is available on ChatGPT');
            await fetchResearchState();
            return { kind: 'ok', title: 'Research state fetched', detail: 'Available state is saved in this tab’s diagnostics.' };
        },
        'enable-page-hooks': async () => {
            if (CT.pageHooksEnabled?.()) return { kind: 'info', title: 'Page hooks are already on' };
            CT.enablePageHooks();
            renderFooter();
            return { kind: 'ok', title: 'Page hooks enabled',
                detail: 'They instrument this page’s requests during diagnostic captures. Reload the page to remove them.' };
        },
        'open-help': async () => { await browser.runtime.sendMessage({ action: 'open-help' }); return null; },
        'run-explorer': runExplorer,
        'run-sniffer': runSniffer,
        'run-dom': async () => runDOM(),
        'run-diff': runDiff
    };

    const FAILURE_TITLES = {
        copy: 'Copy failed',
        save: 'Export failed',
        'export-capture': 'Capture failed',
        'export-account-capture': 'Capture failed',
        'run-explorer': 'API inspector failed',
        'run-sniffer': 'Network inspector failed',
        'run-dom': 'Page inspector failed',
        'run-diff': 'Comparison failed'
    };
    const ACTION_LABELS = {
        copy: 'Copy', save: 'Save file',
        ...Object.fromEntries((model?.ADVANCED || []).map((command) => [command.id, command.label]))
    };

    const friendlyError = (error) => {
        const message = error?.message || String(error);
        if (/^No chat ID$|conversation ID|room ID in the URL|conversation id in URL/i.test(message)) {
            return 'Open a saved conversation first. This page address does not identify one.';
        }
        return message;
    };

    // Copy and Save confirm on their own button. Warnings, errors, and the
    // results of other commands appear as a short notification. Reports are
    // quiet because they open their own window.
    const announce = (result, actionName = '') => {
        if (!result?.title) return;
        const kind = result.kind || 'ok';
        const shown = panel()?.confirm(actionName, kind, result.title, result.detail || '');
        if (!shown && !result.quiet) notify(result.title, result.detail || '', kind);
    };

    let activeAction = '';
    const handleAction = async (actionName, options = {}) => {
        const action = Object.prototype.hasOwnProperty.call(ACTIONS, actionName) ? ACTIONS[actionName] : null;
        if (!action) return { ok: false, kind: 'error', title: 'Unknown action' };
        if (activeAction) {
            const busy = { kind: 'warn', title: 'Chat Toolkit is busy',
                detail: `${ACTION_LABELS[activeAction] || activeAction} is still running` };
            announce(busy, actionName);
            return { ok: false, ...busy };
        }
        activeAction = actionName;
        panel()?.setBusy(actionName, true);
        try {
            const result = await action(options);
            announce(result, actionName);
            return { ok: true, ...(result || {}) };
        } catch (error) {
            console.error('[Chat Toolkit] action failed', error);
            const failure = { kind: 'error', title: FAILURE_TITLES[actionName] || 'Action failed', detail: friendlyError(error) };
            announce(failure, actionName);
            return { ok: false, ...failure };
        } finally {
            panel()?.setBusy(actionName, false);
            activeAction = '';
        }
    };

    // Toolbar popup requests. Each resolves with the action's actual outcome.
    browser.runtime.onMessage.addListener((msg) => {
        if (!msg?.action) return undefined;
        if (msg.action === 'status') {
            return Promise.resolve({
                platform: PLATFORM,
                conversation: !!getCurrentId(),
                context: conversationContext(),
                busy: activeAction,
                panel: !!panel()
            });
        }
        if (!Object.prototype.hasOwnProperty.call(ACTIONS, msg.action)) return undefined;
        return handleAction(msg.action, { scope: msg.scope, format: msg.format });
    });

    // ---- panel lifecycle -------------------------------------------------

    const conversationContext = () => {
        if (getCurrentId()) return 'Saved conversation open';
        if (PLATFORM === 'aistudio') return 'Exports the loaded page';
        return 'Open a saved conversation to export';
    };
    // The palette shows a hint only when there is no saved conversation.
    const conversationHint = () => getCurrentId() || PLATFORM === 'aistudio' ? '' : 'Open a saved chat to export.';

    // Single-page apps change the address without reloading. The background
    // clears this tab's diagnostics on navigation; mirror that here.
    let lastHref = location.href;
    const watchLocation = () => {
        if (location.href === lastHref) return;
        lastHref = location.href;
        endSniffer();
        panel()?.setHint(conversationHint());
        if (PLATFORM === 'chatgpt') void updatePassiveStoreStatus(false);
    };

    const init = async () => {
        if (!document.body || document.getElementById('chat-toolkit-panel')) return;
        const prefs = model ? await model.loadPrefs() : null;
        if (document.getElementById('chat-toolkit-panel')) return;
        document.body.appendChild(createPanel(handleAction, {
            prefs,
            onPrefs: (patch) => { if (model) void model.savePrefs(patch); }
        }));
        panel()?.setHint(conversationHint());
        renderFooter();
        try {
            browser.storage?.onChanged?.addListener((changes, area) => {
                const change = model && area === 'local' ? changes[model.PREFS_KEY] : null;
                if (change) panel()?.applyPrefs(change.newValue);
            });
        } catch {}
        if (PLATFORM === 'chatgpt') void updatePassiveStoreStatus(false);
        setInterval(watchLocation, 1000);
        // Page transport hooks stay disabled unless explicitly opted into for
        // debugging; normal exports use content-script fetches and DOM parsing.
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    } else {
        setTimeout(init, 500);
    }
})();
