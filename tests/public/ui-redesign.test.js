import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { Window } from 'happy-dom';
import { loadGrokToolkit } from '../helpers/toolkit.js';

const root = resolve(import.meta.dir, '../..');
const source = (name) => readFileSync(resolve(root, 'extension-src', name), 'utf8');
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

const parser = () => loadGrokToolkit({ url: 'https://grok.com/c/synthetic' }).toolkit.runParserCommand;
const chat = (messages) => ({ uuid: 'synthetic', name: 'Synthetic chat', chat_messages: messages });

describe('Export fidelity', () => {
    test('emoji and symbols in messages are exported unchanged', () => {
        const run = parser();
        const text = 'Done ✅ ⚠️ café → \u{1F600} ★';
        const raw = chat([{ sender: 'human', text }, { sender: 'assistant', text: `Reply ${text}` }]);
        expect(run('markdown', { platform: 'claude', raw })).toContain(text);
        const json = run('llm', { platform: 'claude', raw, clean: {} });
        expect(json.messages[0].content).toBe(text);
        expect(run('html', { platform: 'claude', raw })).toContain(text);
    });

    test('blank lines inside fenced code are kept while prose blank runs collapse', () => {
        const run = parser();
        const code = '```python\nimport os\n\n\ndef main():\n    pass\n```';
        const raw = chat([{ sender: 'assistant', text: `Intro\n\n\n\nMore\n\n${code}` }]);
        const md = run('markdown', { platform: 'claude', raw });
        expect(md).toContain('import os\n\n\ndef main():');
        expect(md).toContain('Intro\n\nMore');
        expect(md).not.toContain('Intro\n\n\n');
    });

    test('tool output containing triple backticks gets a longer fence', () => {
        const run = parser();
        const output = 'Result:\n```js\nx()\n```\nend';
        const raw = chat([{ sender: 'assistant', content: [
            { type: 'tool_use', name: 'bash', input: { command: 'cat notes.md' } },
            { type: 'tool_result', content: output }
        ] }]);
        const md = run('markdown', { platform: 'claude', raw });
        expect(md).toContain(`\`\`\`\`\n${output}\n\`\`\`\``);
    });

    test('HTML exports declare an offline, script-free policy and no referrer', () => {
        const html = parser()('html', { platform: 'claude', raw: chat([{ sender: 'human', text: 'Hi' }]) });
        expect(html).toContain(`default-src 'none'`);
        expect(html).toContain('name="referrer" content="no-referrer"');
        const window = new Window();
        window.document.write(html);
        expect(window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull();
    });
});

describe('Scoped exports', () => {
    const raw = chat([
        { sender: 'human', text: 'First question' },
        { sender: 'assistant', text: 'First answer', content: [{ type: 'text', text: 'First answer https://example.com/a' }] },
        { sender: 'human', text: 'Second question' },
        { sender: 'assistant', text: 'Second answer' }
    ]);

    test('JSON keeps only the chosen role and omits the conversation-wide appendix', () => {
        const run = parser();
        const all = run('llm', { platform: 'claude', raw, clean: {} });
        const user = run('llm', { platform: 'claude', raw, clean: {}, role: 'user' });
        expect(all.scope).toBeUndefined();
        expect(all.export_kind).toBe('full_conversation_history');
        expect(user.scope).toBe('user');
        expect(user.export_kind).toBe('user_turns');
        expect(user.messages.map((m) => m.content)).toEqual(['First question', 'Second question']);
        expect(user.omitted.other_roles).toBe(2);
        expect(user.context).toBeUndefined();
    });

    test('HTML keeps only the chosen role and names the scope in its title', () => {
        const html = parser()('html', { platform: 'claude', raw, role: 'assistant' });
        expect(html).toContain('Synthetic chat - Assistant Turns');
        expect(html).toContain('Second answer');
        expect(html).not.toContain('First question');
    });

    test('an unknown role value falls back to the full conversation', () => {
        const html = parser()('html', { platform: 'claude', raw, role: 'system<script>' });
        expect(html).toContain('First question');
        expect(html).toContain('Second answer');
    });

    test('Markdown role output is the pre-existing role renderer', () => {
        const md = parser()('role', { platform: 'claude', raw, role: 'user' });
        expect(md.match(/^## User \d+$/gm)).toHaveLength(2);
    });

    test('count reports messages by role on the selected branch', () => {
        expect(parser()('count', { platform: 'claude', raw })).toEqual({ total: 4, user: 2, assistant: 2 });
    });
});

describe('Parser dispatch', () => {
    const loadBridge = (runParserCommand) => {
        const toolkit = { PLATFORM: 'claude', safeStringify: JSON.stringify, runParserCommand };
        runInContext(source('lib/page-bridge.js'), createContext({ window: { __chatToolkit: toolkit, addEventListener() {} },
            browser: { extension: {} }, console }));
        return toolkit;
    };

    test('commands run in the content script and their errors reach the caller', async () => {
        const toolkit = loadBridge((cmd) => { if (cmd === 'bad') throw new Error('unknown command: bad'); return `ran ${cmd}`; });
        await expect(toolkit.parserCall('bad')).rejects.toThrow('unknown command: bad');
        expect(await toolkit.parserCall('markdown')).toBe('ran markdown');
    });

    test('no Worker is started and no parser script is exposed to web pages', () => {
        expect(source('lib/page-bridge.js')).not.toMatch(/new Worker\(/);
        expect(JSON.parse(source('manifest.json')).web_accessible_resources).toBeUndefined();
    });
});

describe('Shared preferences', () => {
    const loadModel = (privateWindow = false, stored = undefined) => {
        const writes = [];
        const store = stored === undefined ? {} : { uiPrefs: stored };
        const context = createContext({
            browser: { extension: { inIncognitoContext: privateWindow }, storage: { local: {
                async get(key) { return { [key]: store[key] }; },
                async set(value) { writes.push(value); Object.assign(store, value); }
            } } }
        });
        runInContext(source('lib/ui-model.js'), context);
        return { model: context.ChatToolkitModel, writes };
    };

    test('stored values are validated and unknown hosts are dropped', async () => {
        const { model } = loadModel(false, { format: 'exe', scope: 'user', theme: 'neon', dock: 'right',
            position: { x: 'a', y: 2 }, hiddenSites: ['chatgpt.com', 'example.com'] });
        const prefs = await model.loadPrefs();
        expect(prefs.format).toBe('md');
        expect(prefs.scope).toBe('user');
        expect(prefs.theme).toBeUndefined();
        expect(prefs.dock).toBe('right');
        expect(prefs.position).toBeNull();
        expect(prefs.hiddenSites).toEqual(['chatgpt.com']);
    });

    test('preferences are written in normal windows and never in private windows', async () => {
        const normal = loadModel(false);
        await normal.model.savePrefs({ format: 'json' });
        expect(normal.writes).toHaveLength(1);
        const privateWindow = loadModel(true);
        const next = await privateWindow.model.savePrefs({ hiddenSites: ['claude.ai'] });
        expect(next.hiddenSites).toEqual(['claude.ai']);
        expect(privateWindow.writes).toHaveLength(0);
    });
});

function panelHarness(platform = 'chatgpt', prefs = {}) {
    const window = new Window({ url: 'https://chatgpt.com/c/synthetic', width: 1280, height: 800 });
    const roots = [];
    const attach = window.HTMLElement.prototype.attachShadow;
    window.HTMLElement.prototype.attachShadow = function (options) {
        const shadow = attach.call(this, options); roots.push(shadow); return shadow;
    };
    const toolkit = { PLATFORM: platform, safeStringify: JSON.stringify };
    window.__chatToolkit = toolkit;
    const context = createContext({ window, document: window.document, navigator: {}, Blob, setTimeout, clearTimeout, console });
    runInContext(source('lib/ui-model.js'), context);
    runInContext(source('lib/ui-panel.js'), context);
    const actions = [];
    const saved = [];
    const host = toolkit.createPanel((action, options) => actions.push([action, options]),
        { prefs, onPrefs: (patch) => saved.push(patch) });
    window.document.body.appendChild(host);
    const shadow = roots[0];
    const trusted = (element) => element.onclick({ isTrusted: true });
    return { window, toolkit, host, shadow, actions, saved, trusted };
}

describe('Export palette', () => {
    test('primary actions come first, then the two selectors, with Advanced tools last', async () => {
        const { shadow } = panelHarness();
        await tick();
        const body = shadow.querySelector('.body');
        const order = [...body.children].map((node) => node.className || node.tagName.toLowerCase());
        expect(order).toEqual(['hint', 'primary', 'seg', 'seg', 'details', 'sr']);
        expect([...shadow.querySelectorAll('.primary button')].map((b) => b.textContent)).toEqual(['Copy Markdown', 'Save file']);
        expect([...shadow.querySelectorAll('.seg span')].map((span) => span.textContent))
            .toEqual(['All', 'User', 'Assistant', '.md', '.json', '.html']);
        expect(shadow.querySelector('details').open).toBe(false);
    });

    test('there is no drag export, detail level, theme, or status footer', async () => {
        const { shadow } = panelHarness();
        await tick();
        expect(shadow.querySelector('[data-a="drag"]')).toBeNull();
        expect(shadow.querySelector('input[name="ct-detail"]')).toBeNull();
        expect(shadow.textContent).not.toMatch(/Diagnostics off|Theme|Compact|Drag export/);
        expect(shadow.querySelector('.rec').hidden).toBe(true);
    });

    test('the logo and primary buttons take the platform accent', async () => {
        const chatgpt = panelHarness('chatgpt');
        const claude = panelHarness('claude');
        await tick();
        const accent = (harness) => harness.shadow.querySelector('.panel').getAttribute('style');
        expect(accent(chatgpt)).toMatch(/--ac:\s*#2f8f74/);
        expect(accent(claude)).toMatch(/--ac:\s*#c96f50/);
        const markFill = (harness) => harness.shadow.querySelector('.bar svg linearGradient:last-of-type stop').getAttribute('stop-color');
        expect(markFill(chatgpt)).not.toBe(markFill(claude));
    });

    test('actions carry the selected scope and format; changing format relabels Copy and saves the preference', async () => {
        const { shadow, actions, saved, trusted } = panelHarness();
        await tick();
        const choose = (value) => {
            const input = shadow.querySelector(`input[value="${value}"]`);
            input.checked = true;
            input.dispatchEvent(new shadow.ownerDocument.defaultView.Event('change'));
        };
        choose('json');
        choose('user');
        expect(shadow.querySelector('[data-a="copy"]').textContent).toBe('Copy JSON');
        trusted(shadow.querySelector('[data-a="save"]'));
        expect(actions).toEqual([['save', { scope: 'user', format: 'json' }]]);
        expect(saved).toEqual([{ format: 'json' }, { scope: 'user' }]);
    });

    test('synthetic clicks cannot run any command', async () => {
        const { shadow, actions } = panelHarness();
        await tick();
        for (const button of shadow.querySelectorAll('[data-a]')) button.click();
        expect(actions).toHaveLength(0);
    });

    test('diagnostics keep explicit names under Advanced tools, per provider', async () => {
        const chatgpt = panelHarness('chatgpt');
        const grok = panelHarness('grok');
        await tick();
        const names = (harness) => [...harness.shadow.querySelectorAll('details [data-a]')].map((b) => b.textContent);
        expect(chatgpt.shadow.querySelector('summary').textContent).toBe('Advanced tools');
        expect(names(chatgpt)).toEqual(['API inspector', 'Page inspector', 'Compare API and page', 'Network inspector',
            'Diagnostic capture', 'Account capture', 'Record research', 'Stop recording', 'Clear recording', 'Fetch research state', 'Enable page hooks']);
        expect(names(grok)).toEqual(['API inspector', 'Page inspector', 'Compare API and page', 'Network inspector',
            'Diagnostic capture', 'Enable page hooks']);
    });

    test('Copy and Save confirm on their own button, then return to their label', async () => {
        const { shadow, toolkit } = panelHarness();
        await tick();
        const save = shadow.querySelector('[data-a="save"]');
        expect(toolkit.panel().confirm('save', 'ok', 'Saved Markdown to Downloads', '4 messages from ChatGPT.')).toBe(true);
        expect(save.textContent).toBe('Saved');
        expect(save.title).toBe('Saved Markdown to Downloads. 4 messages from ChatGPT.');
        expect(shadow.querySelector('.sr').textContent).toBe('Saved Markdown to Downloads. 4 messages from ChatGPT.');
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 1700));
        expect(save.textContent).toBe('Save file');
        // Warnings and errors also need a notification.
        expect(toolkit.panel().confirm('save', 'warn', 'Saved', 'from the loaded page')).toBe(false);
        expect(toolkit.panel().confirm('save', 'error', 'Export failed', 'x')).toBe(false);
        expect(toolkit.panel().confirm('run-dom', 'info', 'Report')).toBe(false);
    });

    test('an activity indicator appears only while a diagnostic runs', async () => {
        const { shadow, toolkit } = panelHarness();
        await tick();
        toolkit.panel().setActivity(['Research recording on']);
        expect(shadow.querySelector('.rec').hidden).toBe(false);
        expect(shadow.querySelector('.state').textContent).toBe('Research recording on');
        toolkit.panel().setActivity([]);
        expect(shadow.querySelector('.rec').hidden).toBe(true);
        expect(shadow.querySelector('.state').textContent).toBe('');
    });

    test('collapse swaps to a labelled launcher', async () => {
        const { shadow, toolkit, saved } = panelHarness();
        await tick();
        shadow.querySelector('[aria-label="Collapse Chat Toolkit"]').click();
        expect(shadow.querySelector('.panel').hidden).toBe(true);
        expect(shadow.querySelector('.launcher').hidden).toBe(false);
        expect(shadow.querySelector('.launcher').getAttribute('aria-label')).toBe('Open Chat Toolkit');
        expect(saved.at(-1)).toEqual({ collapsed: true });
        expect(toolkit.panel().confirm('copy', 'ok', 'Copied')).toBe(false);
        shadow.querySelector('.launcher').click();
        expect(shadow.querySelector('.panel').hidden).toBe(false);
    });

    test('docking, reset, and hide are menu commands, so moving the panel never requires dragging', async () => {
        const { shadow, saved, window } = panelHarness();
        await tick();
        const menuButton = shadow.querySelector('[aria-label="Panel menu"]');
        menuButton.click();
        expect(menuButton.getAttribute('aria-expanded')).toBe('true');
        const item = (text) => [...shadow.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === text);
        expect([...shadow.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent))
            .toEqual(['Dock left', 'Dock right', 'Reset position', 'Hide on this site', 'Help & privacy']);
        const trustedClick = (element) => {
            const event = new window.MouseEvent('click');
            Object.defineProperty(event, 'isTrusted', { value: true });
            element.dispatchEvent(event);
        };
        item('Dock right').click();
        expect(saved).toHaveLength(0);
        trustedClick(item('Dock right'));
        expect(saved.at(-1)).toEqual({ dock: 'right', position: null });
        expect(shadow.querySelector('.panel').style.right).toBe('8px');
        trustedClick(item('Reset position'));
        expect(saved.at(-1)).toEqual({ dock: 'left', position: null });
        trustedClick(item('Hide on this site'));
        expect(saved.at(-1).hiddenSites).toEqual(['chatgpt.com']);
        expect(shadow.querySelector('#chat-toolkit-panel').hidden).toBe(true);
    });

    test('the grip moves the panel with arrow keys and stays inside the viewport', async () => {
        const { shadow, saved, window } = panelHarness('chatgpt', { dock: 'free', position: { x: 5000, y: -40 } });
        await tick();
        const panel = shadow.querySelector('.panel');
        expect(parseInt(panel.style.left, 10)).toBeLessThanOrEqual(window.innerWidth);
        expect(parseInt(panel.style.top, 10)).toBeGreaterThanOrEqual(8);
        shadow.querySelector('[aria-label="Move panel"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(saved.at(-1).dock).toBe('free');
    });

    test('the panel has no light-DOM content and exposes no moz-extension URL', async () => {
        const { window, host } = panelHarness();
        await tick();
        expect(host.shadowRoot).toBeNull();
        expect(window.document.body.innerHTML).not.toContain('moz-extension');
        expect(window.document.querySelector('[data-a]')).toBeNull();
    });
});

function contentHarness({ platform = 'claude', url = 'https://claude.ai/chat/synthetic-chat', raw, origin = 'api', id = 'synthetic-chat' } = {}) {
    let listener;
    const downloads = [];
    const copied = [];
    const parserCalls = [];
    const sent = [];
    const run = parser();
    const conversation = raw || { uuid: 'synthetic-chat', name: 'Synthetic conversation', _source: origin, chat_messages: [
        { sender: 'human', text: 'Hello' }, { sender: 'assistant', text: 'Hi there' }] };
    const toolkit = {
        PLATFORM: platform, getCurrentId: () => id, getClaudeOrgId: () => 'org', safeStringify: JSON.stringify,
        fetchClaude: async () => conversation,
        parserCall: async (cmd, args) => { parserCalls.push([cmd, args.role]); return run(cmd, args); },
        copyToClipboard: async (html, text) => { copied.push({ html, text }); return true; },
        withPageCapture: async (fn) => fn(), getPageState: () => ({}),
        captureDOMSnapshot: () => ({ messages: [], code_blocks: [], attachments: [], selector_counts: {} }),
        notify() {}, showReport: ({ report }) => ({ title: report.title }),
        enablePageHooks() { toolkit.hooks = true; }, pageHooksEnabled: () => !!toolkit.hooks
    };
    const context = createContext({
        window: { __chatToolkit: toolkit }, location: new URL(url), console, setTimeout, setInterval() {}, globalThis: {},
        document: { title: 'Synthetic conversation', readyState: 'loading', addEventListener() {} },
        browser: { runtime: {
            onMessage: { addListener(fn) { listener = fn; } },
            async sendMessage(message) {
                sent.push(message.action);
                if (message.action === 'download') downloads.push(message);
                if (message.action.startsWith('network-capture')) return { success: true, network: { requests: [] } };
                return { success: true };
            }
        } }
    });
    runInContext(source('lib/ui-model.js'), context);
    runInContext(source('lib/content.js'), context);
    return { send: (message) => listener(message), downloads, copied, parserCalls, sent, toolkit };
}

describe('Content-script export pipeline', () => {
    test('a popup request resolves with the actual outcome, filename, and message count', async () => {
        const app = contentHarness();
        const result = await app.send({ action: 'save', scope: 'all', format: 'json' });
        expect(result.ok).toBe(true);
        expect(result.title).toBe('Saved JSON to Downloads');
        expect(result.detail).toMatch(/^claude_Synthetic conversation_\d{4}-\d\d-\d\d\.json\. 2 messages from Claude\.$/);
        expect(app.downloads[0].type).toBe('application/json');
        expect(JSON.parse(app.downloads[0].content).messages).toHaveLength(2);
    });

    test('scope and format select the matching renderer and filename', async () => {
        const app = contentHarness();
        await app.send({ action: 'save', scope: 'user', format: 'md' });
        await app.send({ action: 'save', scope: 'assistant', format: 'html' });
        await app.send({ action: 'save', scope: 'user', format: 'json' });
        expect(app.downloads.map((d) => d.filename.replace(/\d{4}-\d\d-\d\d/, 'DATE'))).toEqual([
            'claude_Synthetic conversation_DATE_user_turns.md',
            'claude_Synthetic conversation_DATE_assistant_turns.html',
            'claude_Synthetic conversation_DATE_user_turns.json'
        ]);
        expect(app.parserCalls.filter(([cmd]) => cmd !== 'clean' && cmd !== 'count'))
            .toEqual([['role', 'user'], ['html', 'assistant'], ['llm', 'user']]);
    });

    test('legacy direct-export actions still produce the original files', async () => {
        const app = contentHarness();
        for (const action of ['export-json', 'export-md', 'export-html', 'export-user-turns', 'export-assistant-turns']) {
            expect((await app.send({ action })).ok).toBe(true);
        }
        expect(app.downloads.map((d) => d.filename.replace(/\d{4}-\d\d-\d\d/, 'DATE'))).toEqual([
            'claude_Synthetic conversation_DATE.json', 'claude_Synthetic conversation_DATE.md',
            'claude_Synthetic conversation_DATE.html', 'claude_Synthetic conversation_DATE_user_turns.md',
            'claude_Synthetic conversation_DATE_assistant_turns.md'
        ]);
    });

    test('Markdown copy carries rendered HTML; JSON copy is plain text', async () => {
        const app = contentHarness();
        await app.send({ action: 'copy', scope: 'all', format: 'md' });
        await app.send({ action: 'copy', scope: 'all', format: 'json' });
        expect(app.copied[0].text).toContain('## User');
        expect(app.copied[0].html).toContain('<!DOCTYPE html>');
        expect(app.copied[1].html).toBe('');
        expect(JSON.parse(app.copied[1].text).messages).toHaveLength(2);
    });

    test('a loaded-page fallback is reported as a warning, not a complete export', async () => {
        const app = contentHarness({ raw: { name: 'DOM chat', _source: 'dom', messages: [
            { role: 'user', content: 'Visible question' }] } });
        app.toolkit.fetchClaude = async () => { throw new Error('API unavailable'); };
        app.toolkit.DOM = { claude: () => ({ name: 'DOM chat', _source: 'dom', messages: [{ role: 'user', content: 'Visible question' }] }) };
        const result = await app.send({ action: 'save', scope: 'all', format: 'md' });
        expect(result.kind).toBe('warn');
        expect(result.detail).toContain('from the loaded page');
    });

    test('failures resolve with a readable reason instead of a false success', async () => {
        const app = contentHarness({ id: '' });
        const result = await app.send({ action: 'save', scope: 'all', format: 'md' });
        expect(result.ok).toBe(false);
        expect(result.title).toBe('Export failed');
        expect(result.detail).toBe('Open a saved conversation first. This page address does not identify one.');
    });

    test('Enable page hooks no longer turns on research recording', async () => {
        const app = contentHarness({ platform: 'chatgpt', url: 'https://chatgpt.com/c/synthetic-chat' });
        const result = await app.send({ action: 'enable-page-hooks' });
        expect(result.title).toBe('Page hooks enabled');
        expect(app.sent).not.toContain('diagnostics-start');
        expect(app.toolkit.hooks).toBe(true);
    });

    test('the Network inspector records until selected again instead of a fixed 250 ms window', async () => {
        const app = contentHarness();
        const first = await app.send({ action: 'run-sniffer' });
        expect(first.title).toBe('Network inspector recording');
        expect(app.sent).toEqual(['network-capture-start']);
        const second = await app.send({ action: 'run-sniffer' });
        expect(second.detail).toBe('Report opened');
        expect(app.sent).toEqual(['network-capture-start', 'network-capture-get', 'network-capture-stop']);
    });

    test('unknown and inherited action names are ignored', async () => {
        const app = contentHarness();
        expect(app.send({ action: 'constructor' })).toBeUndefined();
        expect(app.send({ action: 'toString' })).toBeUndefined();
        expect(app.downloads).toHaveLength(0);
    });
});

describe('Toolbar popup', () => {
    const popup = async (tabUrl, reply = { ok: true, kind: 'ok', title: 'Saved Markdown to Downloads', detail: 'file.md' }) => {
        const window = new Window({ url: 'moz-extension://synthetic/popup/popup.html' });
        const html = source('popup/popup.html').replace(/<script[^>]*><\/script>/g, '');
        window.document.write(html);
        const messages = [];
        const browser = {
            tabs: {
                async query() { return [{ id: 7, url: tabUrl }]; },
                async sendMessage(id, message) {
                    messages.push([id, message]);
                    return message.action === 'status' ? { conversation: true, context: 'Saved conversation open' } : reply;
                }
            },
            runtime: { async openOptionsPage() {} },
            storage: { local: { async get() { return {}; }, async set() {} } },
            extension: { inIncognitoContext: false }
        };
        const context = createContext({ window, document: window.document, browser, URL, console, setTimeout, clearTimeout });
        context.globalThis = context;
        runInContext(source('lib/ui-model.js'), context);
        runInContext(source('popup/popup.js'), context);
        for (let i = 0; i < 10; i++) await tick();
        return { document: window.document, messages };
    };

    test('on a supported chat it offers the same controls and confirms on the pressed button', async () => {
        const { document, messages } = await popup('https://chatgpt.com/c/abc');
        expect(document.querySelector('.who').textContent).toBe('ChatGPT');
        expect(document.getElementById('app').getAttribute('style')).toMatch(/--ac:\s*#2f8f74/);
        expect([...document.querySelectorAll('.primary button')].map((b) => b.textContent)).toEqual(['Copy Markdown', 'Save file']);
        expect([...document.querySelectorAll('.seg span')].map((s) => s.textContent))
            .toEqual(['All', 'User', 'Assistant', '.md', '.json', '.html']);
        document.querySelector('[data-a="save"]').click();
        for (let i = 0; i < 5; i++) await tick();
        expect(messages.at(-1)).toEqual([7, { action: 'save', scope: 'all', format: 'md' }]);
        expect(document.querySelector('[data-a="save"]').textContent).toBe('Saved');
        expect(document.querySelector('[data-a="save"]').title).toBe('Saved Markdown to Downloads. file.md');
        expect(document.querySelector('.hint').textContent).toBe('');
    });

    test('errors are written out, and the page panel can be shown or hidden from the menu', async () => {
        const { document } = await popup('https://chatgpt.com/c/abc', { ok: false, kind: 'error', title: 'Export failed', detail: 'Open a saved conversation first.' });
        document.querySelector('[data-a="copy"]').click();
        for (let i = 0; i < 5; i++) await tick();
        expect(document.querySelector('.hint').textContent).toBe('Export failed. Open a saved conversation first.');
        expect([...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent))
            .toEqual(['Hide panel on this site', 'Help & privacy']);
    });

    test('on another site it explains where the extension works and offers no export', async () => {
        const { document, messages } = await popup('https://example.com/');
        expect(document.querySelector('.hint').textContent).toContain('Open a chat on Claude, ChatGPT');
        expect(document.querySelector('[data-a]')).toBeNull();
        expect(messages).toHaveLength(0);
    });
});

describe('Manifest and packaged assets', () => {
    const manifest = JSON.parse(source('manifest.json'));

    test('permissions exclude unused access and include only layout storage', () => {
        expect(manifest.permissions).not.toContain('activeTab');
        expect(manifest.permissions).not.toContain('https://api.anthropic.com/*');
        expect(manifest.permissions).toContain('storage');
        expect(manifest.permissions.filter((p) => p.includes('://'))).toEqual([
            'https://claude.ai/*', 'https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://gemini.google.com/*',
            'https://aistudio.google.com/*', 'https://grok.com/*', 'https://openrouter.ai/*']);
        expect(source('lib/background.js')).not.toContain('api.anthropic.com');
    });

    test('every declared icon exists, including light and dark toolbar variants', () => {
        const paths = [...Object.values(manifest.icons), ...Object.values(manifest.browser_action.default_icon),
            ...manifest.browser_action.theme_icons.flatMap((icon) => [icon.light, icon.dark])];
        expect(paths.length).toBeGreaterThan(10);
        for (const path of paths) expect(existsSync(resolve(root, 'extension-src', path))).toBe(true);
        expect(manifest.browser_action.theme_icons.map((icon) => icon.size)).toEqual([16, 32, 64]);
    });

    test('the shared model loads before the panel and content script', () => {
        const scripts = manifest.content_scripts[0].js;
        expect(scripts.indexOf('lib/ui-model.js')).toBeGreaterThan(scripts.indexOf('lib/common.js'));
        expect(scripts.indexOf('lib/ui-model.js')).toBeLessThan(scripts.indexOf('lib/ui-panel.js'));
        expect(source('popup/popup.html')).toContain('../lib/ui-model.js');
    });

    test('no runtime script assigns markup strings to innerHTML', () => {
        for (const name of ['lib/ui-panel.js', 'lib/content.js', 'lib/ui-model.js', 'popup/popup.js']) {
            expect(source(name)).not.toMatch(/\.innerHTML\s*=/);
        }
    });
});
