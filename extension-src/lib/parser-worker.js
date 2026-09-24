// Conversation parser. Receives platform + raw payload, returns normalized
// data, clean JSON, and rendered Markdown/HTML/LLM output.
//
// Loaded as a content script and called through CT.parserCall. (The file
// name predates the removal of an unused Worker entry point; Firefox cannot
// start a Worker from a content script with an extension URL.)

'use strict';

const ARTIFACT_TOOLS = ['artifacts', 'create_artifact', 'rewrite_artifact', 'update_artifact', 'create_file', 'file_create'];
const PLACEHOLDER = /^[\s\n]*```[\s\n]*This block is not supported/;

// A CommonMark code fence: up to three spaces, then three or more backticks
// or tildes. The closing fence must use the same character and be at least
// as long as the opening fence.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

const Clean = {
    unsupported: (t) => t.replace(/```\s*\n\s*This block is not supported[^\n]*\n\s*```\s*\n?/g, ''),
    // Exports are archival: emoji and other symbols are conversation content.
    // Only trailing spaces and runs of blank lines in prose are normalized;
    // lines inside fenced code blocks are kept exactly as supplied.
    whitespace: (t) => {
        const lines = t.split('\n');
        const result = [];
        let blanks = 0;
        let fence = null;
        for (const line of lines) {
            const marker = line.match(FENCE)?.[1] || '';
            if (fence) {
                result.push(line);
                if (marker && marker[0] === fence[0] && marker.length >= fence.length &&
                    !line.trim().slice(marker.length).trim()) fence = null;
                continue;
            }
            if (marker && !(marker[0] === '`' && line.trim().slice(marker.length).includes('`'))) {
                fence = marker;
                blanks = 0;
                result.push(line.trimEnd());
                continue;
            }
            const trimmed = line.trimEnd();
            if (!trimmed) {
                if (++blanks <= 1) result.push('');
            } else {
                blanks = 0;
                result.push(trimmed);
            }
        }
        return result.join('\n');
    },
    process: (t) => Clean.whitespace(Clean.unsupported(t || '')).trim()
};

// Choose a fence longer than any backtick run inside the content, so code
// that itself contains ``` cannot terminate the exported block early.
const fenceFor = (content) => {
    const longest = Math.max(0, ...(String(content || '').match(/`+/g) || []).map((run) => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
};

const escapeHTML = (text) => (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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

const compactObject = (obj) => Object.fromEntries(Object.entries(obj).filter(([, value]) => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}));

// Short tool inputs such as {"query": "…"} stay on one line; longer ones are
// indented for reading.
const compactToolInput = (input) => {
    const line = JSON.stringify(input);
    return line.length <= 160 ? line : JSON.stringify(input, null, 2);
};

const Extract = {
    text: (content) => {
        if (!content) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map((b) => {
                if (b.type === 'text') return PLACEHOLDER.test(b.text || '') ? '' : b.text;
                return '';
            }).filter(Boolean).join('\n');
        }
        return '';
    },

    safeJSON: (raw) => {
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed || !/^[{\[]/.test(trimmed)) return null;
        try { return JSON.parse(trimmed); } catch { return null; }
    },

    thinkingBlocks: (content) => {
        if (!Array.isArray(content)) return [];
        return content.filter((b) => b.type === 'thinking').map((b) => b.thinking || b.text || '').filter(Boolean);
    },

    isArtifactTool: (name) => ARTIFACT_TOOLS.some((t) => (name || '').includes(t)),

    artifacts: (content) => {
        if (!Array.isArray(content)) return [];
        return content.filter((b) => b.type === 'tool_use' && Extract.isArtifactTool(b.name)).map((b) => {
            const inp = b.input || {};
            return {
                type: inp.type || inp.language || 'text',
                title: inp.title || inp.name || inp.path?.split('/').pop() || 'Artifact',
                language: inp.language || '',
                content: inp.content || inp.file_text || inp.new_content || ''
            };
        }).filter((a) => a.content);
    },

    toolCall: (block) => {
        if (!block || Extract.isArtifactTool(block.name)) return null;

        const display = block.display_content || {};
        if (display.type === 'json_block' && display.json_block) {
            const parsed = Extract.safeJSON(display.json_block);
            if (parsed && typeof parsed === 'object') {
                const content = typeof parsed.code === 'string' ? parsed.code
                    : typeof parsed.content === 'string' ? parsed.content
                    : JSON.stringify(parsed, null, 2);
                if (content) {
                    return {
                        kind: 'tool_call',
                        tool: block.name || '',
                        title: block.message || display.title || block.name || 'Tool Call',
                        language: parsed.language || '',
                        content
                    };
                }
            }
            return {
                kind: 'tool_call',
                tool: block.name || '',
                title: block.message || display.title || block.name || 'Tool Call',
                language: 'json',
                content: display.json_block
            };
        }

        const inp = block.input || {};
        const content = typeof inp.command === 'string' ? inp.command
            : typeof inp.code === 'string' ? inp.code
            : typeof inp.content === 'string' ? inp.content
            : Object.keys(inp).length ? compactToolInput(inp)
            : '';
        if (!content) return null;

        return {
            kind: 'tool_call',
            tool: block.name || '',
            title: block.message || inp.description || block.name || 'Tool Call',
            language: inp.language || (inp.command ? 'bash' : ''),
            content
        };
    },

    toolResultText: (raw) => {
        const text = typeof raw === 'string' ? raw : '';
        if (!text.trim()) return [];

        const parsed = Extract.safeJSON(text);
        if (parsed && typeof parsed === 'object') {
            const blocks = [];
            if (typeof parsed.stdout === 'string' && parsed.stdout.trim()) {
                blocks.push({ kind: 'tool_result', title: 'Output', language: '', content: parsed.stdout });
            }
            if (typeof parsed.stderr === 'string' && parsed.stderr.trim()) {
                blocks.push({ kind: 'tool_result', title: 'Error Output', language: '', content: parsed.stderr });
            }
            if (!blocks.length && typeof parsed.result === 'string' && parsed.result.trim()) {
                blocks.push({ kind: 'tool_result', title: 'Tool Result', language: '', content: parsed.result });
            }
            if (!blocks.length && typeof parsed.content === 'string' && parsed.content.trim()) {
                blocks.push({ kind: 'tool_result', title: 'Tool Result', language: '', content: parsed.content });
            }
            if (!blocks.length) {
                blocks.push({ kind: 'tool_result', title: 'Tool Result', language: 'json', content: JSON.stringify(parsed, null, 2) });
            }
            return blocks;
        }

        return [{ kind: 'tool_result', title: 'Output', language: '', content: text }];
    },

    toolResults: (block) => {
        if (!block || block.type !== 'tool_result') return [];
        if (typeof block.content === 'string') return Extract.toolResultText(block.content);
        if (!Array.isArray(block.content)) return [];
        return block.content.flatMap((item) => {
            if (typeof item === 'string') return Extract.toolResultText(item);
            if (item?.type === 'text') return Extract.toolResultText(item.text || '');
            return [];
        });
    },

    displayBlocks: (content) => {
        if (!Array.isArray(content)) return [];
        const blocks = [];
        for (const block of content) {
            if (block.type === 'tool_use') {
                if (Extract.isArtifactTool(block.name)) {
                    const artifact = Extract.artifacts([block])[0];
                    if (artifact) {
                        blocks.push({
                            kind: 'artifact',
                            tool: block.name || '',
                            title: artifact.title,
                            language: artifact.language || artifact.type || '',
                            content: artifact.content
                        });
                    }
                    continue;
                }
                const toolCall = Extract.toolCall(block);
                if (toolCall) blocks.push(toolCall);
            }
            if (block.type === 'tool_result') {
                blocks.push(...Extract.toolResults(block));
            }
        }
        return blocks;
    },

    thinking: (msg) => {
        if (typeof msg?.thinking === 'string') return msg.thinking;
        if (msg.metadata?.reasoning_content) return msg.metadata.reasoning_content;
        return Extract.thinkingBlocks(msg.content).join('\n\n');
    }
};

const orderedMappingMessages = (data) => {
    const active = [];
    const seen = new Set();
    let nodeId = data?.current_node || '';
    while (nodeId && data?.mapping?.[nodeId] && !seen.has(nodeId)) {
        seen.add(nodeId);
        const node = data.mapping[nodeId];
        if (node?.message) active.push(node.message);
        nodeId = node?.parent || '';
    }
    if (active.length) return active.reverse();

    // Older/nonstandard payloads may not expose current_node. Preserve a
    // deterministic fallback, but current ChatGPT exports use the active path.
    const nodes = Object.values(data?.mapping || {}).filter((node) => node?.message);
    return nodes
        .sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0))
        .map((node) => node.message);
};

const codeSessionEventPayload = (event) => {
    const value = event?.payload ?? event?.event?.payload ?? event;
    if (typeof value !== 'string') return value;
    return Extract.safeJSON(value) || null;
};

const codeSessionEventSequence = (event) => {
    const payload = codeSessionEventPayload(event);
    const value = event?.sequence_num ?? event?.sequence ?? payload?.sequence_num;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const codeSessionEventTimestamp = (event) => Date.parse(
    event?.created_at || event?.timestamp || codeSessionEventPayload(event)?.timestamp || ''
) || 0;

const codeSessionEventId = (event) => {
    const payload = codeSessionEventPayload(event);
    return String(
        event?.event_id || event?.id || event?.uuid ||
        payload?.uuid || payload?.message?.id || ''
    );
};

const codeSessionMessages = (data) => {
    const events = Array.isArray(data?.code_session_events) ? data.code_session_events
        : Array.isArray(data?.events) && data?._conversation_kind === 'cowork' ? data.events
        : [];
    const seen = new Set();
    const ordered = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => {
            const id = codeSessionEventId(event);
            if (!id || !seen.has(id)) {
                if (id) seen.add(id);
                return true;
            }
            return false;
        })
        .sort((left, right) => {
            const leftSequence = codeSessionEventSequence(left.event);
            const rightSequence = codeSessionEventSequence(right.event);
            if (leftSequence != null && rightSequence != null && leftSequence !== rightSequence) {
                return leftSequence - rightSequence;
            }
            const timeDifference = codeSessionEventTimestamp(left.event) - codeSessionEventTimestamp(right.event);
            return timeDifference || left.index - right.index;
        });

    const messages = [];
    for (const { event } of ordered) {
        const payload = codeSessionEventPayload(event);
        if (!payload || typeof payload !== 'object') continue;
        const eventType = String(payload.type || event?.event_type || event?.type || '').toLowerCase();
        const candidate = payload.message || payload.data?.message ||
            (payload.role && payload.content != null ? payload : null);
        if (!candidate) continue;

        const message = typeof candidate === 'string'
            ? { role: eventType, content: candidate }
            : { ...candidate };
        const role = String(message.role || eventType || '').toLowerCase();
        if (!/^(user|human|assistant|model|system|tool)$/.test(role)) continue;

        message.role = role === 'human' ? 'user' : role === 'model' ? 'assistant' : role;
        message.id = message.id || payload.uuid || codeSessionEventId(event);
        message.uuid = message.uuid || message.id;
        message.created_at = message.created_at || payload.timestamp || event?.created_at || event?.timestamp || null;
        // Keep the envelope reachable for source extraction without flattening
        // protocol bookkeeping into the visible transcript.
        message._code_session_event = payload;
        messages.push(message);
    }
    return messages;
};

// ChatGPT mappings are trees. orderedMappingMessages follows only the active
// branch so regenerations and abandoned branches are not mixed into exports.
const getMessages = (data) => {
    if (Array.isArray(data?.chat_messages)) return data.chat_messages;
    if (Array.isArray(data?.code_session_events) ||
        (Array.isArray(data?.events) && data?._conversation_kind === 'cowork')) {
        return codeSessionMessages(data);
    }
    if (Array.isArray(data?.messages)) return data.messages;
    return data?.mapping ? orderedMappingMessages(data) : [];
};

const grokStepText = (step) => (Array.isArray(step?.text) ? step.text : [step?.text])
    .filter((text) => typeof text === 'string').join('\n\n');

const grokToolStep = (step) => (step?.tags || []).some((tag) =>
    /^(?:tool_usage_card|raw_function_result|tool_result|tool_call)$/.test(tag));

// Adapt both the saved-response API and older message payloads once, at the
// parser entrypoint, so copy, role exports, diff, and every file format use
// exactly the same conversation. Keep API data alongside the readable text.
const prepareGrokConversation = (data = {}) => {
    const conversation = data.conversation || data;
    const responses = data.responses || conversation.responses ||
        data.chat_messages || conversation.messages || data.messages || [];
    const messages = responses.map((response) => {
        const steps = Array.isArray(response.steps) ? response.steps : [];
        const thinking = response.thinking || steps.filter((step) => !grokToolStep(step))
            .map(grokStepText).filter(Boolean).join('\n\n');
        const references = collectStructuredReferences([{ sources: [
            response.sources, response.webSearchResults, response.citedWebSearchResults,
            response.xposts, response.citedXposts, response.ragResults, response.citedRagResults,
            response.connectorSearchResults, response.citedConnectorSearchResults,
            response.collectionSearchResults, response.citedCollectionSearchResults,
            response.searchProductResults,
            ...steps.flatMap((step) => [step.webSearchResults, step.xposts, step.ragResults,
                step.connectorSearchResults, step.collectionSearchResults, step.toolUsageResults])
        ] }]);
        const sources = new Map();
        for (const source of references) {
            const key = source.url || JSON.stringify(source);
            const previous = sources.get(key);
            sources.set(key, previous?.title ? previous : source);
        }
        const queries = new Set(response.search_queries || []);
        for (const step of steps) {
            for (const card of step.toolUsageCards || []) {
                const query = card.webSearch?.args?.query || card.xSearch?.args?.query;
                if (typeof query === 'string' && query.trim()) queries.add(query);
            }
        }
        const attachmentFields = ['attachments', 'fileAttachments', 'fileAttachmentsMetadata',
            'fileAttachmentAssetMetadata', 'imageAttachments', 'generatedImageUrls', 'fileUris', 'fileIds'];
        const attachments = attachmentFields.flatMap((field) =>
            (Array.isArray(response[field]) ? response[field] : []).map((item) => typeof item === 'string'
                ? { type: field, ...(/^https?:\/\//i.test(item) ? { url: item } : { id: item }) }
                : { ...item, type: item.type || field })
        );
        return {
            ...response,
            id: response.responseId || response.id || response.uuid || '',
            role: getRole(response) || (response.isUser ? 'user' : 'assistant'),
            content: typeof response.message === 'string' ? response.message : getText(response),
            created_at: response.createTime || response.created_at || null,
            metadata: typeof response.metadata === 'string'
                ? Extract.safeJSON(response.metadata) || { raw: response.metadata } : response.metadata,
            thinking,
            thinking_source: thinking ? (response.thinking ? 'thinking' : 'steps') : '',
            sources: [...sources.values()],
            search_queries: [...queries],
            attachments
        };
    });
    return {
        ...data,
        id: conversation.conversationId || conversation.id || data.id || '',
        title: conversation.title || data.title || data.name || '',
        created_at: conversation.createTime || data.created_at || null,
        updated_at: conversation.modifyTime || data.updated_at || null,
        chat_messages: messages,
        sources: [...new Map(messages.flatMap((message) => message.sources).map((source) =>
            [source.url || JSON.stringify(source), source])).values()]
    };
};

const grokMessageDetails = (message) => {
    // The answer is emitted as content. Preserve the other API fields (steps,
    // citations, attachments, chunks, partial/stream errors, model metadata).
    const { message: body, content, text, role, sender, ...details } = message;
    return details;
};

const getRole = (m) => {
    const r = m.sender || m.role || m.author?.role || '';
    const content = Array.isArray(m?.content) ? m.content : [];
    if (/human|user/i.test(r) && content.length &&
        content.every((block) => block?.type === 'tool_result')) return 'tool';
    return /human|user/i.test(r) ? 'user' : /assistant|model/i.test(r) ? 'assistant' : r;
};

// ChatGPT reasoning arrives as content.thoughts: [{summary, content}, …]. The
// summary is the visible step header, so keep both rather than the body alone.
const formatThoughts = (thoughts) => (thoughts || []).map((thought) => {
    if (typeof thought === 'string') return thought;
    const summary = String(thought?.summary || '').trim();
    const body = String(thought?.content || '').trim();
    if (summary && body) return `**${summary}**\n\n${body}`;
    return body || summary || '';
}).filter(Boolean).join('\n\n');

const summarizeObjectPart = (value) => {
    if (!value || typeof value !== 'object') return '';
    const contentType = value.content_type || value.type || '';
    if (Array.isArray(value.thoughts)) return formatThoughts(value.thoughts);
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.result === 'string') return value.result;
    if (typeof value.summary === 'string') return value.summary;
    if (typeof value.code === 'string') return value.code;
    if (typeof value.final_expression_output === 'string') return value.final_expression_output;
    if (contentType === 'image_asset_pointer') {
        return `[image ${value.asset_pointer || ''} ${value.width || ''}x${value.height || ''}]`.trim();
    }
    if (Array.isArray(value.parts)) return value.parts.map(summarizeContentPart).filter(Boolean).join('\n');
    if (contentType && Object.keys(value).length <= 4) return `[${contentType}]`;
    return '';
};

const summarizeContentPart = (part) => {
    if (typeof part === 'string') return part;
    return summarizeObjectPart(part);
};

const getText = (m) => {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return Extract.text(m.content);
    if (m.text) return m.text;
    if (m.content?.parts) return m.content.parts.map(summarizeContentPart).filter(Boolean).join('\n');
    return summarizeObjectPart(m.content);
};

const openRouterItemData = (item) => item?.data || item?.item?.data || item || {};

const openRouterItems = (message) => (Array.isArray(message?.items) ? message.items : [])
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
        const leftOrder = left.item?.outputIndex ?? left.item?.sequenceIndex ?? left.index;
        const rightOrder = right.item?.outputIndex ?? right.item?.sequenceIndex ?? right.index;
        return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ item }) => item);

const openRouterTextParts = (value, allowedTypes = null) => {
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value)) return [];
    return value.flatMap((part) => {
        if (typeof part === 'string') return [part];
        if (!part || typeof part !== 'object') return [];
        const type = String(part.type || '');
        if (allowedTypes && type && !allowedTypes.has(type)) return [];
        if (typeof part.text === 'string') return [part.text];
        if (typeof part.content === 'string') return [part.content];
        if (Array.isArray(part.content)) return openRouterTextParts(part.content, allowedTypes);
        return [];
    }).filter(Boolean);
};

const OPENROUTER_OUTPUT_PARTS = new Set(['text', 'input_text', 'output_text', 'refusal']);
const OPENROUTER_REASONING_PARTS = new Set([
    'reasoning_text', 'summary_text', 'reasoning.text', 'reasoning.summary', 'text'
]);

const openRouterOutputText = (data) => {
    if (!data || typeof data !== 'object') return '';
    if (typeof data.output_text === 'string') return data.output_text;
    if (typeof data.text === 'string' && data.type === 'message') return data.text;
    return openRouterTextParts(data.content, OPENROUTER_OUTPUT_PARTS).join('\n\n');
};

const openRouterReasoningText = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const plaintext = openRouterTextParts(value, OPENROUTER_REASONING_PARTS).join('\n\n');
        if (plaintext) return plaintext;
        return value.map(openRouterReasoningText).filter(Boolean).join('\n\n');
    }
    if (!value || typeof value !== 'object') return '';
    if (/encrypted/i.test(String(value.type || ''))) return '';

    const content = openRouterTextParts(value.content, OPENROUTER_REASONING_PARTS).join('\n\n');
    if (content) return content;
    if (typeof value.reasoning === 'string') return value.reasoning;
    if (typeof value.text === 'string') return value.text;
    const details = openRouterReasoningText(value.reasoning_details || value.details);
    if (details) return details;
    const summary = openRouterTextParts(value.summary, OPENROUTER_REASONING_PARTS).join('\n\n');
    if (summary) return summary;
    if (typeof value.summary === 'string') return value.summary;
    return '';
};

const openRouterToolBlock = (data) => {
    if (!data || typeof data !== 'object') return null;
    const type = String(data.type || '');
    if (!type || type === 'message' || type === 'reasoning') return null;
    if (/image_generation/.test(type)) {
        const result = data.result || data.output || data.url || '';
        const content = typeof result === 'string' ? result : safeStringify(result);
        return content ? {
            kind: 'artifact',
            tool: type,
            title: 'Generated Image',
            language: '',
            content
        } : null;
    }

    const isResult = /(?:output|result|completed|failed|error)/i.test(type);
    const name = String(data.name || data.tool_name || data.server_label || type);
    let payload = data.arguments ?? data.input ?? data.output ?? data.result ??
        data.content ?? data.error ?? data;
    if (typeof payload !== 'string') payload = safeStringify(payload);
    payload = String(payload || '').trim();
    if (!payload) return null;
    return {
        kind: isResult ? 'tool_result' : 'tool_call',
        tool: name,
        title: `${isResult ? 'Tool Result' : 'Tool Call'} ${isResult ? '←' : '→'} ${name}`,
        language: typeof (data.arguments ?? data.input ?? data.output ?? data.result) === 'object' ? 'json' : '',
        content: payload
    };
};

const comparableText = (text) => Clean.process(String(text || '')).toLowerCase().replace(/\s+/g, ' ').trim();

const isWrapperDuplicate = (outerKey, innerKey) =>
    innerKey.length > 80 &&
    outerKey.length > innerKey.length * 1.25 &&
    outerKey.includes(innerKey);

const dedupeComparable = (items) => {
    const seen = new Set();
    const unique = [];
    for (const item of items) {
        const key = comparableText(item.text || item.content || item.preview || '');
        if (!key || seen.has(key)) continue;
        if (unique.some((existing) => isWrapperDuplicate(key, existing.key))) continue;
        seen.add(key);
        unique.push(Object.assign({}, item, { key }));
    }
    return unique;
};

const Normalize = {
    textBlock: (text) => {
        const value = Clean.process(text || '');
        return value ? { kind: 'text', text: value } : null;
    },

    thinkingBlock: (text) => {
        const value = Clean.process(text || '');
        return value ? { kind: 'thinking', text: value } : null;
    },

    artifactBlock: (artifact) => artifact?.content ? {
        kind: 'artifact',
        title: artifact.title || '',
        language: artifact.language || artifact.type || '',
        content: artifact.content.replace(/\n+$/, '')
    } : null,

    displayBlock: (block) => block?.content ? {
        kind: block.kind,
        tool: block.tool || '',
        title: block.title || '',
        language: block.language || '',
        content: String(block.content || '').replace(/\n+$/, '')
    } : null,

    claudeMessage: (message, index) => {
        const blocks = [];
        const contentBlocks = Array.isArray(message.content) ? message.content
            : typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
            : [];
        for (const block of contentBlocks) {
            if (block.type === 'text') {
                const textBlock = Normalize.textBlock(block.text || '');
                if (textBlock) blocks.push(textBlock);
                continue;
            }
            if (block.type === 'thinking') {
                const thinkingBlock = Normalize.thinkingBlock(block.thinking || block.text || '');
                if (thinkingBlock) blocks.push(thinkingBlock);
                continue;
            }
            if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'tool_result') {
                const displayInput = block.type === 'server_tool_use' ? { ...block, type: 'tool_use' } : block;
                for (const displayBlock of Extract.displayBlocks([displayInput]).map(Normalize.displayBlock).filter(Boolean)) {
                    blocks.push(displayBlock);
                }
            }
        }
        if (!blocks.length) {
            const textBlock = Normalize.textBlock(message.text || '');
            if (textBlock) blocks.push(textBlock);
        }
        return {
            index,
            id: message.uuid || message.id || '',
            role: getRole(message),
            blocks
        };
    },

    // web.run returns its hits in metadata.search_result_groups with empty
    // content parts, so the sources are only recoverable from metadata.
    searchResultBlocks: (message) => {
        const groups = message?.metadata?.search_result_groups || [];
        const lines = [];
        for (const group of groups) {
            if (group?.domain) lines.push(`# ${group.domain}`);
            for (const entry of group?.entries || []) {
                const title = String(entry?.title || entry?.url || '').trim();
                if (title) lines.push(`- ${title}`);
                if (entry?.url) lines.push(`  ${entry.url}`);
                const snippet = String(entry?.snippet || '').trim().replace(/\s+/g, ' ');
                if (snippet) lines.push(`  ${snippet}`);
            }
        }
        if (!lines.length) return [];
        return [{
            kind: 'tool_result',
            tool: 'web.run',
            title: 'Search Results',
            language: '',
            content: lines.join('\n')
        }];
    },

    chatgptMessage: (message, index) => {
        const blocks = [];
        const role = getRole(message);
        const content = message?.content || {};
        const contentType = content.content_type || '';
        const recipient = message?.recipient || '';
        const channel = messageChannel(message);

        if (channel === 'reasoning') {
            const thinkingBlock = Normalize.thinkingBlock(getText(message));
            if (thinkingBlock) blocks.push(thinkingBlock);
        } else if (channel === 'tool_call') {
            const value = Clean.process(String(content.text || getText(message)));
            if (value) blocks.push({
                kind: 'tool_call',
                tool: recipient || 'tool',
                title: recipient ? `Tool Call → ${recipient}` : 'Tool Call',
                language: content.language && content.language !== 'unknown' ? content.language : '',
                content: value
            });
        } else if (channel === 'tool_result') {
            const name = message?.author?.name || '';
            const value = Clean.process(getText(message));
            if (value) blocks.push({
                kind: 'tool_result',
                tool: name,
                title: name ? `Tool Result ← ${name}` : 'Tool Result',
                language: contentType === 'execution_output' ? '' : '',
                content: value
            });
        } else {
            const textBlock = Normalize.textBlock(getText(message));
            if (textBlock) blocks.push(textBlock);
        }

        for (const artifact of Extract.artifacts(message.content)) {
            const artifactBlock = Normalize.artifactBlock(artifact);
            if (artifactBlock) blocks.push(artifactBlock);
        }
        // web.run rows carry their hits only in metadata, with empty content
        // parts. Attach them solely to rows that produced nothing themselves —
        // the final answer also carries the run's accumulated
        // search_result_groups, and folding those in would pad the answer with
        // hundreds of repeated citations. The deduped set lives in the appendix.
        if (!blocks.length) blocks.push(...Normalize.searchResultBlocks(message));

        return {
            index,
            id: message.id || message.uuid || '',
            role,
            channel,
            blocks
        };
    },

    openrouterMessage: (message, index) => {
        const blocks = [];
        let hasOutput = false;
        let hasReasoning = false;
        const pushUnique = (block) => {
            if (!block) return;
            const value = block.text || block.content || '';
            const key = `${block.kind}:${comparableText(value)}`;
            if (!value || blocks.some((existing) =>
                `${existing.kind}:${comparableText(existing.text || existing.content || '')}` === key)) return;
            blocks.push(block);
        };

        for (const item of openRouterItems(message)) {
            const data = openRouterItemData(item);
            const type = String(data?.type || item?.type || '');
            if (type === 'reasoning' || /^reasoning[.:]/.test(type)) {
                const text = openRouterReasoningText(data);
                if (text) {
                    hasReasoning = true;
                    pushUnique(Normalize.thinkingBlock(text));
                }
                continue;
            }
            if (type === 'message' || /^(?:input_text|output_text)$/.test(type)) {
                const text = type === 'message' ? openRouterOutputText(data)
                    : String(data.text || data.content || '');
                if (text) {
                    hasOutput = true;
                    pushUnique(Normalize.textBlock(text));
                }
                continue;
            }
            pushUnique(openRouterToolBlock(data));
        }

        if (!hasOutput) {
            const legacyOutput = getText(message);
            if (legacyOutput) pushUnique(Normalize.textBlock(legacyOutput));
        }
        if (!hasReasoning) {
            const legacyReasoning = openRouterReasoningText(
                message?.reasoning_details || message?.reasoning || message?.metadata?.reasoning_details
            );
            if (legacyReasoning) pushUnique(Normalize.thinkingBlock(legacyReasoning));
        }

        return {
            index,
            id: message.id || message.uuid || '',
            role: getRole(message),
            name: message.name || '',
            model: message.model || message?.metadata?.variantSlug || '',
            blocks
        };
    },

    grokMessage: (message, index) => {
        const blocks = [];
        const add = (block) => { if (block) blocks.push(block); };
        if (message.thinking_source !== 'steps') add(Normalize.thinkingBlock(message.thinking));
        for (const step of message.steps || []) {
            const text = grokStepText(step);
            const cards = step.toolUsageCards || [];
            if (cards.length) {
                for (const card of cards) {
                    for (const [tool, value] of Object.entries(card)) {
                        if (tool === 'toolUsageCardId') continue;
                        add({ kind: 'tool_call', id: card.toolUsageCardId || '', tool, title: tool, language: 'json',
                            content: JSON.stringify(value, null, 2) });
                    }
                }
            } else if (text) {
                if (grokToolStep(step)) {
                    const kind = (step.tags || []).includes('tool_usage_card') ? 'tool_call' : 'tool_result';
                    add({ kind, title: kind === 'tool_call' ? 'Tool Call' : 'Tool Result',
                        language: text.includes('<xai:') ? 'xml' : '', content: text });
                } else add(Normalize.thinkingBlock(text));
            }
            for (const result of step.toolUsageResults || []) {
                add({ kind: 'tool_result', id: result.toolUsageCardId || '', title: 'Tool Result', language: 'json',
                    content: JSON.stringify(result, null, 2) });
            }
        }
        for (const result of message.toolResponses || []) {
            add({ kind: 'tool_result', title: 'Tool Result', language: typeof result === 'string' ? '' : 'json',
                content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) });
        }
        add(Normalize.textBlock(getText(message)));
        if (message.attachments?.length) {
            add({ kind: 'attachment', title: 'Attachments', language: 'json',
                content: JSON.stringify(message.attachments, null, 2) });
        }
        return { index, id: message.id || '', role: getRole(message), model: message.model || '', blocks };
    },

    genericMessage: (message, index) => {
        const blocks = [];
        const thinkingBlock = Normalize.thinkingBlock(Extract.thinking(message));
        if (thinkingBlock) blocks.push(thinkingBlock);
        const textBlock = Normalize.textBlock(getText(message));
        if (textBlock) blocks.push(textBlock);
        for (const artifact of Extract.artifacts(message.content)) {
            const artifactBlock = Normalize.artifactBlock(artifact);
            if (artifactBlock) blocks.push(artifactBlock);
        }
        return {
            index,
            id: message.uuid || message.id || '',
            role: getRole(message),
            blocks
        };
    }
};

// ChatGPT stores reasoning, tool calls and tool output as distinct message
// rows rather than content blocks, so it needs its own normalizer to turn them
// into typed blocks instead of flattening everything to plain text.
const normalizeForPlatform = (platform, message, index) => {
    if (platform === 'claude') return Normalize.claudeMessage(message, index);
    if (platform === 'chatgpt') return Normalize.chatgptMessage(message, index);
    if (platform === 'openrouter') return Normalize.openrouterMessage(message, index);
    if (platform === 'grok') return Normalize.grokMessage(message, index);
    return Normalize.genericMessage(message, index);
};

const normalizeConversation = (platform, data) => {
    const messages = getMessages(data).map((message, index) =>
        normalizeForPlatform(platform, message, index)
    );

    return {
        version: 1,
        platform,
        id: data?.uuid || data?.id || '',
        title: data?.name || data?.title || '',
        generated_at: new Date().toISOString(),
        message_count: messages.length,
        messages
    };
};

const hasUsableMessages = (data) => getMessages(data).some((message) =>
    Normalize.genericMessage(message, 0).blocks.length || Clean.process(getText(message)).length
);

const renderMarkdownBlock = (block) => {
    const lines = [];
    if (block.title) lines.push(`### ${block.title}\n`);
    const content = (block.content || '').replace(/\n+$/, '');
    const fence = fenceFor(content);
    lines.push(fence + (block.language || '') + '\n' + content + '\n' + fence + '\n');
    return lines.join('');
};

const renderMarkdownExportBlock = (block) => {
    if (block.kind === 'text') return block.text ? block.text + '\n' : '';
    if (block.kind === 'thinking') return block.text ? `<think>\n${Clean.process(block.text)}\n</think>\n` : '';
    return renderMarkdownBlock(block);
};

const renderHTMLBlock = (block) => {
    const cls = block.kind === 'artifact' ? 'artifact' : (block.kind === 'tool_result' ? 'tool-result' : 'tool-call');
    const title = block.title ? `<div class="block-title">${escapeHTML(block.title)}</div>` : '';
    return `<div class="${cls}">${title}<pre>${escapeHTML(block.content || '')}</pre></div>`;
};

const renderHTMLExportBlock = (block) => {
    if (block.kind === 'text') return `<pre>${escapeHTML(block.text || '')}</pre>`;
    if (block.kind === 'thinking') return `<div class="thinking"><div class="block-title">Thinking</div><pre>${escapeHTML(block.text || '')}</pre></div>`;
    return renderHTMLBlock(block);
};

const roleLabel = (role) => role === 'user' ? 'User'
    : role === 'tool' ? 'Tool'
    : role === 'system' ? 'System'
    : 'Assistant';

// Reasoning and tool traffic stay in the transcript; the heading says which is
// which so a reader can tell an answer from the work that produced it.
const turnLabel = (role, channel) => {
    if (channel === 'reasoning') return 'Assistant · Reasoning';
    if (channel === 'tool_call') return 'Assistant · Tool Call';
    if (channel === 'tool_result') return 'Tool · Result';
    return roleLabel(role);
};

const CleanJSON = {
    claude: (data) => {
        const clean = {
            uuid: data.uuid, name: data.name, model: data.model,
            created_at: data.created_at, updated_at: data.updated_at,
            summary: data.summary, block_model_version: 1, messages: []
        };
        if (data.settings) {
            clean.settings = {
                web_search: data.settings.enabled_web_search,
                artifacts: data.settings.preview_feature_uses_artifacts
            };
            // Full MCP tool inventory with enabled state — not a filter.
            const mcpEntries = Object.entries(data.settings.enabled_mcp_tools || {});
            if (mcpEntries.length) {
                clean.settings.mcp_tools = mcpEntries.map(([name, enabled]) => ({
                    name,
                    enabled: !!enabled
                }));
            }
        }
        // Keep every message — even empty rows often carry tool I/O or
        // sources that the user wants visible.
        for (const m of getMessages(data)) {
            const msg = {
                role: getRole(m),
                content: Clean.process(Extract.text(m.content) || m.text || '')
            };
            const blocks = Normalize.claudeMessage(m, clean.messages.length).blocks;
            if (blocks.length) msg.blocks = blocks;
            const artifacts = Extract.artifacts(m.content);
            if (artifacts.length) msg.artifacts = artifacts;
            const displayBlocks = Extract.displayBlocks(m.content).filter((block) => block.kind !== 'artifact');
            if (displayBlocks.length) msg.display_blocks = displayBlocks;
            const thinking = Extract.thinking(m);
            if (thinking) msg.thinking = Clean.process(thinking);
            clean.messages.push(msg);
        }
        return clean;
    },
    chatgpt: (data) => {
        const clean = {
            id: data.conversation_id || data.id,
            title: data.title,
            model: data.default_model_slug,
            conversation_template_id: data.conversation_template_id || null,
            gizmo_id: data.gizmo_id || null,
            created_at: data.create_time || null,
            updated_at: data.update_time || null,
            safe_urls: data.safe_urls || [],
            blocked_urls: data.blocked_urls || [],
            block_model_version: 1,
            messages: []
        };
        // Full fidelity: every active-branch message, with its reasoning, tool
        // channel, blocks and raw metadata preserved.
        for (const { message: m, role, channel, hidden } of selectConversationEntries(data).entries) {
            const msg = {
                role,
                channel,
                name: m?.author?.name || '',
                recipient: m?.recipient || '',
                content_type: m?.content?.content_type || '',
                content: Clean.process(getText(m))
            };
            if (hidden) msg.hidden_in_ui = true;
            const blocks = Normalize.chatgptMessage(m, clean.messages.length).blocks;
            if (blocks.length) msg.blocks = blocks;
            if (m?.metadata?.reasoning_content) msg.thinking = Clean.process(m.metadata.reasoning_content);
            if (m?.metadata && Object.keys(m.metadata).length) msg.metadata = m.metadata;
            clean.messages.push(msg);
        }
        return clean;
    },
    openrouter: (data) => ({
        id: data.id || data.uuid,
        title: data.title || data.name,
        model: data.model || '',
        created_at: data.created_at || null,
        updated_at: data.updated_at || null,
        source: data._source || 'indexeddb',
        schema: data._schema || 'orpg.3.0',
        block_model_version: 1,
        messages: getMessages(data).map((message, index) => {
            const normalized = Normalize.openrouterMessage(message, index);
            const output = normalized.blocks
                .filter((block) => block.kind === 'text')
                .map((block) => block.text).filter(Boolean).join('\n\n');
            const reasoning = normalized.blocks
                .filter((block) => block.kind === 'thinking')
                .map((block) => block.text).filter(Boolean).join('\n\n');
            return compactObject({
                id: message.id || '',
                role: normalized.role,
                name: normalized.name,
                model: normalized.model,
                content: output,
                reasoning,
                blocks: normalized.blocks,
                created_at: message.createdAt || message.created_at || null,
                metadata: message.metadata || null
            });
        })
    }),
    grok: (data) => {
        return {
            id: data.id,
            title: data.title,
            created_at: data.created_at,
            updated_at: data.updated_at,
            source: data._source || 'api',
            selected_response_id: data._selected_response_id,
            metadata_error: data._metadata_error || undefined,
            block_model_version: 1,
            messages: getMessages(data).map((message, index) => compactObject({
                ...grokMessageDetails(message),
                role: getRole(message),
                content: Clean.process(getText(message)),
                thinking: Clean.process(message.thinking),
                blocks: Normalize.grokMessage(message, index).blocks
            }))
        };
    },
    google: (data) => ({
        title: data.name || '',
        source: data._source,
        block_model_version: 1,
        messages: (data.messages || []).map((m, index) => {
            const msg = { role: m.role, content: Clean.process(m.content || '') };
            const thinking = Extract.thinking(m);
            if (thinking) msg.thinking = Clean.process(thinking);
            if (Array.isArray(m.search_queries) && m.search_queries.length) msg.search_queries = m.search_queries;
            if (Array.isArray(m.sources) && m.sources.length) msg.sources = m.sources;
            const blocks = Normalize.genericMessage(m, index).blocks;
            if (blocks.length) msg.blocks = blocks;
            return msg;
        })
    }),
    domConversation: (data) => ({
        title: data.title || data.name || '',
        source: data._source || 'dom',
        block_model_version: 1,
        messages: (data.messages || []).map((message, index) => {
            const msg = {
                role: message.role || (index % 2 === 0 ? 'user' : 'assistant'),
                content: Clean.process(message.content || '')
            };
            const blocks = Normalize.genericMessage(message, index).blocks;
            if (blocks.length) msg.blocks = blocks;
            return msg;
        })
    })
};

const exportMetadataBlocks = (platform, message) => {
    if (platform !== 'chatgpt') return [];
    const metadata = message?.metadata || {};
    if (!metadata || !Object.keys(metadata).length) return [];
    return [{
        kind: 'metadata',
        title: 'Message Metadata',
        language: 'json',
        content: JSON.stringify(metadata, null, 2)
    }];
};

const exportBlocksForMessage = (platform, message, index) =>
    normalizeForPlatform(platform, message, index).blocks.concat(exportMetadataBlocks(platform, message));

const plainBlocksForMessage = (platform, message, index) =>
    normalizeForPlatform(platform, message, index).blocks;

const compactMessageMeta = (message) => compactObject({
    id: message?.uuid || message?.id || '',
    name: message?.author?.name || message?.name || '',
    create_time: message?.create_time || message?.created_at || null,
    update_time: message?.update_time || message?.updated_at || null,
    status: message?.status || '',
    recipient: message?.recipient || '',
    channel: message?.channel || '',
    metadata: message?.metadata || null
});

const compactAttachment = (attachment) => compactObject({
    id: String(attachment.id || attachment.file_id || ''),
    library_file_id: String(attachment.library_file_id || ''),
    name: String(attachment.name || attachment.file_name || ''),
    mime_type: String(attachment.mime_type || attachment.mimeType || ''),
    size: attachment.size || attachment.file_size_bytes || attachment.file_size || null
});

const referenceString = (value) => typeof value === 'string' ? value.trim() : '';
const referenceURL = (value) => {
    const url = referenceString(value);
    return /^https?:\/\//i.test(url) ? url : '';
};

const compactReference = (ref) => {
    ref = ref || {};
    const source = referenceString(ref.source);
    const url = referenceURL(ref.url) || referenceURL(ref.source_url) ||
        referenceURL(ref.href) || referenceURL(ref.link) || referenceURL(source);
    return compactObject({
        type: referenceString(ref.type || ref.ref_type),
        title: referenceString(ref.title || ref.name || ref.document_title || ref.page_title),
        url,
        attribution: referenceString(ref.attribution || ref.domain || ref.site_name) ||
            (source && !referenceURL(source) ? source : ''),
        id: referenceString(ref.id || ref.file_id || ref.document_id || ref.source_id) ||
            (source && !referenceURL(source) ? source : '')
    });
};

const REFERENCE_CONTAINER = /(?:citation|reference|sources?|search_results?|web_search|web_fetch)/i;
const DIRECT_REFERENCE_TYPE = /^(?:citation|web_search_result_location|search_result|web_search_result|web_fetch_result|document_location|page_location|char_location|content_block_location)$/i;

// Claude puts source data inside content blocks rather than ChatGPT-style
// message metadata. Walk only source-bearing subtrees and retain the public
// URL/title pair while deliberately ignoring encrypted result payloads.
// Search results carry site icons next to their links. Icons are not sources.
const IMAGE_FIELD = /^(?:favicon|favicon_url|favicons|icon|icon_url|logo|logo_url|image|image_url|thumbnail|thumbnail_url)$/i;
const FAVICON_URL = /\/s2\/favicons\b|\/favicon(?:\.ico|s?\b)/i;

const collectStructuredReferences = (roots) => {
    const references = [];
    const seen = new WeakSet();
    let visited = 0;

    const visit = (value, sourceContext = false, depth = 0) => {
        if (value == null || depth > 14 || visited >= 30000) return;
        if (typeof value === 'string') {
            const parsed = sourceContext && value.length <= 2 * 1024 * 1024
                ? Extract.safeJSON(value) : null;
            if (parsed && typeof parsed === 'object') {
                visit(parsed, true, depth + 1);
                return;
            }
            if (sourceContext && referenceURL(value) && !FAVICON_URL.test(value)) {
                references.push(compactReference({ type: 'source', url: value }));
            }
            return;
        }
        if (typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        visited += 1;

        if (Array.isArray(value)) {
            for (const item of value) visit(item, sourceContext, depth + 1);
            return;
        }

        const type = referenceString(value.type || value.ref_type);
        const name = referenceString(value.name || value.tool_name);
        const directReference = DIRECT_REFERENCE_TYPE.test(type);
        const relevantObject = sourceContext || directReference ||
            /(?:web_search|web_fetch)/i.test(name);
        const candidate = compactReference(value);
        if ((relevantObject && candidate.url) ||
            (directReference && (candidate.id || candidate.attribution))) {
            references.push(candidate);
        }

        for (const [key, child] of Object.entries(value)) {
            if (key === 'encrypted_content' || key === 'cited_text' || IMAGE_FIELD.test(key)) continue;
            const childContext = relevantObject || REFERENCE_CONTAINER.test(key);
            visit(child, childContext, depth + 1);
        }
    };

    for (const root of roots || []) visit(root);
    return references.filter((item) => Object.keys(item).length);
};

const collectMessageContext = (message, platform) => {
    const metadata = message?.metadata || {};
    const references = (metadata.citations || [])
        .concat(metadata.content_references || [])
        .map(compactReference)
        .filter((item) => Object.keys(item).length);

    const searchSources = (metadata.search_result_groups || []).flatMap((group) =>
        (group.entries || []).map((entry) => compactReference({
            type: entry.type || group.type || 'search_result',
            title: entry.title,
            url: entry.url,
            attribution: entry.attribution || group.domain
        }))
    ).filter((item) => Object.keys(item).length);

    const claudeSources = collectStructuredReferences([
        message?.content,
        { citations: message?.citations },
        { references: message?.references },
        { sources: message?.sources },
        message?._code_session_event
    ]);
    const attachments = (metadata.attachments || [])
        .concat(message?.attachments || [])
        .concat(message?.files || []);

    return compactObject({
        attachments: attachments.map((attachment) => platform === 'grok'
            ? compactObject({ ...attachment, ...compactAttachment(attachment) })
            : compactAttachment(attachment)).filter((item) => Object.keys(item).length),
        references: references.concat(searchSources, claudeSources)
    });
};

const collectSearchQueries = (data) => {
    const queries = [];
    const seen = new Set();
    const add = (value) => {
        const query = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
        const key = query.toLowerCase();
        if (!query || seen.has(key)) return;
        seen.add(key);
        queries.push(query);
    };
    for (const query of Array.isArray(data?.search_queries) ? data.search_queries : []) add(query);
    for (const message of getMessages(data)) {
        for (const query of Array.isArray(message?.search_queries) ? message.search_queries : []) add(query);
    }
    return queries;
};

// Zero counts are omitted: an absent count means zero.
const nonZero = (obj) => Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== 0));

const compactResources = (raw) => compactObject(nonZero({
    safe_url_count: Array.isArray(raw?.safe_urls) ? raw.safe_urls.length : 0,
    safe_urls: Array.isArray(raw?.safe_urls) ? raw.safe_urls.map((url) => String(url)) : [],
    blocked_url_count: Array.isArray(raw?.blocked_urls) ? raw.blocked_urls.length : 0,
    blocked_urls: Array.isArray(raw?.blocked_urls) ? raw.blocked_urls.map((url) => String(url)) : [],
    conversation_template_id: raw?.conversation_template_id || '',
    gizmo_id: raw?.gizmo_id || '',
    gizmo_type: raw?.gizmo_type || '',
    project_uuid: raw?.project_uuid || '',
    conversation_kind: raw?._conversation_kind || '',
    environment_kind: raw?.environment_kind || raw?.code_session?.environment_kind || '',
    session_status: raw?.status || raw?.code_session?.status || '',
    source_count: Array.isArray(raw?.sources) ? raw.sources.length
        : Array.isArray(raw?.config?.sources) ? raw.config.sources.length
        : Array.isArray(raw?.code_session?.config?.sources) ? raw.code_session.config.sources.length
            : 0
}));

const compactToolName = (value) => String(value || '').trim();

const collectToolActivity = (platform, data) => {
    const messages = getMessages(data);
    const items = [];
    for (const [index, message] of messages.entries()) {
        const role = getRole(message);
        const metadata = message?.metadata || {};
        const contentBlocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of contentBlocks) {
            if (!/^(?:tool_use|server_tool_use|tool_result|web_search_tool_result|web_fetch_tool_result)$/.test(block?.type || '')) continue;
            items.push(compactObject({
                message_index: index,
                role,
                kind: /^(?:tool_use|server_tool_use)$/.test(block.type) ? 'tool_call' : 'tool_result',
                tool: compactToolName(block.name || message?.recipient || message?.author?.name),
                title: String(block.message || block.name || '')
            }));
        }

        if (platform === 'openrouter' || platform === 'grok') {
            for (const block of normalizeForPlatform(platform, message, index).blocks) {
                if (block.kind !== 'tool_call' && block.kind !== 'tool_result') continue;
                items.push(compactObject({
                    message_index: index,
                    role,
                    kind: block.kind,
                    ...(platform === 'grok' ? { tool_call_id: block.id || '' } : {}),
                    tool: compactToolName(block.tool),
                    title: block.title || ''
                }));
            }
        }

        if (role === 'tool' || message?.recipient || metadata.aggregate_result) {
            items.push(compactObject({
                message_index: index,
                role,
                kind: role === 'tool' ? 'tool_message' : 'tool_metadata',
                tool: compactToolName(message?.recipient || message?.author?.name || metadata.invoked_plugin?.namespace || metadata.invoked_plugin?.name),
                title: metadata.message_type || metadata.aggregate_result?.type || ''
            }));
        }
    }

    const unique = [];
    const seen = new Set();
    for (const item of items) {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }

    const byName = {};
    for (const item of unique) {
        const name = item.tool || item.title || item.kind || 'tool';
        byName[name] = (byName[name] || 0) + 1;
    }

    return compactObject({
        total: unique.length,
        calls: unique.filter((item) => item.kind === 'tool_call').length,
        results: unique.filter((item) => item.kind === 'tool_result' || item.kind === 'tool_message').length,
        names: Object.keys(byName),
        by_name: byName,
        items: unique
    });
};

// Exports keep every message on the active branch, with reasoning and tool
// traffic labelled by channel rather than dropped.
const LLM_ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const REASONING_CONTENT_TYPES = new Set(['thoughts', 'reasoning_recap']);

// Exports keep all content and remove repetition only: a long tool output
// identical to an earlier one becomes a one-line reference.
const MIN_REPEATED_OUTPUT_CHARS = 200;

const createDedupeFilter = () => {
    const seen = new Set();
    let repeated = 0;
    const apply = (kind, value) => {
        const text = String(value || '');
        if (kind !== 'tool_result' || text.length < MIN_REPEATED_OUTPUT_CHARS) return text;
        if (seen.has(text)) {
            repeated += 1;
            return '[Same output as an earlier tool result.]';
        }
        seen.add(text);
        return text;
    };
    return { apply, get repeated() { return repeated; } };
};

// A source whose link already appears in the exported conversation is not
// listed again.
const notInBody = (body) => (item) => !item.url || !body.includes(item.url);

// Every message on the active branch is history. Branch selection still happens
// in orderedMappingMessages, which follows current_node so abandoned
// regenerations are not interleaved with the conversation that actually ran.
const isVisibleConversationMessage = (message) => LLM_ALLOWED_ROLES.has(getRole(message));

// Classifies a message rather than filtering it, so consumers can style or fold
// reasoning and tool traffic while the content itself is always present.
const messageChannel = (message) => {
    const role = getRole(message);
    const contentType = message?.content?.content_type || '';
    const contentBlocks = Array.isArray(message?.content) ? message.content : [];
    if (REASONING_CONTENT_TYPES.has(contentType)) return 'reasoning';
    if (role === 'tool' || contentType === 'execution_output' ||
        (contentBlocks.length && contentBlocks.every((block) =>
            /^(?:tool_result|web_search_tool_result|web_fetch_tool_result)$/.test(block?.type || '')))) {
        return 'tool_result';
    }
    const recipient = message?.recipient || '';
    const hasText = contentBlocks.some((block) => block?.type === 'text' && String(block.text || '').trim());
    if (role === 'assistant' && !hasText && contentBlocks.length &&
        contentBlocks.every((block) => /^(?:thinking|redacted_thinking)$/.test(block?.type || ''))) {
        return 'reasoning';
    }
    if (role === 'assistant' && (contentType === 'code' || (recipient && recipient !== 'all') ||
        (!hasText && contentBlocks.some((block) => /^(?:tool_use|server_tool_use)$/.test(block?.type || ''))))) {
        return 'tool_call';
    }
    return 'final';
};

const selectConversationEntries = (data) => {
    const entries = [];
    for (const [index, message] of getMessages(data).entries()) {
        if (!isVisibleConversationMessage(message)) continue;
        entries.push({
            index,
            message,
            role: getRole(message),
            channel: messageChannel(message),
            hidden: !!message?.metadata?.is_visually_hidden_from_conversation
        });
    }
    // Consecutive assistant rows are all kept; collapsing them to the last
    // one once silently discarded earlier answers.
    return { entries };
};

const compactToolSummary = (tools) => tools ? compactObject({
    total: tools.total || 0,
    calls: tools.calls || 0,
    results: tools.results || 0,
    names: tools.names || [],
    by_name: tools.by_name || {},
    items: tools.items || []
}) : null;

const hostnameOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
};

// Attribution equal to the link's own domain is derivable from the URL and
// omitted; entries with no title, link, or id carry nothing and are dropped.
const compactLLMReference = (item) => compactObject({
    type: item.type === 'source' ? '' : item.type || '',
    title: item.title || '',
    url: item.url || '',
    attribution: item.attribution && item.attribution.replace(/^www\./, '') !== hostnameOf(item.url) ? item.attribution : '',
    id: item.id || ''
});
const usefulReference = (item) => !!(item.title || item.url || item.id);

// Scoped exports (`role` = 'user' or 'assistant') keep only that role's turns.
// They omit the conversation-wide appendix, as the Markdown role export does,
// so a user-only file does not carry the assistant's sources or tool activity.
const exportScope = (role) => (role === 'user' || role === 'assistant') ? role : '';

// Raw Grok response fields whose content is already exported through a
// normalized field (id, created_at, content, thinking, blocks, sources,
// search_queries, attachments).
const GROK_DUPLICATE_FIELDS = new Set(['responseId', 'createTime', 'thinking_source', 'thinking', 'steps',
    'webSearchResults', 'citedWebSearchResults', 'xposts', 'citedXposts', 'ragResults', 'citedRagResults',
    'connectorSearchResults', 'citedConnectorSearchResults', 'collectionSearchResults',
    'citedCollectionSearchResults', 'searchProductResults', 'toolResponses', 'fileAttachments',
    'fileAttachmentsMetadata', 'fileAttachmentAssetMetadata', 'imageAttachments', 'generatedImageUrls',
    'fileUris', 'fileIds']);

const toLLMJSON = (platform, raw, clean, fallbackTitle, fallbackId, role = '') => {
    const scope = exportScope(role);
    const filter = createDedupeFilter();
    const sourceMessages = getMessages(raw);
    const mappingMessageCount = raw?.mapping
        ? Object.values(raw.mapping).filter((node) => node?.message).length
        : sourceMessages.length;
    const messages = [];
    const omittedByRole = {};
    const byChannel = {};
    let omittedEmpty = 0;
    let omittedForScope = 0;

    for (const message of sourceMessages) {
        const role = getRole(message);
        if (!LLM_ALLOWED_ROLES.has(role)) {
            omittedByRole[role || 'unknown'] = (omittedByRole[role || 'unknown'] || 0) + 1;
        }
    }

    const selected = selectConversationEntries(raw);
    for (const { index, message, role, channel, hidden } of selected.entries) {
        if (scope && role !== scope) {
            omittedForScope += 1;
            continue;
        }
        const text = Clean.process(getText(message));
        const normalizedBlocks = plainBlocksForMessage(platform, message, index);
        const textOf = (kind) => normalizedBlocks.filter((block) => block.kind === kind)
            .map((block) => block.text).filter(Boolean).join('\n\n');
        const blockText = textOf('text');
        const reasoningText = platform === 'grok' ? Clean.process(message.thinking) : textOf('thinking');
        // Only rows with no content of their own (web.run search hits) fall back
        // to metadata; see Normalize.chatgptMessage for why this is not applied
        // to the final answer.
        const searchBlocks = !text && platform === 'chatgpt' ? Normalize.searchResultBlocks(message) : [];
        const baseContent = platform === 'openrouter' ? blockText
            : text || searchBlocks.map((block) => block.content).join('\n\n') || blockText;
        let content = baseContent;
        // ChatGPT reasoning rows hold the reasoning as their text; keep it once.
        const thinking = reasoningText && reasoningText !== baseContent ? reasoningText : '';
        // ChatGPT stores each tool call/result as its own row; its text is the
        // tool traffic, so repeated tool output is checked here too.
        if (channel === 'tool_result' || channel === 'tool_call') content = filter.apply(channel, content);
        // Non-text blocks (tool calls, tool results, artifacts, attachments)
        // carry what the text omits. Text and reasoning are already exported
        // as content and thinking, and a block equal to the content is not
        // repeated.
        const blocks = normalizedBlocks
            .filter((block) => block.kind !== 'text' && block.kind !== 'thinking')
            // Grok attachments are exported once, as the attachments field.
            .filter((block) => !(platform === 'grok' && block.kind === 'attachment'))
            .filter((block) => Clean.process(block.content) !== baseContent)
            .map((block) => compactObject({
                kind: block.kind,
                id: block.id || '',
                tool: block.tool || '',
                title: block.title || '',
                language: block.language || '',
                content: filter.apply(block.kind, Clean.process(block.content))
            }));
        const hasGrokData = platform === 'grok' && (message.sources?.length || message.steps?.length);
        if (!content && !thinking && !blocks.length && !hasGrokData) {
            omittedEmpty += 1;
            continue;
        }
        const exportedChannel = platform === 'openrouter' && thinking
            ? (content ? 'reasoning_and_final' : 'reasoning')
            : channel;
        byChannel[exportedChannel] = (byChannel[exportedChannel] || 0) + 1;
        const grokDetails = platform !== 'grok' ? {}
            : Object.fromEntries(Object.entries(grokMessageDetails(message))
                .filter(([key]) => !GROK_DUPLICATE_FIELDS.has(key)));
        messages.push(compactObject({
            ...grokDetails,
            source_index: index,
            role,
            // Absent channel means "final" (an ordinary message).
            channel: exportedChannel === 'final' ? '' : exportedChannel,
            name: message?.author?.name || message?.name || '',
            model: message?.model || message?.metadata?.variantSlug || '',
            recipient: message?.recipient && message.recipient !== 'all' ? message.recipient : '',
            content_type: message?.content?.content_type || '',
            hidden_in_ui: hidden || undefined,
            content,
            // OpenRouter exports have always named reasoning "reasoning".
            [platform === 'openrouter' ? 'reasoning' : 'thinking']: thinking,
            blocks
        }));
    }

    const appendix = scope ? {} : gatherExportAppendix(platform, raw);
    const attachments = appendix.attachments || [];
    const body = JSON.stringify(messages);
    const references = (appendix.references || []).map(compactLLMReference).filter(usefulReference)
        .filter(notInBody(body));
    const tools = compactToolSummary(appendix.tools);
    // The per-item tool index repeats the blocks above; keep the totals.
    if (tools) delete tools.items;

    return compactObject({
        export_version: 5,
        export_kind: scope ? `${scope}_turns` : 'full_conversation_history',
        scope: scope || undefined,
        platform,
        exported_at: new Date().toISOString(),
        source: raw?._source || 'api',
        ...(platform === 'grok' ? compactObject({
            selected_response_id: raw?._selected_response_id,
            branch_selection: raw?._branch_selection,
            metadata_error: raw?._metadata_error
        }) : {}),
        id: clean?.uuid || clean?.id || raw?.uuid || raw?.conversation_id || raw?.id || fallbackId || '',
        title: clean?.name || clean?.title || raw?.name || raw?.title || fallbackTitle || '',
        model: clean?.model || raw?.model || raw?.default_model_slug || '',
        created_at: clean?.created_at || raw?.created_at || raw?.create_time || null,
        updated_at: clean?.updated_at || raw?.updated_at || raw?.update_time || null,
        context: scope ? undefined : compactObject({
            resources: compactResources(raw),
            tools: tools && tools.total ? tools : undefined,
            attachments,
            search_queries: appendix.search_queries || [],
            references
        }),
        source_message_count: sourceMessages.length,
        mapping_message_count: mappingMessageCount !== sourceMessages.length ? mappingMessageCount : undefined,
        message_count: messages.length,
        // Reasoning, tool calls and tool results are retained and labelled via
        // each message's `channel`; this is the tally of what landed where.
        by_channel: byChannel,
        omitted: compactObject(nonZero({
            by_role: omittedByRole,
            inactive_branch: Math.max(0, mappingMessageCount - sourceMessages.length),
            empty: omittedEmpty,
            other_roles: omittedForScope
        })),
        repeated_tool_outputs: filter.repeated || undefined,
        messages
    });
};

const gatherExportAppendix = (platform, data) => {
    const messages = getMessages(data);
    const attachments = [];
    const references = [];
    for (const message of messages) {
        const context = collectMessageContext(message, platform);
        attachments.push(...(context.attachments || []));
        references.push(...(context.references || []));
    }
    references.push(...collectStructuredReferences([
        { citations: data?.citations },
        { references: data?.references },
        { sources: data?.sources },
        { sources: data?.code_session?.config?.sources }
    ]));
    const unique = (items) => {
        const seen = new Set();
        const result = [];
        for (const item of items) {
            const key = JSON.stringify(item);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(item);
        }
        return result;
    };
    const uniqueReferences = (items) => {
        const result = [];
        const indexes = new Map();
        for (const item of items) {
            const key = item.url ? `url:${item.url.toLowerCase()}`
                : item.id ? `id:${item.type || ''}:${item.id}`
                : JSON.stringify(item);
            if (indexes.has(key)) {
                const existing = result[indexes.get(key)];
                for (const [field, value] of Object.entries(item)) {
                    if (!existing[field] && value) existing[field] = value;
                }
                continue;
            }
            indexes.set(key, result.length);
            result.push({ ...item });
        }
        return result;
    };
    return compactObject({
        resources: compactResources(data),
        tools: collectToolActivity(platform, data),
        attachments: unique(attachments),
        search_queries: collectSearchQueries(data),
        references: uniqueReferences(references)
    });
};

const exportMessages = (platform, data, targetRole = '', filter = createDedupeFilter()) => {
    const messages = [];
    const selected = selectConversationEntries(data);
    for (const { index, message, role, channel } of selected.entries) {
        if (targetRole && role !== targetRole) continue;
        const blocks = [];
        for (const block of plainBlocksForMessage(platform, message, index)) {
            // Every block kind is history: text, reasoning, tool I/O, artifacts.
            const value = Clean.process(block.kind === 'text' || block.kind === 'thinking' ? block.text : block.content);
            if (!value) continue;
            blocks.push(block.kind === 'text' || block.kind === 'thinking' ? { kind: block.kind, text: value } : {
                kind: block.kind,
                tool: block.tool || '',
                title: String(block.title || (block.kind === 'artifact' ? 'Artifact' : 'Block')),
                language: String(block.language || ''),
                content: filter.apply(block.kind, value)
            });
        }
        if (blocks.length) messages.push({
            index,
            role,
            channel,
            name: message?.author?.name || message?.name || '',
            model: message?.model || message?.metadata?.variantSlug || '',
            blocks
        });
    }
    return messages;
};

// Text of the exported messages, used to avoid listing a source twice.
const exportedBody = (messages) => messages.flatMap((message) =>
    message.blocks.map((block) => block.text || block.content || '')).join('\n');

const renderMarkdownAppendix = (platform, data, body = '') => {
    const appendix = gatherExportAppendix(platform, data);
    const lines = [];
    appendix.references = (appendix.references || []).filter(notInBody(body));
    if (!appendix.references.length) delete appendix.references;
    if (!appendix.tools?.total) delete appendix.tools;
    if (!Object.keys(appendix).length) return '';
    lines.push('## Export Context\n');
    if (appendix.resources) {
        const resources = JSON.stringify(appendix.resources, null, 2);
        const fence = fenceFor(resources);
        lines.push(`${fence}json\n${resources}\n${fence}\n`);
    }
    const attachments = appendix.attachments || [];
    if (attachments.length) {
        lines.push('### Attachments\n');
        attachments.forEach((item) =>
            lines.push(`- ${item.name || item.id || 'attachment'}${item.mime_type ? ` (${item.mime_type})` : ''}`));
        lines.push('');
    }
    if (appendix.tools) {
        lines.push('### Tools\n');
        lines.push(`- Total activity: ${appendix.tools.total || 0}`);
        if (appendix.tools.names?.length) lines.push(`- Names: ${appendix.tools.names.slice(0, 30).join(', ')}`);
        lines.push('');
    }
    const searchQueries = appendix.search_queries || [];
    if (searchQueries.length) {
        lines.push('### Search Queries\n');
        searchQueries.forEach((query) => lines.push(`- ${query}`));
        lines.push('');
    }
    const references = (appendix.references || []).filter(usefulReference);
    if (references.length) {
        lines.push('### Sources\n');
        references.forEach((item, index) => {
            const label = String(item.title || item.attribution || item.url || item.id || item.type)
                .replace(/\s+/g, ' ').trim();
            lines.push(`${index + 1}. ${label}${item.url && label !== item.url ? ` - ${item.url}` : ''}`);
        });
        lines.push('');
    }
    return lines.join('\n');
};

const renderHTMLAppendix = (platform, data, body = '') => {
    const appendix = gatherExportAppendix(platform, data);
    appendix.references = (appendix.references || []).filter(notInBody(body));
    if (!appendix.references.length) delete appendix.references;
    if (!appendix.tools?.total) delete appendix.tools;
    if (!Object.keys(appendix).length) return '';
    const compactTools = compactToolSummary(appendix.tools);
    const attachmentsList = appendix.attachments || [];
    const referencesList = (appendix.references || []).map(compactLLMReference).filter(usefulReference);
    const resources = appendix.resources ? `<details open><summary>Context</summary><pre>${escapeHTML(JSON.stringify(appendix.resources, null, 2))}</pre></details>` : '';
    const tools = compactTools
        ? `<details><summary>Tools (${compactTools.total || 0})</summary><pre>${escapeHTML(JSON.stringify(compactTools, null, 2))}</pre></details>`
        : '';
    const attachments = attachmentsList.length
        ? `<details><summary>Attachments (${appendix.attachments.length})</summary><pre>${escapeHTML(JSON.stringify(attachmentsList, null, 2))}</pre></details>`
        : '';
    const searchQueries = appendix.search_queries || [];
    const searches = searchQueries.length
        ? `<details><summary>Search Queries (${searchQueries.length})</summary><ul>${searchQueries.map((query) => `<li>${escapeHTML(query)}</li>`).join('')}</ul></details>`
        : '';
    const references = referencesList.length
        ? `<details><summary>Sources (${referencesList.length})</summary><ol>${referencesList.map((item) => {
            const label = String(item.title || item.attribution || item.url || item.id || item.type)
                .replace(/\s+/g, ' ').trim();
            const text = escapeHTML(label);
            return `<li>${item.url && label !== item.url ? `${text} - <a href="${escapeHTML(item.url)}" rel="noopener noreferrer">${escapeHTML(item.url)}</a>` : text}</li>`;
        }).join('')}</ol></details>`
        : '';
    return `<section class="appendix"><h2>Export Context</h2>${resources}${tools}${attachments}${searches}${references}</section>`;
};

const toMarkdown = (platform, data, fallbackTitle) => {
    const lines = [`# ${data?.name || data?.title || fallbackTitle || 'Chat'}\n`];
    const exported = exportMessages(platform, data);
    lines.push(`_Exported from ${platform} on ${new Date().toISOString()}._\n`);
    for (const { role, channel, name, model, blocks } of exported) {
        const identity = platform === 'openrouter' ? (name || model) : '';
        const heading = identity ? `${turnLabel(role, channel)} · ${identity}` : turnLabel(role, channel);
        lines.push(`## ${heading}\n`);
        for (const block of blocks) {
            const rendered = renderMarkdownExportBlock(block);
            if (rendered) lines.push(rendered);
        }
    }
    const appendix = renderMarkdownAppendix(platform, data, exportedBody(exported));
    if (appendix) lines.push(appendix);
    return Clean.whitespace(lines.join('\n'));
};

const toRoleMarkdown = (platform, data, targetRole, fallbackTitle) => {
    const label = roleLabel(targetRole);
    const lines = [`# ${data?.name || data?.title || fallbackTitle || 'Chat'} - ${label} Turns\n`];
    const exported = exportMessages(platform, data, targetRole);
    lines.push(`_Exported from ${platform} on ${new Date().toISOString()}._\n`);
    for (const [turnIndex, item] of exported.entries()) {
        const identity = platform === 'openrouter' ? (item.name || item.model) : '';
        lines.push(`## ${label} ${turnIndex + 1}${identity ? ` · ${identity}` : ''}\n`);
        const blocks = item.blocks;
        for (const block of blocks) {
            const rendered = renderMarkdownExportBlock(block);
            if (rendered) lines.push(rendered);
        }
    }
    return Clean.whitespace(lines.join('\n'));
};

const toHTML = (platform, data, fallbackTitle, role = '') => {
    const scope = exportScope(role);
    let html = '';
    const exported = exportMessages(platform, data, scope);
    for (const { role, channel, name, model, blocks } of exported) {
        const cssClass = role === 'user' ? 'u'
            : role === 'system' ? 's'
            : channel === 'reasoning' ? 'r'
            : (channel === 'tool_call' || channel === 'tool_result') ? 't'
            : 'a';
        const body = blocks.map(renderHTMLExportBlock).join('');
        const identity = platform === 'openrouter' ? (name || model) : '';
        const heading = identity ? `${turnLabel(role, channel)} · ${identity}` : turnLabel(role, channel);
        html += `<div class="${cssClass}"><b>${escapeHTML(heading)}</b>${body}</div>\n`;
    }
    const appendix = scope ? '' : renderHTMLAppendix(platform, data, exportedBody(exported));
    const baseTitle = data?.name || data?.title || fallbackTitle || 'Chat';
    const title = scope ? `${baseTitle} - ${roleLabel(scope)} Turns` : baseTitle;
    // The saved file is inert and offline: no script, no remote loads, and no
    // referrer when a reader follows a source link.
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(title)}</title>
<style>*{box-sizing:border-box}body{font-family:ui-monospace,monospace;max-width:900px;margin:0 auto;padding:20px;background:#0d1117;color:#c9d1d9;font-size:13px}
.u{background:#161b22;padding:16px;margin:12px 0;border-radius:8px;border-left:3px solid #58a6ff}
.a{background:#0d1117;padding:16px;margin:12px 0;border-radius:8px;border-left:3px solid #7ee787}.s{background:#161b22;padding:16px;margin:12px 0;border-radius:8px;border-left:3px solid #a371f7}
.r{background:#0d1117;padding:16px;margin:12px 0;border-radius:8px;border-left:3px solid #a371f7;opacity:.85}
.t{background:#0d1117;padding:16px;margin:12px 0;border-radius:8px;border-left:3px solid #f2cc60;opacity:.85}
b{color:#58a6ff;display:block;margin-bottom:8px;font-size:11px;text-transform:uppercase}.a b{color:#7ee787}.s b{color:#a371f7}.r b{color:#a371f7}.t b{color:#f2cc60}.omitted{color:#8b949e;font-style:italic}
pre{white-space:pre-wrap;margin:0}.artifact,.tool-call,.tool-result,.thinking{background:#21262d;padding:12px;margin:12px 0;border-radius:6px;border:1px solid #30363d}
.tool-result{border-left:3px solid #f2cc60}.tool-call{border-left:3px solid #58a6ff}.artifact{border-left:3px solid #f0883e}.thinking{border-left:3px solid #a371f7}
.art-title,.block-title{color:#f0883e;font-weight:600;margin-bottom:8px}.appendix{margin:28px 0;padding-top:16px;border-top:1px solid #30363d}.appendix h2{font-size:14px}.appendix details{background:#161b22;border:1px solid #30363d;border-radius:8px;margin:10px 0;padding:10px}.appendix summary{cursor:pointer;color:#58a6ff;font-weight:600}</style></head><body><header><h1>${escapeHTML(title)}</h1><p>${escapeHTML(`Exported from ${platform} on ${new Date().toISOString()}.`)}</p></header>${html}${appendix}</body></html>`;
};

const collectRegexMatches = (value, source, flags, max) => {
    const safeFlags = (flags || 'g').includes('g') ? flags : `${flags || ''}g`;
    const regex = new RegExp(source, safeFlags);
    const text = safeStringify(value);
    const matches = new Set();
    let match;
    while ((match = regex.exec(text)) && matches.size < max) matches.add(match[0]);
    return [...matches];
};

const buildApiDiffEntries = (normalized) => dedupeComparable(normalized.messages.flatMap((message) =>
    message.blocks.map((block) => ({
        role: message.role,
        kind: block.kind,
        text: block.text || block.content || '',
        title: block.title || ''
    }))
).filter((entry) => entry.text)).slice(0, 300);

const buildDomDiffEntries = (snapshot) => dedupeComparable([
    ...snapshot.messages.map((item) => ({ kind: 'message', text: item.text, selector: item.selector })),
    ...snapshot.code_blocks.map((item) => ({ kind: 'code', text: item.text, selector: item.selector })),
    ...snapshot.attachments.map((item) => ({ kind: 'attachment', text: item.text || item.selector, selector: item.selector }))
]).slice(0, 300);

const matchComparable = (needle, haystack) =>
    haystack.some((item) => item.key.includes(needle.key) || needle.key.includes(item.key));
const diffComparable = (left, right) => left.filter((item) => !matchComparable(item, right));

// ---------------------------------------------------------------------------
// Command dispatcher

const handlers = {
    clean: ({ platform, raw }) => {
        if (platform === 'claude') return CleanJSON.claude(raw);
        if (platform === 'chatgpt') return CleanJSON.chatgpt(raw);
        if (platform === 'openrouter') return CleanJSON.openrouter(raw);
        if (platform === 'grok') return CleanJSON.grok(raw);
        if (platform === 'google') return CleanJSON.google(raw);
        return CleanJSON.domConversation(raw);
    },
    domConversation: ({ raw }) => CleanJSON.domConversation(raw),
    normalize: ({ platform, raw }) => normalizeConversation(platform, raw),
    markdown: ({ platform, raw, fallbackTitle }) => toMarkdown(platform, raw, fallbackTitle),
    html: ({ platform, raw, fallbackTitle, role }) => toHTML(platform, raw, fallbackTitle, role),
    role: ({ platform, raw, role, fallbackTitle }) => toRoleMarkdown(platform, raw, role, fallbackTitle),
    llm: ({ platform, raw, clean, fallbackTitle, fallbackId, role }) =>
        toLLMJSON(platform, raw, clean, fallbackTitle, fallbackId, role),
    // Message counts for the panel's status line, using the same active-branch
    // selection as every export format.
    count: ({ raw }) => {
        const counts = { total: 0, user: 0, assistant: 0 };
        for (const { role } of selectConversationEntries(raw).entries) {
            counts.total += 1;
            if (role === 'user' || role === 'assistant') counts[role] += 1;
        }
        return counts;
    },
    hasUsableMessages: ({ raw }) => hasUsableMessages(raw),
    diff: ({ platform, raw, domSnapshot }) => {
        const normalized = normalizeConversation(platform, raw);
        const apiEntries = buildApiDiffEntries(normalized);
        const domEntries = buildDomDiffEntries(domSnapshot);
        const missingFromApi = diffComparable(domEntries, apiEntries).slice(0, 40).map((item) => ({
            source: 'dom_only',
            kind: item.kind,
            selector: item.selector || '',
            preview: item.text.slice(0, 160)
        }));
        const missingFromDom = diffComparable(apiEntries, domEntries).slice(0, 40).map((item) => ({
            source: 'api_only',
            role: item.role || '',
            kind: item.kind,
            title: item.title || '',
            preview: item.text.slice(0, 160)
        }));
        return {
            api_block_count: apiEntries.length,
            dom_block_count: domEntries.length,
            dom_only: missingFromApi,
            api_only: missingFromDom
        };
    },
    discoverChatGPT: ({ raw, fallbackId, fallbackTitle }) => {
        const messages = getMessages(raw);
        const metadata = messages.map((message) => message.metadata || {});
        return compactObject({
            conversation_id: raw?.conversation_id || raw?.id || fallbackId || '',
            title: raw?.title || fallbackTitle || '',
            model: raw?.default_model_slug || '',
            conversation_template_id: raw?.conversation_template_id || '',
            gizmo_id: raw?.gizmo_id || '',
            gizmo_type: raw?.gizmo_type || '',
            message_count: messages.length,
            tool_message_count: messages.filter((m) => m.author?.role === 'tool').length,
            file_ids: collectRegexMatches(messages, 'file_[a-zA-Z0-9]{16,}', 'g', 8),
            library_file_ids: collectRegexMatches(messages, 'libfile_[a-zA-Z0-9]{16,}', 'g', 8),
            request_ids: [...new Set(metadata.map((item) => item.request_id).filter(Boolean))].slice(0, 12),
            turn_exchange_ids: [...new Set(metadata.map((item) => item.turn_exchange_id).filter(Boolean))].slice(0, 12),
            safe_url_count: Array.isArray(raw?.safe_urls) ? raw.safe_urls.length : 0,
            blocked_url_count: Array.isArray(raw?.blocked_urls) ? raw.blocked_urls.length : 0
        });
    },
    discoverClaude: ({ raw, fallbackId, fallbackTitle, orgId }) => compactObject({
        conversation_id: raw?.uuid || fallbackId || '',
        title: raw?.name || fallbackTitle || '',
        model: raw?.model || raw?.config?.model || raw?.code_session?.config?.model || '',
        org_id: orgId || '',
        project_uuid: raw?.project_uuid || '',
        conversation_kind: raw?._conversation_kind || '',
        message_count: getMessages(raw).length,
        artifact_count: collectRegexMatches(raw, 'artifact[a-zA-Z0-9_-]*', 'g', 30).length,
        // Full inventory with on/off state.
        mcp_tools: Object.entries(raw?.settings?.enabled_mcp_tools || {})
            .map(([name, enabled]) => ({ name, enabled: !!enabled }))
    })
};

const runParserCommand = (cmd, args = {}) => {
    if (!cmd || !Object.prototype.hasOwnProperty.call(handlers, cmd)) {
        throw new Error(`unknown command: ${cmd}`);
    }
    if (args?.platform === 'grok' && args.raw) {
        args = { ...args, raw: prepareGrokConversation(args.raw) };
    }
    return handlers[cmd](args || {});
};

if (typeof window !== 'undefined' && window.__chatToolkit) {
    window.__chatToolkit.runParserCommand = runParserCommand;
}
