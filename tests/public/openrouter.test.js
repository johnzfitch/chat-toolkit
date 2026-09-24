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

const fakeIndexedDB = (databaseName, values) => {
    const transactionModes = [];
    let closed = false;
    const database = {
        objectStoreNames: { contains: (name) => name === databaseName },
        transaction(name, mode) {
            if (name !== databaseName) throw new Error(`unexpected object store: ${name}`);
            transactionModes.push(mode);
            return {
                objectStore: () => ({
                    get(key) {
                        const request = {};
                        queueMicrotask(() => {
                            request.result = values.has(key)
                                ? { key, value: values.get(key) }
                                : undefined;
                            request.onsuccess?.();
                        });
                        return request;
                    }
                })
            };
        },
        close() { closed = true; }
    };
    const factory = {
        databases: async () => [{ name: databaseName, version: 1 }],
        open(name) {
            const request = {};
            queueMicrotask(() => {
                if (name !== databaseName) {
                    request.error = new Error(`unexpected database: ${name}`);
                    request.onerror?.();
                    return;
                }
                request.result = database;
                request.onsuccess?.();
            });
            return request;
        }
    };
    return {
        factory,
        transactionModes,
        wasClosed: () => closed
    };
};

const loadFetchers = ({ url, indexedDB }) => {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        location: globalThis.location,
        indexedDB: globalThis.indexedDB,
        fetch: globalThis.fetch
    };
    const toolkit = {
        PLATFORM: 'openrouter',
        safeStringify: JSON.stringify,
        decodeBatchExecute: () => [],
        batchPayload: () => null,
        sleep: () => Promise.resolve()
    };
    globalThis.window = { __chatToolkit: toolkit, indexedDB };
    globalThis.document = { cookie: '', title: 'OpenRouter fixture' };
    globalThis.location = new URL(url);
    globalThis.indexedDB = indexedDB;
    globalThis.fetch = () => Promise.reject(new Error('unexpected fetch'));
    new Function(fetcherSource)();
    return {
        toolkit,
        restore: () => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    };
};

const roomId = 'orc-1700000000-SyntheticRoomFixture';
const databaseName = 'openrouter:playground:guest:v3';

const storedValues = new Map([
    [`v3:room:${roomId}`, {
        id: roomId,
        title: 'Reasoning export fixture',
        createdAt: '2026-08-21T18:00:00.000Z',
        updatedAt: '2026-08-21T18:01:00.000Z'
    }],
    [`v3:manifest:${roomId}`, {
        messageIds: ['assistant-message', 'user-message'],
        characterIds: ['assistant-character', 'user-character'],
        itemIds: ['reasoning-item', 'output-item', 'input-item']
    }],
    ['v3:character:assistant-character', {
        id: 'assistant-character',
        name: 'DeepSeek R1',
        model: 'deepseek/deepseek-r1'
    }],
    ['v3:character:user-character', { id: 'user-character', name: 'User' }],
    ['v3:message:user-message', {
        id: 'user-message',
        type: 'user',
        characterId: 'user-character',
        createdAt: '2026-08-21T18:00:00.000Z',
        items: [{ id: 'input-item', outputIndex: 0 }]
    }],
    ['v3:message:assistant-message', {
        id: 'assistant-message',
        type: 'assistant',
        characterId: 'assistant-character',
        createdAt: '2026-08-21T18:00:01.000Z',
        metadata: { variantSlug: 'deepseek/deepseek-r1:free', provider: 'Chutes' },
        // Deliberately reversed: outputIndex is the persisted presentation order.
        items: [
            { id: 'output-item', outputIndex: 1 },
            { id: 'reasoning-item', outputIndex: 0 }
        ]
    }],
    ['v3:item:input-item', {
        id: 'input-item',
        messageId: 'user-message',
        data: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is 2 + 2?' }] }
    }],
    ['v3:item:reasoning-item', {
        id: 'reasoning-item',
        messageId: 'assistant-message',
        data: {
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: 'Add the two integers.' }],
            summary: [{ type: 'summary_text', text: 'A shorter summary.' }]
        }
    }],
    ['v3:item:output-item', {
        id: 'output-item',
        messageId: 'assistant-message',
        data: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 4.' }] }
    }]
]);

describe('OpenRouter local chat fetching', () => {
    test('hydrates the active room from readonly v3 IndexedDB records', async () => {
        const fake = fakeIndexedDB(databaseName, storedValues);
        const { toolkit, restore } = loadFetchers({
            url: `https://openrouter.ai/chat?room=${roomId}`,
            indexedDB: fake.factory
        });
        try {
            expect(toolkit.getCurrentId()).toBe(roomId);
            const raw = await toolkit.fetchOpenRouter(roomId);
            expect(raw._source).toBe('indexeddb');
            expect(raw.chat_messages.map((message) => message.id)).toEqual([
                'user-message',
                'assistant-message'
            ]);
            expect(raw.chat_messages[1].name).toBe('DeepSeek R1');
            expect(raw.chat_messages[1].model).toBe('deepseek/deepseek-r1:free');
            expect(raw.chat_messages[1].items[1].data.type).toBe('reasoning');
            expect(fake.transactionModes.every((mode) => mode === 'readonly')).toBeTrue();
            expect(fake.wasClosed()).toBeTrue();
        } finally {
            restore();
        }
    });

    test('backfills legacy per-message output and reasoning records', async () => {
        const legacyId = 'orc-legacy-room';
        const legacyValues = new Map([
            [`v3:room:${legacyId}`, { id: legacyId, title: 'Legacy room' }],
            [`v3:manifest:${legacyId}`, {
                messageIds: ['legacy-assistant'],
                characterIds: ['assistant-character'],
                itemIds: []
            }],
            ['v3:character:assistant-character', {
                id: 'assistant-character',
                name: 'Legacy Model',
                model: 'example/legacy-model'
            }],
            ['v3:message:legacy-assistant', {
                id: 'legacy-assistant',
                type: 'assistant',
                characterId: 'assistant-character',
                createdAt: '2026-08-20T10:00:00.000Z',
                items: []
            }],
            ['v3:content:legacy-assistant', 'Legacy final output.'],
            ['v3:reasoning:legacy-assistant', 'Legacy plaintext reasoning.']
        ]);
        const fake = fakeIndexedDB(databaseName, legacyValues);
        const { toolkit, restore } = loadFetchers({
            url: `https://openrouter.ai/chat?room=${legacyId}`,
            indexedDB: fake.factory
        });
        let raw;
        try { raw = await toolkit.fetchOpenRouter(legacyId); }
        finally { restore(); }

        expect(raw.chat_messages[0].content).toBe('Legacy final output.');
        expect(raw.chat_messages[0].reasoning).toBe('Legacy plaintext reasoning.');
        const clean = await parserCall('clean', { platform: 'openrouter', raw });
        expect(clean.messages[0].content).toBe('Legacy final output.');
        expect(clean.messages[0].reasoning).toBe('Legacy plaintext reasoning.');
    });
});

describe('OpenRouter output and reasoning exports', () => {
    test('keeps plaintext reasoning separate from final output in every export', async () => {
        const fake = fakeIndexedDB(databaseName, storedValues);
        const { toolkit, restore } = loadFetchers({
            url: `https://openrouter.ai/chat?room=${roomId}`,
            indexedDB: fake.factory
        });
        let raw;
        try { raw = await toolkit.fetchOpenRouter(roomId); }
        finally { restore(); }

        const clean = await parserCall('clean', { platform: 'openrouter', raw });
        const assistant = clean.messages.find((message) => message.role === 'assistant');
        expect(assistant.content).toBe('The answer is 4.');
        expect(assistant.reasoning).toBe('Add the two integers.');
        expect(assistant.blocks.map((block) => block.kind)).toEqual(['thinking', 'text']);

        const [markdown, html, llm] = await Promise.all([
            parserCall('markdown', { platform: 'openrouter', raw }),
            parserCall('html', { platform: 'openrouter', raw }),
            parserCall('llm', { platform: 'openrouter', raw, clean, fallbackTitle: '', fallbackId: '' })
        ]);
        expect(markdown).toContain('## Assistant · DeepSeek R1');
        expect(markdown.indexOf('Add the two integers.')).toBeLessThan(markdown.indexOf('The answer is 4.'));
        expect(markdown).toContain('<think>');
        expect(html).toContain('Assistant · DeepSeek R1');
        expect(html).toContain('Add the two integers.');

        const llmAssistant = llm.messages.find((message) => message.role === 'assistant');
        expect(llmAssistant.content).toBe('The answer is 4.');
        expect(llmAssistant.reasoning).toBe('Add the two integers.');
        expect(llmAssistant.channel).toBe('reasoning_and_final');
        // Output and reasoning are not repeated as blocks.
        expect(llmAssistant.blocks).toBeUndefined();
    });

    test('uses OpenRouter reasoning summaries when full reasoning text is absent', async () => {
        const raw = {
            id: 'summary-only',
            chat_messages: [{
                id: 'assistant-summary',
                type: 'assistant',
                role: 'assistant',
                items: [
                    {
                        id: 'reasoning-summary',
                        outputIndex: 0,
                        data: {
                            type: 'reasoning',
                            summary: [{ type: 'summary_text', text: 'Reasoning summary only.' }]
                        }
                    },
                    {
                        id: 'answer',
                        outputIndex: 1,
                        data: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Final output.' }]
                        }
                    }
                ]
            }]
        };
        const clean = await parserCall('clean', { platform: 'openrouter', raw });
        expect(clean.messages[0].reasoning).toBe('Reasoning summary only.');
        expect(clean.messages[0].content).toBe('Final output.');
    });
});
