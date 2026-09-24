import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { loadGrokToolkit } from '../helpers/toolkit.js';

const root = resolve(import.meta.dir, '../..');
const toolkit = () => loadGrokToolkit({ url: 'https://grok.com/c/synthetic' }).toolkit;
const run = (...args) => toolkit().runParserCommand(...args);

// Synthetic hNvQHb payload shaped like the September 2026 reply: one turn
// record whose selected candidate carries reasoning steps ([id, …, "Google
// Search", …]) at candidate[37][1] and shopping cards at candidate[12][15].
const geminiPayload = () => {
    const candidate = [];
    candidate[0] = 'rc_synthetic';
    candidate[1] = ['Try this listing: [Vintage deer tee](http://googleusercontent.com/shopping_content/111) or [a similar one](http://googleusercontent.com/shopping_content/0_link).'];
    const product = (title, url, price, merchant) => {
        const row = [];
        row[10] = title; row[12] = url; row[13] = price; row[27] = merchant;
        return row;
    };
    candidate[12] = [];
    candidate[12][15] = [
        [['http://googleusercontent.com/shopping_content/111', null, null, null, null, null, ['Google Shopping', 'https://www.gstatic.com/logo.svg']],
            null, null, [product('Vintage deer tee', 'https://google.com/search?q=vintage+deer+tee&utm_source=x', '$19.99', 'Example store')]],
        [['http://googleusercontent.com/shopping_content/0_link'], null, null, [product('Similar tee', 'https://example.com/tee', '$20.00', '')]]
    ];
    const step = (title) => [[`**${title}**\n\nChecking.`], '', '', '', [], title, 'Google Search'];
    candidate[37] = [['**Identifying the shirt**\n\nLooking at the photo.'], Array.from({ length: 8 }, (_, i) => step(`Step ${i}`))];
    const record = [['c_synthetic', 'r_synthetic'], null, [['Where can I find this exact shirt?', null, null, null, []], 1, null, 1, 'synthetic', null, null, null, false],
        [[candidate], [['vintage deer tee', 1]], null, 'rc_synthetic'], [1790000000, 0]];
    return [[record], null, null, []];
};

describe('Gemini conversation extraction (September 2026 regression)', () => {
    test('reasoning steps are not mistaken for turns; the real prompt and answer are exported', () => {
        const extracted = toolkit().extractGeminiConversation({ data: geminiPayload() });
        expect(extracted.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(extracted.messages[0].content).toBe('Where can I find this exact shirt?');
        expect(extracted.messages[1].thinking).toContain('Identifying the shirt');
        expect(extracted.search_queries).toEqual(['vintage deer tee']);
    });

    test('shopping placeholders become real links and are kept as sources', () => {
        const [, answer] = toolkit().extractGeminiConversation({ data: geminiPayload() }).messages;
        expect(answer.content).not.toContain('googleusercontent.com');
        expect(answer.content).toContain('(https://google.com/search?q=vintage+deer+tee)');
        expect(answer.content).toContain('(https://example.com/tee)');
        expect(answer.sources).toEqual([
            { title: 'Vintage deer tee', url: 'https://google.com/search?q=vintage+deer+tee', attribution: 'Example store', price: '$19.99' },
            { title: 'Similar tee', url: 'https://example.com/tee', price: '$20.00' }
        ]);
    });
});

const toolChat = () => {
    const bigOutput = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const repeated = `Repeated search result ${'y'.repeat(300)}`;
    return {
        uuid: 'synthetic', name: 'Tool chat', chat_messages: [
            { sender: 'human', text: 'Run the build' },
            { sender: 'assistant', content: [
                { type: 'thinking', thinking: 'I should run the build.' },
                { type: 'text', text: 'Running it now.' },
                { type: 'tool_use', name: 'bash', input: { command: 'make all' } },
                { type: 'tool_result', content: bigOutput },
                { type: 'tool_use', name: 'create_file', input: { path: '/tmp/big.py', file_text: 'z = 1\n'.repeat(2000) } },
                { type: 'tool_result', content: repeated },
                { type: 'tool_result', content: repeated }
            ] }
        ], bigOutput
    };
};

describe('Standard export: complete content, repetition removed', () => {
    test('long tool output is kept whole; an identical repeat becomes a one-line reference', () => {
        const raw = toolChat();
        const md = run('markdown', { platform: 'claude', raw });
        expect(md).toContain(raw.bigOutput);
        expect(md.match(/Repeated search result/g)).toHaveLength(1);
        expect(md).toContain('[Same output as an earlier tool result.]');
        const json = run('llm', { platform: 'claude', raw, clean: {} });
        expect(json.repeated_tool_outputs).toBe(1);
        expect(json.detail).toBeUndefined();
    });

    test('Claude JSON carries text, reasoning, tool calls, tool output, and created files', () => {
        const json = run('llm', { platform: 'claude', raw: toolChat(), clean: {} });
        const assistant = json.messages[1];
        expect(assistant.content).toBe('Running it now.');
        expect(assistant.thinking).toBe('I should run the build.');
        expect(assistant.blocks.map((block) => block.kind)).toEqual(['tool_call', 'tool_result', 'artifact', 'tool_result', 'tool_result']);
        expect(assistant.blocks.find((block) => block.kind === 'artifact').content).toBe('z = 1\n'.repeat(2000).trimEnd());
    });

    test('a source already linked in the conversation is not listed again', () => {
        const raw = { conversation_id: 'c', title: 'Linked chat', current_node: 'b', mapping: {
            a: { message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['Find it'] } } },
            b: { parent: 'a', message: { id: 'b', author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['See [the page](https://example.com/linked).'] },
                metadata: { content_references: [
                    { type: 'webpage', title: 'Linked page', url: 'https://example.com/linked' },
                    { type: 'webpage', title: 'Other page', url: 'https://example.com/other' }
                ] } } }
        } };
        const md = run('markdown', { platform: 'chatgpt', raw });
        const sources = md.slice(md.indexOf('### Sources'));
        expect(sources).toContain('https://example.com/other');
        expect(sources).not.toContain('https://example.com/linked');
        const json = run('llm', { platform: 'chatgpt', raw, clean: {} });
        expect(json.context.references.map((ref) => ref.url)).toEqual(['https://example.com/other']);
    });
});

describe('Lossless JSON savings', () => {
    test('zero counts, constant limits, the default channel, and duplicate reasoning are omitted', () => {
        const raw = { conversation_id: 'c', title: 'Reasoning chat', current_node: 'b', mapping: {
            a: { message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['Question'] } } },
            r: { parent: 'a', message: { id: 'r', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [{ summary: 'Plan', content: 'Think it through.' }] } } },
            b: { parent: 'r', message: { id: 'b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Answer'] } } }
        } };
        const json = run('llm', { platform: 'chatgpt', raw, clean: {} });
        expect(json.limits).toBeUndefined();
        expect(json.omitted).toBeUndefined();
        expect(json.mapping_message_count).toBeUndefined();
        expect(json.messages[0].channel).toBeUndefined();
        const reasoning = json.messages[1];
        expect(reasoning.channel).toBe('reasoning');
        expect(reasoning.content).toContain('Think it through.');
        expect(reasoning.thinking).toBeUndefined();
    });

    test('search hits are listed and derivable attribution is dropped', () => {
        const raw = { conversation_id: 'c', title: 'Search chat', current_node: 'b', mapping: {
            a: { message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['Find it'] } } },
            b: { parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Found it'] },
                metadata: {
                    content_references: [{ type: 'webpage', title: 'Cited page', url: 'https://www.example.com/cited', attribution: 'example.com' },
                        { type: 'grouped_webpages' }],
                    search_result_groups: [{ domain: 'other.org', entries: [{ title: 'Uncited hit', url: 'https://other.org/hit' }] }]
                } } }
        } };
        expect(run('llm', { platform: 'chatgpt', raw, clean: {} }).context.references).toEqual([
            { type: 'webpage', title: 'Cited page', url: 'https://www.example.com/cited' },
            { type: 'search_result', title: 'Uncited hit', url: 'https://other.org/hit' }
        ]);
    });

    test('Grok JSON drops raw fields whose content is exported through normalized fields', () => {
        const raw = { conversation: { conversationId: 'g', title: 'Grok chat' }, responses: [
            { responseId: 'r1', sender: 'human', message: 'Hi', createTime: '2026-09-01T00:00:00Z' },
            { responseId: 'r2', sender: 'assistant', message: 'Hello', createTime: '2026-09-01T00:00:01Z', thinking: 'Greet back.',
                model: 'grok-test', steps: [{ text: ['Greet back.'] }], webSearchResults: [{ url: 'https://example.com/a', title: 'A' }] }
        ] };
        const [, assistant] = run('llm', { platform: 'grok', raw, clean: {} }).messages;
        expect(assistant.id).toBe('r2');
        expect(assistant.model).toBe('grok-test');
        expect(assistant.thinking).toBe('Greet back.');
        expect(assistant.sources).toEqual([{ url: 'https://example.com/a', title: 'A' }]);
        for (const field of ['responseId', 'createTime', 'steps', 'webSearchResults']) expect(assistant[field]).toBeUndefined();
    });
});

describe('Claude web search', () => {
    const searchChat = () => ({ uuid: 's', name: 'Search chat', chat_messages: [
        { sender: 'human', text: 'What changed?' },
        { sender: 'assistant', content: [
            { type: 'tool_use', name: 'web_search', input: { query: 'condition new name 2026' } },
            { type: 'tool_result', name: 'web_search', content: [
                { type: 'knowledge', title: 'Cited article', url: 'https://news.example/rename',
                    metadata: { type: 'webpage_metadata', site_domain: 'news.example', favicon_url: 'https://www.google.com/s2/favicons?sz=64&domain=news.example', site_name: 'News' } },
                { type: 'knowledge', title: 'Uncited article', url: 'https://other.example/page',
                    metadata: { site_domain: 'other.example', favicon_url: 'https://www.google.com/s2/favicons?sz=64&domain=other.example' } }
            ] },
            { type: 'text', text: 'It was renamed in 2026.', citations: [
                { start_index: 0, end_index: 22, details: { type: 'web_search_citation', url: 'https://news.example/rename' } }
            ] }
        ] }
    ] });

    test('site icons are never listed as sources', () => {
        const md = run('markdown', { platform: 'claude', raw: searchChat() });
        const json = run('llm', { platform: 'claude', raw: searchChat(), clean: {} });
        expect(md).not.toContain('s2/favicons');
        expect(JSON.stringify(json.context.references)).not.toContain('favicons');
        expect(json.context.references.map((ref) => ref.url)).toEqual(['https://news.example/rename', 'https://other.example/page']);
    });

    test('short tool inputs stay on one line', () => {
        const md = run('markdown', { platform: 'claude', raw: searchChat() });
        expect(md).toContain('{"query":"condition new name 2026"}');
    });
});

describe('Export files', () => {
    const harness = () => {
        let listener;
        const downloads = [];
        const parserContext = createContext({ window: { __chatToolkit: {} } });
        runInContext(readFileSync(resolve(root, 'extension-src/lib/parser-worker.js'), 'utf8'), parserContext);
        const parse = parserContext.window.__chatToolkit.runParserCommand;
        const raw = { uuid: 'synthetic-chat', name: 'Synthetic', chat_messages: [
            { sender: 'human', text: 'Hi' }, { sender: 'assistant', text: 'Hello' }] };
        const ct = { PLATFORM: 'claude', getCurrentId: () => 'synthetic-chat', safeStringify: JSON.stringify,
            fetchClaude: async () => raw, parserCall: async (cmd, args) => parse(cmd, args), notify() {} };
        const context = createContext({ window: { __chatToolkit: ct }, location: new URL('https://claude.ai/chat/synthetic-chat'),
            document: { title: 'Synthetic', readyState: 'loading', addEventListener() {} }, console, setTimeout, setInterval() {},
            browser: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
                async sendMessage(message) { if (message.action === 'download') downloads.push(message); return { success: true }; } } } });
        runInContext(readFileSync(resolve(root, 'extension-src/lib/ui-model.js'), 'utf8'), context);
        runInContext(readFileSync(resolve(root, 'extension-src/lib/content.js'), 'utf8'), context);
        return { send: (message) => listener(message), downloads };
    };

    test('JSON files hold one message per line and parse as JSON', async () => {
        const app = harness();
        await app.send({ action: 'save', scope: 'all', format: 'json' });
        const content = app.downloads[0].content;
        const lines = content.trim().split('\n');
        expect(JSON.parse(content).messages).toHaveLength(2);
        const messageLines = lines.filter((line) => line.startsWith('{"source_index":'));
        expect(messageLines).toHaveLength(2);
        expect(messageLines.map((line) => JSON.parse(line.replace(/,$/, '')).role)).toEqual(['user', 'assistant']);
        expect(content).not.toContain('\n  ');
    });
});
