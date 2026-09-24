import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

const workspace = resolve(import.meta.dir, '../..');
const fetcherSource = readFileSync(resolve(workspace, 'extension-src/lib/api-fetchers.js'), 'utf8');
// The extension runs parser-worker.js as a content script; load it the same
// way. structuredClone keeps each call's input isolated from the fixture.
const parserContext = createContext({ window: { __chatToolkit: {} } });
runInContext(readFileSync(resolve(workspace, 'extension-src/lib/parser-worker.js'), 'utf8'), parserContext);
const parserCall = async (cmd, args) =>
    structuredClone(parserContext.window.__chatToolkit.runParserCommand(cmd, structuredClone(args)));

const loadFetchers = ({ url, cookie = '', fetchImpl }) => {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        location: globalThis.location,
        fetch: globalThis.fetch
    };
    const toolkit = {
        PLATFORM: 'claude',
        safeStringify: JSON.stringify,
        decodeBatchExecute: () => [],
        batchPayload: () => null
    };
    globalThis.window = { __chatToolkit: toolkit };
    globalThis.document = { cookie, title: 'Cowork fixture' };
    globalThis.location = new URL(url);
    globalThis.fetch = fetchImpl || (() => Promise.reject(new Error('unexpected fetch')));
    new Function(fetcherSource)();
    return {
        toolkit,
        restore: () => {
            if (previous.window === undefined) delete globalThis.window;
            else globalThis.window = previous.window;
            if (previous.document === undefined) delete globalThis.document;
            else globalThis.document = previous.document;
            if (previous.location === undefined) delete globalThis.location;
            else globalThis.location = previous.location;
            globalThis.fetch = previous.fetch;
        }
    };
};

const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
});

describe('Claude cowork fetching', () => {
    test('recognizes cowork IDs and exhausts reverse-chronological event pages', async () => {
        const id = 'cse_test123';
        const requests = [];
        const { toolkit, restore } = loadFetchers({
            url: `https://claude.ai/cowork/${id}`,
            cookie: 'lastActiveOrg=org-test; anthropic-device-id=device-test; activitySessionId=activity-test',
            fetchImpl: async (input, init) => {
                const url = new URL(String(input));
                requests.push({ url, init });
                if (url.pathname === `/v1/code/sessions/${id}`) {
                    return response({ error: 'detail unavailable' }, 404);
                }
                if (url.pathname === '/v1/code/sessions') {
                    return response({ data: [{ id, title: 'Cowork test', config: { model: 'claude-test' } }] });
                }
                if (url.pathname === `/v1/code/sessions/${id}/events` && !url.search) {
                    return response({
                        data: [
                            { event_id: 'event-3', sequence_num: 3, payload: { type: 'assistant', message: { role: 'assistant', content: 'third' } } },
                            { event_id: 'event-2', sequence_num: 2, payload: { type: 'assistant', message: { role: 'assistant', content: 'second' } } }
                        ],
                        next_cursor: 'older page'
                    });
                }
                if (url.searchParams.get('cursor') === 'older page') {
                    return response({
                        data: [
                            { event_id: 'event-2', sequence_num: 2, payload: { type: 'assistant', message: { role: 'assistant', content: 'duplicate' } } },
                            { event_id: 'event-1', sequence_num: 1, payload: { type: 'user', message: { role: 'user', content: 'first' } } }
                        ]
                    });
                }
                return response({ error: 'not found' }, 404);
            }
        });

        try {
            expect(toolkit.getCurrentId()).toBe(id);
            const raw = await toolkit.fetchClaude(id);
            expect(raw._conversation_kind).toBe('cowork');
            expect(raw.code_session_events.map((event) => event.sequence_num)).toEqual([1, 2, 3]);
            expect(requests.some(({ url }) => url.searchParams.get('cursor') === 'older page')).toBeTrue();
            const eventRequest = requests.find(({ url }) => url.pathname.endsWith('/events'));
            expect(eventRequest.init.headers['anthropic-beta']).toBe('ccr-byoc-2025-07-29');
            expect(eventRequest.init.headers['x-organization-uuid']).toBe('org-test');
            expect(eventRequest.init.headers['anthropic-device-id']).toBe('device-test');
        } finally {
            restore();
        }
    });
});

describe('Claude cowork parsing and sources', () => {
    const raw = {
        id: 'cse_fixture',
        uuid: 'cse_fixture',
        name: 'Cowork sources fixture',
        model: 'claude-test',
        _conversation_kind: 'cowork',
        _source: 'cowork_api',
        code_session_events: [
            {
                event_id: 'assistant-event',
                sequence_num: 2,
                payload: {
                    type: 'assistant',
                    uuid: 'assistant-envelope',
                    message: {
                        role: 'assistant',
                        content: [
                            {
                                type: 'web_search_tool_result',
                                content: [
                                    { type: 'web_search_result', title: 'First source', url: 'https://example.com/first', encrypted_content: 'ignored' }
                                ]
                            },
                            {
                                type: 'text',
                                text: 'Answer with citations.',
                                citations: [
                                    { type: 'web_search_result_location', title: 'First source', url: 'https://example.com/first', cited_text: 'ignored' },
                                    { type: 'web_search_result_location', title: 'Second source', url: 'https://example.org/second', cited_text: 'ignored' }
                                ]
                            }
                        ]
                    }
                }
            },
            {
                event_id: 'user-event',
                sequence_num: 1,
                payload: {
                    type: 'user',
                    uuid: 'user-envelope',
                    message: { role: 'user', content: 'Find reliable sources.' }
                }
            }
        ]
    };

    test('turns event envelopes into chronological messages', async () => {
        const clean = await parserCall('clean', { platform: 'claude', raw });
        expect(clean.messages).toHaveLength(2);
        expect(clean.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
        expect(clean.messages[0].content).toBe('Find reliable sources.');
        expect(clean.messages[1].content).toBe('Answer with citations.');
    });

    test('adds a deduplicated Claude URL list to Markdown, HTML, and JSON', async () => {
        const [markdown, html, llm] = await Promise.all([
            parserCall('markdown', { platform: 'claude', raw }),
            parserCall('html', { platform: 'claude', raw }),
            parserCall('llm', { platform: 'claude', raw, clean: {}, fallbackTitle: '' })
        ]);
        expect(markdown).toContain('### Sources');
        expect(markdown.match(/https:\/\/example\.com\/first/g)).toHaveLength(1);
        expect(markdown.match(/https:\/\/example\.org\/second/g)).toHaveLength(1);
        expect(html).toContain('Sources (2)');
        expect(llm.context.references).toHaveLength(2);
        expect(llm.context.references.map((item) => item.url)).toEqual([
            'https://example.com/first',
            'https://example.org/second'
        ]);
    });
});
