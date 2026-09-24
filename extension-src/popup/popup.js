// Toolbar popup. It uses the same command model and parts as the page panel
// and asks the chat tab's content script to run each command, then shows the
// outcome the content script reports.

(async () => {
    'use strict';

    const model = globalThis.ChatToolkitModel;
    const { h, icon, mark, FORMATS, SCOPES, PRIMARY, PROVIDERS } = model;
    const d = document;
    const app = d.getElementById('app');

    const styles = d.createElement('style');
    styles.textContent = model.STYLES;
    d.head.appendChild(styles);

    let prefs = await model.loadPrefs();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    let url = null;
    try { url = tab?.url ? new URL(tab.url) : null; } catch {}
    const platform = url?.protocol === 'https:' ? model.providerForHost(url.hostname) : '';
    app.setAttribute('style', model.accentCSS(platform));

    const hint = h(d, 'p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const setHint = (text, kind = '') => {
        hint.textContent = text || '';
        if (kind) hint.dataset.kind = kind; else delete hint.dataset.kind;
    };

    // Title bar with the same small menu as the page panel.
    const menuButton = h(d, 'button', { type: 'button', class: 'tool caret', 'aria-label': 'Menu',
        'aria-haspopup': 'menu', 'aria-expanded': 'false' });
    const menu = h(d, 'div', { class: 'menu face', role: 'menu', hidden: true });
    const closeMenu = () => { menu.hidden = true; menuButton.setAttribute('aria-expanded', 'false'); };
    const menuItem = (iconName, text, onSelect) => {
        const item = h(d, 'button', { type: 'button', class: 'row', role: 'menuitem' },
            icon(d, iconName, 14), h(d, 'span', { class: 'label', text }));
        item.addEventListener('click', () => { closeMenu(); void onSelect(item); });
        return item;
    };
    menuButton.addEventListener('click', () => {
        menu.hidden = !menu.hidden;
        menuButton.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) menu.querySelector('button')?.focus();
    });
    menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { closeMenu(); menuButton.focus(); }
    });
    const help = menuItem('help', 'Help & privacy', async () => {
        await browser.runtime.openOptionsPage();
        window.close();
    });

    app.append(h(d, 'div', { class: 'bar' }, h(d, 'span', { style: 'width:2px' }), mark(d, 14, platform),
        h(d, 'span', { class: 'name', text: 'Chat Toolkit' }),
        platform ? h(d, 'span', { class: 'who', text: PROVIDERS[platform].name }) : null, menuButton), menu);
    const body = h(d, 'div', { class: 'body' }, hint);
    app.appendChild(body);

    if (!platform) {
        menu.appendChild(help);
        setHint(`Open a chat on ${Object.values(PROVIDERS).map((provider) => provider.name).join(', ')} to export it.`);
        return;
    }

    // Show or hide the page panel on this site.
    const host = url.hostname;
    const toggleLabel = () => prefs.hiddenSites.includes(host) ? 'Show panel on this site' : 'Hide panel on this site';
    const toggle = menuItem('hide', toggleLabel(), async (item) => {
        const hidden = new Set(prefs.hiddenSites);
        if (hidden.has(host)) hidden.delete(host); else hidden.add(host);
        prefs = await model.savePrefs({ hiddenSites: [...hidden] });
        item.querySelector('.label').textContent = toggleLabel();
        setHint(prefs.hiddenSites.includes(host) ? 'Panel hidden on this site. Exports still work from here.' : '');
    });
    menu.append(toggle, help);

    const buttons = [];
    let busy = false;
    const confirmTimers = new Map();

    // Copy and Save confirm on their own button, as in the page panel.
    const confirmOn = (button, action, kind, detail) => {
        if (!PRIMARY[action] || kind === 'error') return;
        const label = button.querySelector('.label');
        clearTimeout(confirmTimers.get(action));
        label.textContent = PRIMARY[action].done;
        button.querySelector('svg').replaceWith(icon(d, kind === 'warn' ? 'warning' : 'check', 14));
        button.title = detail;
        confirmTimers.set(action, setTimeout(() => {
            label.textContent = action === 'copy' ? PRIMARY.copy.label(prefs.format) : PRIMARY.save.label();
            button.querySelector('svg').replaceWith(icon(d, PRIMARY[action].icon, 14));
        }, 1600));
    };

    const send = async (action, button) => {
        if (busy) return;
        busy = true;
        for (const item of buttons) item.disabled = true;
        button.setAttribute('aria-busy', 'true');
        setHint('');
        try {
            const reply = await browser.tabs.sendMessage(tab.id, { action, scope: prefs.scope, format: prefs.format });
            if (!reply) throw new Error('The chat page did not answer.');
            const kind = reply.kind || (reply.ok ? 'ok' : 'error');
            const text = [reply.title, reply.detail].filter(Boolean).join('. ');
            confirmOn(button, action, kind, text);
            // Other commands, warnings, and errors are written out.
            if (!PRIMARY[action] || kind === 'warn' || kind === 'error') setHint(text, kind === 'error' ? 'error' : '');
        } catch (error) {
            const missing = /Receiving end does not exist|Could not establish connection/i.test(error?.message || '');
            setHint(missing ? 'Reload the chat page after installing or updating Chat Toolkit, then try again.'
                : (error?.message || String(error)), 'error');
        } finally {
            busy = false;
            button.removeAttribute('aria-busy');
            for (const item of buttons) item.disabled = false;
        }
    };

    const actionButton = (action, iconName, label, className, title) => {
        const button = h(d, 'button', { type: 'button', class: className, 'data-a': action, title },
            icon(d, iconName, 14), h(d, 'span', { class: 'label', text: label }));
        button.addEventListener('click', () => void send(action, button));
        buttons.push(button);
        return button;
    };

    const selector = (name, legend, choices, key) => h(d, 'fieldset', { class: 'seg', 'aria-label': legend },
        choices.map((choice) => {
            const input = h(d, 'input', { type: 'radio', name, value: choice.id, checked: prefs[key] === choice.id,
                title: choice.description });
            input.addEventListener('change', async () => {
                if (!input.checked) return;
                prefs = await model.savePrefs({ [key]: choice.id });
                copyButton.querySelector('.label').textContent = PRIMARY.copy.label(prefs.format);
            });
            return h(d, 'label', { title: choice.description }, input, h(d, 'span', { text: choice.label }));
        }));

    const copyButton = actionButton('copy', 'copy', PRIMARY.copy.label(prefs.format), 'go', PRIMARY.copy.description);
    const saveButton = actionButton('save', 'save', PRIMARY.save.label(), 'go', PRIMARY.save.description);

    body.append(
        h(d, 'div', { class: 'primary' }, copyButton, saveButton),
        selector('scope', 'Messages', SCOPES, 'scope'),
        selector('format', 'File type', FORMATS, 'format'),
        h(d, 'details', {},
            h(d, 'summary', { title: 'All diagnostic tools are in the page panel. Diagnostic files can contain private chat and account data.' }, 'Advanced tools'),
            h(d, 'div', { class: 'adv' },
                actionButton('export-capture', 'archive', 'Diagnostic capture', 'row',
                    'Save the conversation with page and bounded network diagnostics (.capture.json)'),
                actionButton('run-diff', 'compare', 'Compare API and page', 'row',
                    'List text found only in the provider data or only on the page'))));

    try {
        const status = await browser.tabs.sendMessage(tab.id, { action: 'status' });
        if (!status?.conversation && platform !== 'aistudio') setHint('Open a saved chat to export.');
    } catch {
        setHint('Reload the chat page to connect Chat Toolkit.');
    }
})();
