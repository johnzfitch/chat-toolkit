// UI surfaces: the export palette, notifications, the report window, and
// clipboard helpers. Everything that adds nodes to the host page lives here,
// inside closed shadow roots, built with DOM APIs from ui-model.js.

(function () {
    'use strict';

    const CT = window.__chatToolkit;
    if (!CT) return;

    const { PLATFORM } = CT;
    const M = () => CT.model || globalThis.ChatToolkitModel;

    // Reports and copy buffers must not be readable through the host page's
    // ordinary DOM queries. Keep references in the isolated content script.
    const mountPrivateUI = (element, styles = '') => {
        const host = document.createElement('div');
        if (element.id) host.id = element.id;
        const root = host.attachShadow({ mode: 'closed' });
        if (styles) {
            const style = document.createElement('style');
            style.textContent = styles;
            root.appendChild(style);
        }
        root.appendChild(element);
        return host;
    };

    const sharedStyles = () => `:host{all:initial}${M()?.STYLES || ''}`;
    const accentStyle = () => M()?.accentCSS(PLATFORM) || '';

    // ---- notifications ---------------------------------------------------

    const TOAST_CSS = `
        .toast{position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;gap:6px;align-items:flex-start;
            max-width:min(300px,calc(100vw - 24px));padding:6px 8px}
        .toast strong{display:block;font-size:11.5px}
        .toast small{display:block;color:var(--muted);font-size:10.5px;overflow-wrap:anywhere}
        .toast svg{flex:none;margin-top:1px}`;

    const notify = (title, msg = '', kind = 'info') => {
        const model = M();
        const text = document.createElement('div');
        const heading = document.createElement('strong');
        heading.textContent = title;
        text.appendChild(heading);
        if (msg) {
            const detail = document.createElement('small');
            detail.textContent = msg;
            text.appendChild(detail);
        }
        const el = document.createElement('div');
        el.className = 'ct face toast';
        el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        if (model) el.appendChild(model.icon(document, { ok: 'check', warn: 'warning', error: 'error' }[kind] || 'info', 14));
        el.appendChild(text);
        const host = mountPrivateUI(el, sharedStyles() + TOAST_CSS);
        document.body.appendChild(host);
        setTimeout(() => host.remove(), kind === 'error' || kind === 'warn' ? 7000 : 4000);
    };

    // ---- clipboard -------------------------------------------------------

    const legacyCopyText = (text) => {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none;';
        const host = mountPrivateUI(area);
        document.body.appendChild(host);
        area.focus();
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch {}
        host.remove();
        return ok;
    };

    // `html` is optional rich text; `text` is always written as text/plain.
    const copyToClipboard = async (html, text) => {
        try {
            const items = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
            if (html) items['text/html'] = new Blob([html], { type: 'text/html' });
            await navigator.clipboard.write([new ClipboardItem(items)]);
            return true;
        } catch {
            try { await navigator.clipboard.writeText(text); return true; }
            catch { return legacyCopyText(text); }
        }
    };

    // ---- report window ---------------------------------------------------

    let reportPanel = null;
    let latestReport = null;
    const REPORT_MAX_CHARS = 600000;
    const REPORT_MAX_STRING_CHARS = 8000;
    const REPORT_MAX_ARRAY_ITEMS = 40;
    const REPORT_MAX_OBJECT_KEYS = 50;
    const REPORT_MAX_DEPTH = 6;
    const REPORT_RENDER_CHARS = 160000;

    const compactForReport = (value) => {
        const state = { remaining: REPORT_MAX_CHARS, seen: new WeakSet() };
        const visit = (current, depth) => {
            if (state.remaining <= 0) return '[report budget reached]';
            if (current == null || typeof current === 'boolean' || typeof current === 'number') return current;
            if (typeof current === 'string') {
                const max = Math.max(0, Math.min(REPORT_MAX_STRING_CHARS, state.remaining));
                const clipped = current.length > max
                    ? `${current.slice(0, Math.max(0, max - 32))}… [${current.length - max} chars omitted]`
                    : current;
                state.remaining -= Math.min(clipped.length, state.remaining);
                return clipped;
            }
            if (typeof current !== 'object') return String(current).slice(0, 200);
            if (state.seen.has(current)) return '[Circular]';
            if (depth >= REPORT_MAX_DEPTH) return '[depth limit]';
            state.seen.add(current);

            if (Array.isArray(current)) {
                const output = [];
                const limit = Math.min(current.length, REPORT_MAX_ARRAY_ITEMS);
                for (let index = 0; index < limit && state.remaining > 0; index++) {
                    output.push(visit(current[index], depth + 1));
                }
                if (current.length > limit) output.push(`[… ${current.length - limit} items omitted …]`);
                return output;
            }

            const output = {};
            let count = 0;
            let limited = false;
            try {
                for (const key in current) {
                    if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
                    if (count >= REPORT_MAX_OBJECT_KEYS || state.remaining <= 0) {
                        limited = true;
                        break;
                    }
                    const safeKey = String(key).slice(0, 200);
                    state.remaining -= Math.min(safeKey.length, state.remaining);
                    try { output[safeKey] = visit(current[key], depth + 1); }
                    catch { output[safeKey] = '[unreadable]'; }
                    count += 1;
                }
            } catch {
                return '[unreadable object]';
            }
            if (limited) output._report_omitted_keys = 'additional keys omitted';
            return output;
        };
        return visit(value, 0);
    };

    const REPORT_CSS = `
        #chat-toolkit-report{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:min(640px,calc(100vw - 24px));display:none}
        #chat-toolkit-report.open{display:block}
        .rt-title{flex:1;margin:0;font-size:11.5px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .rt-actions{display:flex;gap:3px}
        .rt-actions button{height:17px;padding:0 6px;border:1px solid var(--key);border-radius:3px;font-size:10.5px;
            background:linear-gradient(var(--key-top),var(--key-bot));box-shadow:inset 0 1px 0 var(--key-hi)}
        .rt-actions button:active{background:linear-gradient(var(--press-top),var(--press-bot));box-shadow:inset 0 1px 2px var(--key-lo)}
        .rt-body{padding:6px}
        .rt-summary{margin:0 0 3px;color:var(--muted)}
        .rt-meta{margin:0 0 5px;color:var(--muted);font-size:10.5px}
        pre{margin:0;max-height:50vh;overflow:auto;padding:6px;border:1px solid var(--key);border-radius:3px;background:var(--well);
            box-shadow:inset 0 1px 2px var(--key-lo);white-space:pre-wrap;font:11px/1.4 Consolas,"Lucida Console",monospace}`;

    const ensureReportPanel = ({ onCopy, onDownload }) => {
        if (reportPanel?.isConnected) return reportPanel;
        const { h } = M();
        const d = document;
        const copyButton = h(d, 'button', { type: 'button', 'data-report': 'copy', text: 'Copy' });
        const saveButton = h(d, 'button', { type: 'button', 'data-report': 'download', text: 'Save' });
        const closeButton = h(d, 'button', { type: 'button', 'data-report': 'close', text: 'Close' });
        reportPanel = h(d, 'div', { id: 'chat-toolkit-report', class: 'ct face', role: 'dialog', 'aria-label': 'Chat Toolkit report' },
            h(d, 'div', { class: 'bar' },
                h(d, 'h2', { class: 'rt-title', text: 'Report' }),
                h(d, 'div', { class: 'rt-actions' }, copyButton, saveButton, closeButton)),
            h(d, 'div', { class: 'rt-body' },
                h(d, 'p', { class: 'rt-summary' }),
                h(d, 'div', { class: 'rt-meta' }),
                h(d, 'pre', { class: 'rt-content', tabindex: '0' })));
        closeButton.onclick = () => reportPanel.classList.remove('open');
        copyButton.onclick = (event) => { if (event.isTrusted) onCopy?.(latestReport); };
        saveButton.onclick = (event) => { if (event.isTrusted) onDownload?.(latestReport); };
        reportPanel.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') reportPanel.classList.remove('open');
        });
        document.body.appendChild(mountPrivateUI(reportPanel, sharedStyles() + REPORT_CSS));
        return reportPanel;
    };

    const showReport = ({ report, onCopy, onDownload, emitToPage }) => {
        const title = report.title || 'Report';
        const rows = Array.isArray(report.rows) ? report.rows : [];
        const payload = compactForReport({
            platform: PLATFORM,
            generated_at: new Date().toISOString(),
            title,
            summary: report.summary || '',
            rows,
            data: report.data ?? null
        });
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';

        latestReport = {
            filename: report.filename || `${PLATFORM}_${slug}.json`,
            text: CT.safeStringify(payload),
            type: report.type || 'application/json'
        };

        const panel = ensureReportPanel({ onCopy, onDownload });
        panel.querySelector('.rt-title').textContent = title;
        panel.querySelector('.rt-summary').textContent = report.summary || 'Structured report ready.';
        panel.querySelector('.rt-meta').textContent = rows.length ? `${rows.length} summary rows` : 'Structured report';
        panel.querySelector('.rt-content').textContent = latestReport.text.length > REPORT_RENDER_CHARS
            ? `${latestReport.text.slice(0, REPORT_RENDER_CHARS)}\n\n… report preview clipped; Copy/Save contains the bounded full report …`
            : latestReport.text;
        panel.classList.add('open');

        emitToPage?.(payload);
        return { title, detail: 'Report opened' };
    };

    // ---- export palette --------------------------------------------------

    const PANEL_CSS = `
        .panel{position:fixed;z-index:2147483646;width:224px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto}
        .panel[hidden],.launcher[hidden]{display:none!important}
        .menu{right:4px;top:24px}
        .launcher{position:fixed;z-index:2147483646;display:grid;place-items:center;width:26px;height:26px;padding:0;border-radius:5px;cursor:pointer}
        .launcher:active{box-shadow:inset 0 1px 3px var(--key-lo)}`;

    let panelApi = null;

    const createPanel = (handleAction, options = {}) => {
        const model = M();
        const { h, icon, mark, FORMATS, SCOPES, PRIMARY, PROVIDERS, advancedFor } = model;
        const d = document;
        let prefs = model.normalizePrefs(options.prefs);
        const onPrefs = options.onPrefs || (() => {});
        const providerName = PROVIDERS[PLATFORM]?.name || PLATFORM;

        // Every data action requires a trusted click. The action name is bound
        // in this closure, so changing a button's attributes cannot redirect it.
        const bindAction = (button, action) => {
            button.onclick = (event) => {
                if (!event.isTrusted) return;
                void handleAction(action, { scope: prefs.scope, format: prefs.format });
            };
            return button;
        };
        const labelled = (iconName, text, size = 14) => [icon(d, iconName, size), h(d, 'span', { class: 'label', text })];

        // Title bar
        const grip = h(d, 'button', { type: 'button', class: 'grip', 'aria-label': 'Move panel',
            title: 'Drag to move. Arrow keys also move it; the menu has docking choices.' });
        const activity = h(d, 'span', { class: 'rec', hidden: true, role: 'img', 'aria-label': 'Diagnostics active' });
        const menuButton = h(d, 'button', { type: 'button', class: 'tool caret', 'aria-label': 'Panel menu',
            'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Position, visibility, and help' });
        const collapseButton = h(d, 'button', { type: 'button', class: 'tool minus', 'aria-label': 'Collapse Chat Toolkit',
            title: 'Collapse to a small button' });
        const bar = h(d, 'div', { class: 'bar' }, grip, mark(d, 14, PLATFORM),
            h(d, 'span', { class: 'name', text: 'Chat Toolkit', title: `Chat Toolkit on ${providerName}` }),
            activity, menuButton, collapseButton);

        // Primary actions first, then the two selectors they use.
        const copyButton = bindAction(h(d, 'button', { type: 'button', class: 'go', 'data-a': 'copy',
            title: PRIMARY.copy.description }, labelled('copy', PRIMARY.copy.label(prefs.format))), 'copy');
        const saveButton = bindAction(h(d, 'button', { type: 'button', class: 'go', 'data-a': 'save',
            title: PRIMARY.save.description }, labelled('save', PRIMARY.save.label())), 'save');

        const selector = (name, legend, choices, key) => h(d, 'fieldset', { class: 'seg', 'aria-label': legend },
            choices.map((choice) => {
                const input = h(d, 'input', { type: 'radio', name: `ct-${name}`, value: choice.id,
                    checked: prefs[key] === choice.id, title: choice.description });
                input.addEventListener('change', () => { if (input.checked) updatePrefs({ [key]: choice.id }); });
                return h(d, 'label', { title: choice.description }, input, h(d, 'span', { text: choice.label }));
            }));

        // Advanced tools: last, closed by default, visually subordinate.
        const commandButtons = new Map();
        const advancedList = h(d, 'div', { class: 'adv' });
        let researchHeading = null;
        for (const command of advancedFor(PLATFORM)) {
            if (command.group === 'research' && !researchHeading) {
                researchHeading = h(d, 'p', { class: 'group', text: 'Research recording' });
                advancedList.appendChild(researchHeading);
            }
            const button = bindAction(h(d, 'button', { type: 'button', class: 'row', 'data-a': command.id,
                title: command.description }, labelled(command.icon, command.label)), command.id);
            commandButtons.set(command.id, button);
            advancedList.appendChild(button);
        }
        const state = h(d, 'p', { class: 'state' });
        advancedList.appendChild(state);
        const advanced = h(d, 'details', {}, h(d, 'summary', { title: 'Inspectors, comparison, and diagnostic captures. Reports can contain private chat and account data; they stay in this browser unless you save or share them.' },
            'Advanced tools'), advancedList);

        const hint = h(d, 'p', { class: 'hint' });
        const live = h(d, 'p', { class: 'sr', role: 'status', 'aria-live': 'polite' });

        // Menu: non-drag positioning, site visibility, and help.
        const menuItem = (iconName, text, onSelect) => {
            const item = h(d, 'button', { type: 'button', class: 'row', role: 'menuitem' }, ...labelled(iconName, text));
            item.addEventListener('click', (event) => {
                if (!event.isTrusted) return;
                closeMenu();
                onSelect();
            });
            return item;
        };
        const menu = h(d, 'div', { class: 'menu face', role: 'menu', 'aria-label': 'Panel menu', hidden: true },
            menuItem('dockLeft', 'Dock left', () => updatePrefs({ dock: 'left', position: null })),
            menuItem('dockRight', 'Dock right', () => updatePrefs({ dock: 'right', position: null })),
            menuItem('reset', 'Reset position', () => updatePrefs({ dock: 'left', position: null })),
            menuItem('hide', 'Hide on this site', () => {
                updatePrefs({ hiddenSites: [...prefs.hiddenSites, window.location.hostname] });
                notify('Chat Toolkit hidden on this site', 'Use the toolbar button to export or to show the panel again.');
            }),
            menuItem('help', 'Help & privacy', () => void handleAction('open-help')));

        const section = h(d, 'section', { class: 'ct face panel', role: 'region', 'aria-label': 'Chat Toolkit', style: accentStyle() },
            bar, menu,
            h(d, 'div', { class: 'body' }, hint,
                h(d, 'div', { class: 'primary' }, copyButton, saveButton),
                selector('scope', 'Messages', SCOPES, 'scope'),
                selector('format', 'File type', FORMATS, 'format'),
                advanced, live));
        const launcher = h(d, 'button', { type: 'button', class: 'ct face launcher', 'aria-label': 'Open Chat Toolkit',
            title: 'Open Chat Toolkit', hidden: true, style: accentStyle() }, mark(d, 18, PLATFORM));
        const wrapper = h(d, 'div', { id: 'chat-toolkit-panel' }, section, launcher);

        // ---- menu behaviour
        const menuItems = () => [...menu.querySelectorAll('button')];
        const closeMenu = () => {
            if (menu.hidden) return;
            menu.hidden = true;
            menuButton.setAttribute('aria-expanded', 'false');
        };
        menuButton.addEventListener('click', () => {
            const open = menu.hidden;
            menu.hidden = !open;
            menuButton.setAttribute('aria-expanded', String(open));
            if (open) menuItems()[0]?.focus();
        });
        menu.addEventListener('keydown', (event) => {
            const items = menuItems();
            const index = items.indexOf(event.target);
            if (event.key === 'Escape') { closeMenu(); menuButton.focus(); event.preventDefault(); }
            if (event.key === 'ArrowDown') { items[(index + 1) % items.length]?.focus(); event.preventDefault(); }
            if (event.key === 'ArrowUp') { items[(index - 1 + items.length) % items.length]?.focus(); event.preventDefault(); }
        });
        section.addEventListener('focusout', (event) => {
            if (!menu.contains(event.relatedTarget) && event.relatedTarget !== menuButton) closeMenu();
        });

        // ---- position and collapse
        const MARGIN = 8;
        const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
        const place = () => {
            const target = prefs.collapsed ? launcher : section;
            section.hidden = prefs.collapsed;
            launcher.hidden = !prefs.collapsed;
            for (const element of [section, launcher]) {
                element.style.left = element.style.right = element.style.top = '';
            }
            const width = target.offsetWidth || (prefs.collapsed ? 26 : 224);
            const height = target.offsetHeight || 26;
            if (prefs.dock === 'free' && prefs.position) {
                target.style.left = `${clamp(prefs.position.x, MARGIN, window.innerWidth - width - MARGIN)}px`;
                target.style.top = `${clamp(prefs.position.y, MARGIN, window.innerHeight - height - MARGIN)}px`;
            } else {
                target.style[prefs.dock === 'right' ? 'right' : 'left'] = `${MARGIN}px`;
                target.style.top = `${clamp(72, MARGIN, window.innerHeight - height - MARGIN)}px`;
            }
        };
        collapseButton.addEventListener('click', () => { updatePrefs({ collapsed: true }); launcher.focus(); });
        launcher.addEventListener('click', () => { updatePrefs({ collapsed: false }); collapseButton.focus(); });

        let drag = null;
        grip.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const rect = section.getBoundingClientRect();
            drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            try { grip.setPointerCapture(event.pointerId); } catch {}
            event.preventDefault();
        });
        grip.addEventListener('pointermove', (event) => {
            if (!drag || event.pointerId !== drag.id) return;
            section.style.right = '';
            section.style.left = `${clamp(event.clientX - drag.dx, 0, window.innerWidth - section.offsetWidth)}px`;
            section.style.top = `${clamp(event.clientY - drag.dy, 0, window.innerHeight - section.offsetHeight)}px`;
        });
        const endDrag = (event) => {
            if (!drag || event.pointerId !== drag.id) return;
            drag = null;
            const rect = section.getBoundingClientRect();
            updatePrefs({ dock: 'free', position: { x: rect.left, y: rect.top } });
        };
        grip.addEventListener('pointerup', endDrag);
        grip.addEventListener('pointercancel', endDrag);
        grip.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? 64 : 16;
            const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
            const move = moves[event.key];
            if (!move) return;
            event.preventDefault();
            const rect = section.getBoundingClientRect();
            updatePrefs({ dock: 'free', position: { x: rect.left + move[0], y: rect.top + move[1] } });
        });
        window.addEventListener('resize', () => place());

        // ---- state rendering
        const render = () => {
            copyButton.querySelector('.label').textContent = PRIMARY.copy.label(prefs.format);
            for (const input of section.querySelectorAll('input[type="radio"]')) {
                input.checked = input.value === prefs[input.name.slice(3)];
            }
            wrapper.hidden = prefs.hiddenSites.includes(window.location.hostname);
            place();
        };
        const updatePrefs = (patch) => {
            prefs = model.normalizePrefs({ ...prefs, ...patch });
            render();
            onPrefs(patch, prefs);
        };

        // Confirmation happens on the button that was pressed: its label reads
        // "Copied" or "Saved" for a moment, with the detail in its tooltip.
        const primaryButtons = { copy: copyButton, save: saveButton };
        const confirmTimers = new Map();

        panelApi = {
            get prefs() { return prefs; },
            applyPrefs(next) { prefs = model.normalizePrefs(next); render(); },
            setHint(text) { hint.textContent = text || ''; },
            setActivity(parts = []) {
                const text = parts.filter(Boolean).join(' · ');
                activity.hidden = !text;
                activity.title = text;
                state.textContent = text;
            },
            setBusy(action, busy) {
                const button = primaryButtons[action] || commandButtons.get(action);
                if (!button) return;
                if (busy) button.setAttribute('aria-busy', 'true');
                else button.removeAttribute('aria-busy');
            },
            setCommand(action, { label, pressed } = {}) {
                const button = commandButtons.get(action);
                if (!button) return;
                if (label) button.querySelector('.label').textContent = label;
                if (pressed == null) button.removeAttribute('aria-pressed');
                else button.setAttribute('aria-pressed', String(!!pressed));
            },
            // Returns true when the outcome was fully shown on a visible
            // primary button; warnings and errors also need a notification.
            confirm(action, kind, title, detail = '') {
                live.textContent = [title, detail].filter(Boolean).join('. ');
                const button = primaryButtons[action];
                const visible = !wrapper.hidden && !prefs.collapsed && wrapper.isConnected;
                if (!button || !visible || kind === 'error') return false;
                const label = button.querySelector('.label');
                clearTimeout(confirmTimers.get(action));
                label.textContent = PRIMARY[action].done;
                button.querySelector('svg').replaceWith(icon(d, kind === 'warn' ? 'warning' : 'check', 14));
                button.title = [title, detail].filter(Boolean).join('. ');
                confirmTimers.set(action, setTimeout(() => {
                    label.textContent = action === 'copy' ? PRIMARY.copy.label(prefs.format) : PRIMARY.save.label();
                    button.querySelector('svg').replaceWith(icon(d, PRIMARY[action].icon, 14));
                    button.title = PRIMARY[action].description;
                }, 1600));
                return kind !== 'warn';
            }
        };

        const host = mountPrivateUI(wrapper, sharedStyles() + PANEL_CSS);
        // Position once the host is in the document and sizes are known.
        Promise.resolve().then(render);
        return host;
    };

    CT.notify = notify;
    CT.mountPrivateUI = mountPrivateUI;
    CT.copyToClipboard = copyToClipboard;
    CT.showReport = showReport;
    CT.compactForReport = compactForReport;
    CT.createPanel = createPanel;
    CT.panel = () => panelApi;
})();
