// UI surfaces: toast notifier, draggable control panel, report panel,
// clipboard helpers. Everything that adds nodes to the host page lives here.

(function () {
    'use strict';

    const CT = window.__chatToolkit;
    if (!CT) return;

    const { PLATFORM, COLORS } = CT;

    // Reports and copy buffers must not be readable through the host page's
    // ordinary DOM queries. Keep references in the isolated content script.
    const mountPrivateUI = (element) => {
        const host = document.createElement('div');
        if (element.id) host.id = element.id;
        host.attachShadow({ mode: 'closed' }).appendChild(element);
        return host;
    };

    const notify = (title, msg = '') => {
        const el = document.createElement('div');
        el.style.cssText = `position:fixed;top:20px;right:20px;z-index:999999;background:${COLORS[PLATFORM]};color:#000;padding:12px 16px;border-radius:8px;font:13px ui-monospace,monospace;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
        const heading = document.createElement('strong');
        heading.textContent = title;
        el.appendChild(heading);
        if (msg) {
            el.appendChild(document.createElement('br'));
            const detail = document.createElement('small');
            detail.textContent = msg;
            el.appendChild(detail);
        }
        const host = mountPrivateUI(el);
        document.body.appendChild(host);
        setTimeout(() => host.remove(), 3000);
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

    const copyToClipboard = async (html, markdown) => {
        try {
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([markdown], { type: 'text/plain' })
                })
            ]);
            return true;
        } catch {
            try { await navigator.clipboard.writeText(markdown); return true; }
            catch { return legacyCopyText(markdown); }
        }
    };

    // ---- report panel ----------------------------------------------------

    let reportPanel = null;
    let controlsPanel = null;
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

    const ensureReportPanel = ({ onCopy, onDownload }) => {
        if (reportPanel?.isConnected) return reportPanel;

        reportPanel = document.createElement('div');
        reportPanel.id = 'chat-toolkit-report';
        reportPanel.innerHTML = `
            <style>
                #chat-toolkit-report{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:min(720px,calc(100vw - 32px));max-height:min(75vh,720px);display:none}
                #chat-toolkit-report.open{display:block}
                #chat-toolkit-report .rt-shell{background:rgba(13,17,23,0.98);border:1px solid rgba(255,255,255,0.1);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,0.45);overflow:hidden}
                #chat-toolkit-report .rt-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08)}
                #chat-toolkit-report .rt-title{flex:1;color:#f0f6fc;font:600 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}
                #chat-toolkit-report .rt-actions{display:flex;gap:6px}
                #chat-toolkit-report button{padding:6px 10px;border:none;border-radius:7px;background:#21262d;color:#c9d1d9;cursor:pointer;font:11px ui-monospace,monospace}
                #chat-toolkit-report button:hover{background:#30363d}
                #chat-toolkit-report .rt-body{padding:14px}
                #chat-toolkit-report .rt-summary{color:#8b949e;font:12px/1.5 ui-monospace,monospace;margin:0 0 10px}
                #chat-toolkit-report .rt-meta{color:#6e7681;font:11px ui-monospace,monospace;margin:0 0 12px}
                #chat-toolkit-report pre{margin:0;max-height:52vh;overflow:auto;background:#0d1117;border:1px solid #21262d;border-radius:10px;padding:12px;white-space:pre-wrap;color:#c9d1d9;font:12px/1.5 ui-monospace,monospace}
            </style>
            <div class="rt-shell">
                <div class="rt-head">
                    <div class="rt-title">Report</div>
                    <div class="rt-actions">
                        <button data-report="copy">copy</button>
                        <button data-report="download">save</button>
                        <button data-report="close">close</button>
                    </div>
                </div>
                <div class="rt-body">
                    <p class="rt-summary"></p>
                    <div class="rt-meta"></div>
                    <pre class="rt-content"></pre>
                </div>
            </div>
        `;

        reportPanel.querySelector('[data-report="close"]').onclick = () => reportPanel.classList.remove('open');
        reportPanel.querySelector('[data-report="copy"]').onclick = (event) => { if (event.isTrusted) onCopy?.(latestReport); };
        reportPanel.querySelector('[data-report="download"]').onclick = (event) => { if (event.isTrusted) onDownload?.(latestReport); };

        document.body.appendChild(mountPrivateUI(reportPanel));
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
        notify(title, 'Report opened');
    };

    // ---- control panel ---------------------------------------------------

    const createPanel = (handleAction) => {
        const panel = document.createElement('div');
        panel.id = 'chat-toolkit-panel';
        panel.innerHTML = `
            <style>
                #chat-toolkit-panel{position:fixed;left:8px;top:70px;z-index:2147483647;background:rgba(13,17,23,0.98);border:1px solid rgba(255,255,255,0.1);border-radius:10px;font:11px ui-monospace,monospace;color:#8b949e;min-width:120px;box-shadow:0 8px 24px rgba(0,0,0,0.6)}
                #chat-toolkit-panel .hdr{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:grab;border-bottom:1px solid rgba(255,255,255,0.05);user-select:none}
                #chat-toolkit-panel .lbl{flex:1;font-weight:600;color:var(--ct-color);font-size:10px;text-transform:uppercase}
                #chat-toolkit-panel .bdy{padding:8px}
                #chat-toolkit-panel .row{display:flex;gap:4px;margin-bottom:5px}
                #chat-toolkit-panel button{flex:1;padding:5px;border:none;border-radius:5px;background:rgba(255,255,255,0.04);color:#7d8590;cursor:pointer;font:10px ui-monospace,monospace}
                #chat-toolkit-panel button:hover{background:rgba(255,255,255,0.08);color:#c9d1d9}
                #chat-toolkit-panel .store{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.06);color:#7d8590;line-height:1.35;max-width:190px;white-space:normal}
                #chat-toolkit-panel details{max-width:220px;margin-top:8px;line-height:1.5}
                #chat-toolkit-panel summary{cursor:pointer;color:#c9d1d9}
                #chat-toolkit-panel .note{max-width:220px;white-space:normal}
                #chat-toolkit-panel.min .bdy{display:none}
            </style>
            <div class="hdr">
                <span class="lbl"></span>
                <span class="tog" style="cursor:pointer;opacity:0.5">_</span>
            </div>
            <div class="bdy">
                <div class="row">
                    <button data-a="copy" style="background:rgba(126,231,135,0.15);color:#7ee787">copy</button>
                    <button data-a="drag" style="background:rgba(88,166,255,0.15);color:#58a6ff">drag</button>
                </div>
                <div class="row">
                    <button data-a="export-json">json</button>
                    <button data-a="export-md">md</button>
                    <button data-a="export-html">html</button>
                </div>
                <div class="row">
                    <button data-a="export-user-turns">user</button>
                    <button data-a="export-assistant-turns">assistant</button>
                </div>
                <details>
                    <summary>Diagnostics</summary>
                    <p class="note">Reports can contain private chat and account information. They stay in your browser or saved files. Network and Capture record only while running. ChatGPT research recording is off until you click Record; navigation or closing this tab clears it.</p>
                    <div class="row">
                        <button data-a="run-explorer">API</button>
                        <button data-a="run-sniffer">Network</button>
                        <button data-a="run-dom">DOM</button>
                    </div>
                    <div class="row">
                        <button data-a="export-capture">Capture</button>
                        <button data-a="run-diff">Diff</button>
                    </div>
                    <div class="row">
                        <button data-a="diagnostics-start">Record</button>
                        <button data-a="diagnostics-stop">Stop</button>
                        <button data-a="diagnostics-clear">Clear</button>
                    </div>
                    <div class="row"><button data-a="fetch-research-state">Fetch ChatGPT research state</button></div>
                    <p class="note">Account capture also requests account settings, memory, project files, and available session metadata from the current provider.</p>
                    <div class="row"><button data-a="export-account-capture">Export account capture</button></div>
                    <p class="note">Page hooks instrument this tab's requests while a capture is running. Reload the tab to remove the hooks.</p>
                    <div class="row"><button data-a="enable-page-hooks">Enable page hooks</button></div>
                    <div class="store" title="Local diagnostic recording">Recording: off</div>
                </details>
                <div class="row" style="margin-top:8px"><button data-a="open-help">Help &amp; privacy</button></div>
            </div>
        `;
        panel.style.setProperty('--ct-color', COLORS[PLATFORM]);
        panel.querySelector('.lbl').textContent = `Chat Toolkit · ${PLATFORM}`;

        panel.querySelector('.tog').onclick = () => panel.classList.toggle('min');

        // Drag: scope listeners to the panel itself, not `document`, so we
        // don't stomp on whatever mouse handlers the chat site has installed.
        const header = panel.querySelector('.hdr');
        let drag = null;

        const onMove = (e) => {
            if (!drag) return;
            panel.style.left = drag.left + e.clientX - drag.x + 'px';
            panel.style.top = drag.top + e.clientY - drag.y + 'px';
        };
        const onUp = () => {
            if (!drag) return;
            drag = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        header.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('tog')) return;
            drag = { x: e.clientX, y: e.clientY, left: panel.offsetLeft, top: panel.offsetTop };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        panel.querySelectorAll('button').forEach((b) => {
            const action = b.dataset.a;
            b.onclick = (event) => { if (event.isTrusted) void handleAction(action); };
            if (['diagnostics-start', 'diagnostics-stop', 'fetch-research-state'].includes(b.dataset.a)) {
                b.hidden = PLATFORM !== 'chatgpt';
            }
            if (b.dataset.a === 'export-account-capture') b.hidden = !['claude', 'chatgpt'].includes(PLATFORM);
        });

        controlsPanel = panel;
        return mountPrivateUI(panel);
    };

    const setPanelStatus = (text, title = '') => {
        const el = controlsPanel?.querySelector('.store');
        if (!el) return;
        el.textContent = text || 'store: idle';
        if (title) el.title = title;
    };

    CT.notify = notify;
    CT.mountPrivateUI = mountPrivateUI;
    CT.copyToClipboard = copyToClipboard;
    CT.showReport = showReport;
    CT.compactForReport = compactForReport;
    CT.createPanel = createPanel;
    CT.setPanelStatus = setPanelStatus;
})();
