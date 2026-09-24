import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

export const workspace = resolve(import.meta.dir, '../..');

export const loadGrokToolkit = ({ url, fetchImpl, sourceDir = resolve(workspace, 'extension-src') }) => {
    const toolkit = { PLATFORM: 'grok', safeStringify: JSON.stringify };
    const context = createContext({
        window: { __chatToolkit: toolkit },
        document: { cookie: '', title: 'Grok fixture', readyState: 'loading', addEventListener() {} },
        location: new URL(url),
        fetch: fetchImpl || (() => { throw new Error('Unexpected network request'); }),
        URL, URLSearchParams, Headers, Response, TextEncoder, TextDecoder, crypto,
        setTimeout, clearTimeout, console
    });
    for (const name of ['api-fetchers.js', 'parser-worker.js']) {
        runInContext(readFileSync(resolve(sourceDir, 'lib', name), 'utf8'), context, { filename: name });
    }
    return { toolkit, context };
};
