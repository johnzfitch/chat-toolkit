import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dir, '../..');
const commonSource = readFileSync(resolve(workspace, 'extension-src/lib/common.js'), 'utf8');
const fetcherSource = readFileSync(resolve(workspace, 'extension-src/lib/api-fetchers.js'), 'utf8');
const parserURL = new URL('../../extension-src/lib/parser-worker.js', import.meta.url);
const workers = new Set();

const parserCall = (cmd, args) => new Promise((resolveCall, rejectCall) => {
    const worker = new Worker(parserURL);
    workers.add(worker);
    const id = `${Date.now()}-${Math.random()}`;
    worker.addEventListener('message', (event) => {
        if (event.data?.id !== id) return;
        workers.delete(worker);
        worker.terminate();
        if (event.data.error) rejectCall(new Error(event.data.error));
        else resolveCall(event.data.result);
    });
    worker.addEventListener('error', (event) => {
        workers.delete(worker);
        worker.terminate();
        rejectCall(event.error || new Error(event.message));
    });
    worker.postMessage({ id, cmd, args });
});

afterAll(() => {
    for (const worker of workers) worker.terminate();
});

const loadGeminiCode = () => {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        location: globalThis.location,
        fetch: globalThis.fetch
    };
    globalThis.window = {};
    globalThis.document = {
        cookie: '',
        title: 'Synthetic conversation - Google Gemini',
        querySelectorAll: () => []
    };
    globalThis.location = new URL('https://gemini.google.com/app/1111111111111111');
    globalThis.fetch = () => Promise.reject(new Error('unexpected fetch'));
    new Function(commonSource)();
    new Function(fetcherSource)();
    return {
        toolkit: globalThis.window.__chatToolkit,
        restore: () => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    };
};

const currentGeminiTurn = ({ prompt, candidates, selected, timestamp }) => {
    const turn = [];
    turn[0] = ['c_fixture', `r_${timestamp}`];
    turn[2] = [[prompt]];
    turn[3] = [];
    turn[3][0] = candidates.map(({ id, text, thinking }) => {
        const candidate = [id, [text]];
        if (thinking) candidate[37] = [[thinking]];
        return candidate;
    });
    turn[3][3] = selected;
    turn[4] = [timestamp, 0];
    return turn;
};

describe('Gemini full-history extraction', () => {
    test('uses the selected Gemini response and orders newest-first records chronologically', () => {
        const { toolkit, restore } = loadGeminiCode();
        let messages;
        try {
            const newer = currentGeminiTurn({
                prompt: 'Newest prompt',
                candidates: [
                    { id: 'rc_discarded', text: 'Discarded response', thinking: 'Discarded thinking' },
                    { id: 'rc_selected', text: 'Selected response', thinking: 'Selected thinking' }
                ],
                selected: 'rc_selected',
                timestamp: 200
            });
            const older = currentGeminiTurn({
                prompt: 'Oldest prompt',
                candidates: [{ id: 'rc_oldest', text: 'Oldest response' }],
                selected: 'rc_oldest',
                timestamp: 100
            });
            messages = toolkit.extractGeminiTurns({ data: [[newer, older]] });
        } finally {
            restore();
        }

        expect(messages.map(({ content }) => content)).toEqual([
            'Oldest prompt', 'Oldest response', 'Newest prompt', 'Selected response'
        ]);
        expect(messages[3].thinking).toBe('Selected thinking');
    });
});
