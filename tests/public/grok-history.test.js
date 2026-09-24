import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext, Script } from 'node:vm';
import { loadGrokToolkit, workspace } from '../helpers/toolkit.js';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' }
});
const fixtureId = 'test-conversation-with-hyphens';
const fixture = ({ nodes, responses, rid = '', intercept } = {}) => {
    const requests = [];
    const url = `https://grok.com/c/${fixtureId}${rid ? `?rid=${rid}` : ''}`;
    const loaded = loadGrokToolkit({
        url,
        fetchImpl: async (input, init = {}) => {
            const path = new URL(input).pathname;
            requests.push({ path, ...init });
            const intercepted = await intercept?.(path, init);
            if (intercepted) return intercepted;
            if (path.includes('/conversations_v2/')) {
                return jsonResponse({ conversation: { conversationId: fixtureId, title: 'Branch fixture' } });
            }
            if (path.endsWith('/response-node')) return jsonResponse({ responseNodes: nodes, inflightResponses: [] });
            if (path.endsWith('/load-responses')) {
                const ids = JSON.parse(init.body).responseIds;
                return jsonResponse({ responses: responses.filter((r) => ids.includes(r.responseId)).toReversed() });
            }
            throw new Error(`Unexpected fixture request: ${path}`);
        }
    });
    return { ...loaded, requests };
};
const response = (responseId, parentResponseId, sender = 'assistant', message = responseId) => ({
    responseId, parentResponseId, sender, message
});
const branchResponses = [
    response('human-root', 'unlisted-synthetic-root', 'human'),
    response('old-answer', 'human-root'),
    response('old-question', 'old-answer', 'human'),
    response('old-leaf', 'old-question'),
    response('new-answer', 'human-root'),
    response('new-question', 'new-answer', 'human'),
    response('new-leaf', 'new-question'),
    { ...response('thread-leaf', 'old-answer'), threadParentId: 'old-answer' }
];
const branchNodes = branchResponses.map(({ message, ...node }) => node);

describe('Grok branch selection and message loading', () => {
    test('the selected rid follows only its parent chain and exports it in order', async () => {
        const { toolkit, requests } = fixture({ nodes: branchNodes, responses: branchResponses, rid: 'old-leaf' });
        const raw = await toolkit.fetchGrok(fixtureId);
        expect(raw.responses.map((r) => r.responseId)).toEqual(['human-root', 'old-answer', 'old-question', 'old-leaf']);
        expect(JSON.parse(requests.at(-1).body).responseIds).toEqual(['old-leaf', 'old-question', 'old-answer', 'human-root']);
        const md = toolkit.runParserCommand('markdown', { platform: 'grok', raw });
        expect(md).not.toContain('new-answer');
        expect(md).not.toContain('thread-leaf');
    });

    test('without rid the latest main response is chosen, excluding separate threads', async () => {
        const { toolkit } = fixture({ nodes: branchNodes, responses: branchResponses });
        const raw = await toolkit.fetchGrok(fixtureId);
        expect(raw.responses.map((r) => r.responseId)).toEqual(['human-root', 'new-answer', 'new-question', 'new-leaf']);
        expect(raw._branch_selection).toBe('latest_main_response');
    });

    test('an earlier selected response ends the export there instead of appending later turns', async () => {
        const { toolkit } = fixture({ nodes: branchNodes, responses: branchResponses, rid: 'old-answer' });
        expect((await toolkit.fetchGrok(fixtureId)).responses.map((r) => r.responseId)).toEqual(['human-root', 'old-answer']);
    });

    test('all 65 responses are loaded across three batches with no display-window truncation', async () => {
        const responses = Array.from({ length: 65 }, (_, i) => response(`message-${i}`, i ? `message-${i - 1}` : '', i % 2 ? 'assistant' : 'human'));
        const { toolkit, requests } = fixture({ nodes: responses, responses });
        const raw = await toolkit.fetchGrok(fixtureId);
        expect(raw.responses.map((r) => r.responseId)).toEqual(responses.map((r) => r.responseId));
        expect(requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body).responseIds.length)).toEqual([30, 30, 5]);
        const clean = toolkit.runParserCommand('clean', { platform: 'grok', raw });
        const llm = toolkit.runParserCommand('llm', { platform: 'grok', raw, clean });
        expect(llm.messages).toHaveLength(65);
        // Zero counts are omitted, so no `omitted` object means nothing was dropped.
        expect(llm.omitted).toBeUndefined();
    });

    test('a missing selected response is reported instead of switching to another branch', async () => {
        const { toolkit } = fixture({ nodes: branchNodes, responses: branchResponses, rid: 'unknown' });
        await expect(toolkit.fetchGrok(fixtureId)).rejects.toThrow('selected response unknown was not found');
    });

    test('a parent cycle is reported without entering an endless loop', async () => {
        const responses = [response('a', 'b'), response('b', 'a')];
        const { toolkit } = fixture({ nodes: responses, responses });
        await expect(toolkit.fetchGrok(fixtureId)).rejects.toThrow('parent cycle');
    });

    test('missing message bodies are reported rather than silently exporting a shorter history', async () => {
        const { toolkit } = fixture({ nodes: branchNodes, responses: branchResponses.filter((r) => r.responseId !== 'new-question') });
        await expect(toolkit.fetchGrok(fixtureId)).rejects.toThrow('did not return 1 requested message(s): new-question');
    });

    test('duplicate nodes and unrelated response bodies cannot duplicate or contaminate the transcript', async () => {
        const { toolkit } = fixture({
            nodes: [branchNodes[0], branchNodes[0], branchNodes[1]], responses: branchResponses,
            intercept: (path) => path.endsWith('/load-responses')
                ? jsonResponse({ responses: [branchResponses[0], branchResponses[0], branchResponses[1], branchResponses[4]] }) : null
        });
        expect((await toolkit.fetchGrok(fixtureId)).responses.map((r) => r.responseId)).toEqual(['human-root', 'old-answer']);
    });

    test('a metadata error leaves accessible messages usable and records the error', async () => {
        const { toolkit } = fixture({
            nodes: branchNodes, responses: branchResponses,
            intercept: (path) => path.includes('/conversations_v2/') ? jsonResponse({ error: 'metadata unavailable' }, 503) : null
        });
        const raw = await toolkit.fetchGrok(fixtureId);
        expect(raw.responses).toHaveLength(4);
        expect(raw._metadata_error).toContain('503');
        expect(toolkit.runParserCommand('llm', { platform: 'grok', raw }).metadata_error).toContain('metadata unavailable');
    });

    for (const status of [401, 403, 404, 429, 500]) {
        test(`a ${status} message request produces an HTTP error instead of an empty export`, async () => {
            const { toolkit } = fixture({
                nodes: branchNodes, responses: branchResponses,
                intercept: (path) => path.endsWith('/load-responses') ? jsonResponse({ error: 'request denied' }, status) : null
            });
            await expect(toolkit.fetchGrok(fixtureId)).rejects.toThrow(`Grok conversation messages failed (${status}`);
        });
    }

    test('HTML login/challenge pages produce a JSON error instead of a misleading empty chat', async () => {
        const { toolkit } = fixture({
            nodes: [], responses: [],
            intercept: (path) => path.endsWith('/response-node') ? new Response('<html>Sign in</html>') : null
        });
        await expect(toolkit.fetchGrok(fixtureId)).rejects.toThrow('Grok response tree returned an invalid JSON response');
    });

    test('an unexpected tree or message schema is reported explicitly', async () => {
        for (const endpoint of ['/response-node', '/load-responses']) {
            const { toolkit } = fixture({
                nodes: branchNodes, responses: branchResponses,
                intercept: (path) => path.endsWith(endpoint) ? jsonResponse({ changed: true }) : null
            });
            await expect(toolkit.fetchGrok(fixtureId)).rejects.toThrow('did not include');
        }
    });

    test('home and unrelated routes have no conversation ID and invalid IDs trigger no request', async () => {
        for (const path of ['/', '/chat', '/c/', '/imagine', '/c/bad%2Fid']) {
            const { toolkit } = loadGrokToolkit({ url: `https://grok.com${path}` });
            expect(toolkit.getCurrentId()).toBeUndefined();
            await expect(toolkit.fetchGrok(toolkit.getCurrentId())).rejects.toThrow('No valid Grok conversation ID');
        }
    });
});

describe('Grok parser compatibility and data retention', () => {
    test('older nested messages work in JSON, Markdown, HTML, and role exports', () => {
        const { toolkit } = loadGrokToolkit({ url: `https://grok.com/chat/${fixtureId}` });
        const raw = { conversation: { id: fixtureId, title: 'Old format', messages: [
            { isUser: true, text: 'Legacy question' }, { isUser: false, content: 'Legacy answer' }
        ] } };
        const parse = (cmd, args = {}) => toolkit.runParserCommand(cmd, { platform: 'grok', raw, ...args });
        expect(parse('clean').messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(parse('llm').messages.map((m) => m.content)).toEqual(['Legacy question', 'Legacy answer']);
        expect(parse('markdown')).toContain('Legacy answer');
        expect(parse('html')).toContain('Legacy answer');
        expect(parse('role', { role: 'user' })).toContain('Legacy question');
    });

    test('thinking text, tool results, attachments, citations, partial flags, and metadata remain available', () => {
        const { toolkit } = loadGrokToolkit({ url: `https://grok.com/c/${fixtureId}` });
        const raw = { conversation: { conversationId: fixtureId }, responses: [{
            ...response('answer', '', 'assistant', 'Answer <script>alert(1)</script>'),
            model: 'captured-model', partial: true, streamErrors: ['interrupted'],
            metadata: '{"request_metadata":{"model":"auto"}}',
            steps: [
                { text: ['Supplied thinking text'], tags: ['thought'] },
                { text: ['stdout'], tags: ['raw_function_result'] },
                { text: ['<xai:tool_usage_card>original tool call</xai:tool_usage_card>'], tags: ['tool_usage_card'] }
            ],
            fileAttachments: ['file-one'], generatedImageUrls: ['https://assets.example/image.png'],
            fileAttachmentAssetMetadata: [{ assetId: 'asset-one', name: 'source.txt', mimeType: 'text/plain' }],
            citedWebSearchResults: [{ title: 'Citation title', url: 'https://example.com/citation' }],
            toolResponses: [{ stdout: 'original tool output' }]
        }] };
        const parse = (cmd) => toolkit.runParserCommand(cmd, { platform: 'grok', raw });
        const message = parse('llm').messages[0];
        expect(message.thinking).toBe('Supplied thinking text');
        expect(message.partial).toBeTrue();
        expect(message.streamErrors).toEqual(['interrupted']);
        // Raw steps are exported through thinking and blocks, not repeated.
        expect(message.steps).toBeUndefined();
        expect(message.toolResponses).toBeUndefined();
        expect(message.metadata.request_metadata.model).toBe('auto');
        expect(message.model).toBe('captured-model');
        expect(message.attachments).toHaveLength(3);
        expect(parse('llm').context.attachments).toHaveLength(3);
        // Text and reasoning are exported once, as content and thinking; blocks
        // carry only what those fields do not.
        expect(message.blocks.map((b) => b.kind)).toEqual(['tool_result', 'tool_call', 'tool_result']);
        expect(message.thinking).toBeTruthy();
        expect(message.content).toBeTruthy();
        expect(parse('markdown')).toContain('original tool output');
        expect(parse('markdown')).toContain('https://assets.example/image.png');
        expect(parse('html')).not.toContain('<script>alert(1)</script>');
        expect(parse('html')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        // The citation is exported once, on its message.
        expect(message.sources.map((source) => source.url)).toContain('https://example.com/citation');
        expect(JSON.stringify(parse('llm').context?.references || [])).not.toContain('https://example.com/citation');
    });

    test('a thinking-only response retains its steps without inventing final answer text', () => {
        const { toolkit } = loadGrokToolkit({ url: `https://grok.com/c/${fixtureId}` });
        const raw = { responses: [{ ...response('thinking', '', 'assistant', ''),
            steps: [{ text: ['Thinking that was supplied'], tags: ['thought'] }] }] };
        const llm = toolkit.runParserCommand('llm', { platform: 'grok', raw });
        expect(llm.messages).toHaveLength(1);
        expect(llm.messages[0].thinking).toBe('Thinking that was supplied');
        expect(llm.messages[0].content).toBeUndefined();
    });

});

describe('Runtime syntax', () => {
    test('every JavaScript file in the XPI source parses and manifest script paths exist', () => {
        const manifest = JSON.parse(readFileSync(resolve(workspace, 'extension-src/manifest.json'), 'utf8'));
        const files = [...manifest.background.scripts, ...manifest.content_scripts.flatMap((s) => s.js), 'popup/popup.js'];
        for (const file of files) {
            expect(() => new Script(readFileSync(resolve(workspace, 'extension-src', file), 'utf8'), { filename: file })).not.toThrow();
        }
    });
});
