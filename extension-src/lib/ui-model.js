// Shared command model for the page panel and the toolbar popup: provider
// names and accents, export choices, command labels, stored layout
// preferences, the drawn icon set, and the shared stylesheet. Both surfaces
// read the same definitions so a command means the same thing everywhere.
//
// Loaded as a content script (after common.js) and as a popup script. It
// only defines data and DOM helpers; it performs no network or page access.

(function () {
    'use strict';

    // Accents follow each platform's recognizable colour, slightly muted so
    // they sit in the matte palette.
    const PROVIDERS = {
        claude: { name: 'Claude', hosts: ['claude.ai'], accent: '#c96f50' },
        chatgpt: { name: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'], accent: '#2f8f74' },
        grok: { name: 'Grok', hosts: ['grok.com'], accent: '#5d646e' },
        gemini: { name: 'Gemini', hosts: ['gemini.google.com'], accent: '#4a7fd4' },
        aistudio: { name: 'Google AI Studio', hosts: ['aistudio.google.com'], accent: '#3f6fbf' },
        openrouter: { name: 'OpenRouter', hosts: ['openrouter.ai'], accent: '#5f62c4' }
    };
    const DEFAULT_ACCENT = '#46689a';

    const providerForHost = (hostname) => Object.keys(PROVIDERS)
        .find((id) => PROVIDERS[id].hosts.includes(hostname)) || '';

    const FORMATS = [
        { id: 'md', label: '.md', name: 'Markdown', description: 'Markdown (.md)' },
        { id: 'json', label: '.json', name: 'JSON', description: 'JSON (.json)' },
        { id: 'html', label: '.html', name: 'HTML', description: 'HTML page (.html)' }
    ];
    const SCOPES = [
        { id: 'all', label: 'All', description: 'Every message on the selected branch' },
        { id: 'user', label: 'User', description: 'Only your messages' },
        { id: 'assistant', label: 'Assistant', description: 'Only the assistant’s messages' }
    ];
    const formatName = (id) => FORMATS.find((format) => format.id === id)?.name || 'Markdown';

    // Layout preferences only. Conversation content is never stored.
    const PREFS_KEY = 'uiPrefs';
    const DEFAULT_PREFS = Object.freeze({
        format: 'md',
        scope: 'all',
        dock: 'left',
        position: null,
        collapsed: false,
        hiddenSites: []
    });

    const normalizePrefs = (value) => {
        const input = value && typeof value === 'object' ? value : {};
        const pick = (key, allowed) => allowed.includes(input[key]) ? input[key] : DEFAULT_PREFS[key];
        const position = input.position && Number.isFinite(input.position.x) && Number.isFinite(input.position.y)
            ? { x: Math.round(input.position.x), y: Math.round(input.position.y) } : null;
        const knownHosts = Object.values(PROVIDERS).flatMap((provider) => provider.hosts);
        return {
            format: pick('format', FORMATS.map((format) => format.id)),
            scope: pick('scope', SCOPES.map((scope) => scope.id)),
            dock: pick('dock', ['left', 'right', 'free']),
            position,
            collapsed: input.collapsed === true,
            hiddenSites: Array.isArray(input.hiddenSites)
                ? [...new Set(input.hiddenSites.filter((host) => knownHosts.includes(host)))] : []
        };
    };

    const storageArea = () => {
        try { return typeof browser !== 'undefined' ? browser.storage?.local || null : null; }
        catch { return null; }
    };

    const loadPrefs = async () => {
        const area = storageArea();
        if (!area) return normalizePrefs(null);
        try { return normalizePrefs((await area.get(PREFS_KEY))?.[PREFS_KEY]); }
        catch { return normalizePrefs(null); }
    };

    // Private windows may read existing layout preferences but never write:
    // Mozilla's policy forbids storing data from private browsing sessions,
    // and a hidden-site list would reveal which providers were visited.
    const inPrivateContext = () => {
        try { return typeof browser !== 'undefined' && !!browser.extension?.inIncognitoContext; }
        catch { return false; }
    };

    // Writes are queued so each patch applies to the result of the previous
    // one; two quick changes (scope, then format) cannot overwrite each other.
    let writeQueue = Promise.resolve();
    const savePrefs = (patch) => {
        const write = writeQueue.then(async () => {
            const next = normalizePrefs({ ...(await loadPrefs()), ...patch });
            const area = storageArea();
            if (area && !inPrivateContext()) {
                try { await area.set({ [PREFS_KEY]: next }); } catch {}
            }
            return next;
        });
        writeQueue = write.catch(() => {});
        return write;
    };

    // Primary commands run the selected scope and format. Their labels name
    // what they do; the pressed selectors say which messages and file type.
    const PRIMARY = {
        copy: { label: (format) => `Copy ${formatName(format)}`, icon: 'copy', done: 'Copied',
            description: 'Copy the selected messages to the clipboard' },
        save: { label: () => 'Save file', icon: 'save', done: 'Saved',
            description: 'Save the selected messages to your downloads folder' }
    };

    const ADVANCED = [
        { id: 'run-explorer', label: 'API inspector', icon: 'inspect',
            description: 'Summarize the provider data behind this conversation' },
        { id: 'run-dom', label: 'Page inspector', icon: 'page',
            description: 'Count message, code, and attachment elements on this page' },
        { id: 'run-diff', label: 'Compare API and page', icon: 'compare',
            description: 'List text found only in the provider data or only on the page' },
        { id: 'run-sniffer', label: 'Network inspector', icon: 'network',
            description: 'Record request metadata in this tab until you select it again' },
        { id: 'export-capture', label: 'Diagnostic capture', icon: 'archive',
            description: 'Save the conversation with page and bounded network diagnostics (.capture.json)' },
        { id: 'export-account-capture', label: 'Account capture', icon: 'folder', platforms: ['claude', 'chatgpt'],
            description: 'Diagnostic capture plus account settings, memory, and project resources' },
        { id: 'diagnostics-start', label: 'Record research', icon: 'record', platforms: ['chatgpt'], group: 'research',
            description: 'Record ChatGPT deep-research traffic in this tab, in memory only' },
        { id: 'diagnostics-stop', label: 'Stop recording', icon: 'stop', platforms: ['chatgpt'], group: 'research',
            description: 'Stop recording; keep what was recorded' },
        { id: 'diagnostics-clear', label: 'Clear recording', icon: 'trash', platforms: ['chatgpt'], group: 'research',
            description: 'Delete this tab’s recorded research data' },
        { id: 'fetch-research-state', label: 'Fetch research state', icon: 'fetch', platforms: ['chatgpt'], group: 'research',
            description: 'Request missing research sessions found by the recording' },
        { id: 'enable-page-hooks', label: 'Enable page hooks', icon: 'code',
            description: 'Instrument this page’s requests during captures; reload the page to remove' }
    ];

    const advancedFor = (platform) => ADVANCED.filter((command) =>
        !command.platforms || command.platforms.includes(platform));

    // ---- colour helpers ---------------------------------------------------

    const hexToRgb = (hex) => {
        const value = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))?.[1] || DEFAULT_ACCENT.slice(1);
        return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
    };
    const rgbToHex = (rgb) => `#${rgb.map((channel) => Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16).padStart(2, '0')).join('')}`;
    const mix = (hex, target, amount) => {
        const from = hexToRgb(hex);
        const to = target === 'white' ? [255, 255, 255] : [0, 0, 0];
        return rgbToHex(from.map((channel, index) => channel + (to[index] - channel) * amount));
    };
    const luminance = (hex) => {
        const [r, g, b] = hexToRgb(hex).map((channel) => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    // A matte accent: light top, darker base, dark keyline, and legible ink.
    const accentFor = (platform) => {
        const base = PROVIDERS[platform]?.accent || DEFAULT_ACCENT;
        const low = mix(base, 'black', 0.18);
        return {
            base,
            top: mix(base, 'white', 0.22),
            low,
            key: mix(base, 'black', 0.55),
            ink: luminance(low) > 0.36 ? '#1a1d21' : '#ffffff'
        };
    };
    const accentCSS = (platform) => {
        const accent = accentFor(platform);
        return `--ac:${accent.base};--ac-top:${accent.top};--ac-low:${accent.low};--ac-key:${accent.key};--ac-ink:${accent.ink};`;
    };

    // ---- drawn icons --------------------------------------------------------
    // Original 16px icons in a matte "vector plastic" style: linear gradients,
    // a 1px dark keyline, no wet highlights. Drawn for this project (MIT).

    const MATERIALS = {
        paper: ['#fbfbf8', '#d5dae1', '#4d5663'],
        blue: ['#9cbbe0', '#3f679c', '#1e3656'],
        tan: ['#ecd49a', '#bf9443', '#5f4515'],
        green: ['#a8d392', '#4c8a3c', '#23491c'],
        red: ['#e9a397', '#ae4637', '#561d15'],
        steel: ['#dfe3e8', '#8b949f', '#3a4049'],
        glass: ['#eef5fb', '#a9c6e2', '#2c4a6c']
    };

    const ICONS = {
        copy: [['rect', { x: 1.5, y: 1.5, width: 8, height: 10, rx: 1, m: 'paper' }],
            ['rect', { x: 5.5, y: 4.5, width: 9, height: 10, rx: 1, m: 'paper' }],
            ['path', { d: 'M7.5 7.5h5M7.5 9.5h5M7.5 11.5h3', line: '#7a8594' }]],
        save: [['path', { d: 'M1.5 9.5h3l1 2h5l1-2h3v3.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z', m: 'blue' }],
            ['path', { d: 'M6.5 1.5h3v4.5h2.5l-4 4-4-4h2.5z', m: 'tan' }]],
        inspect: [['rect', { x: 1.5, y: 1.5, width: 9, height: 11, rx: 1, m: 'paper' }],
            ['path', { d: 'M3.5 4.5h5M3.5 6.5h4M3.5 8.5h2', line: '#7a8594' }],
            ['path', { d: 'M12.2 12.2l2.3 2.3', line: '#3a4049', width: 2.2 }],
            ['circle', { cx: 10, cy: 10, r: 3.5, m: 'glass' }]],
        page: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1, m: 'paper' }],
            ['path', { d: 'M2 3h12v2.5H2z', fill: '#6f8fb9' }],
            ['path', { d: 'M3.5 8.5h6M3.5 10.5h8', line: '#7a8594' }]],
        compare: [['rect', { x: 1.5, y: 2.5, width: 6, height: 11, rx: 0.8, m: 'paper' }],
            ['rect', { x: 8.5, y: 2.5, width: 6, height: 11, rx: 0.8, m: 'tan' }],
            ['path', { d: 'M3 5.5h3M3 7.5h3M3 9.5h2', line: '#7a8594' }],
            ['path', { d: 'M10 5.5h3M10 7.5h3M10 9.5h2', line: '#6b4f18' }]],
        network: [['circle', { cx: 8, cy: 8, r: 6.5, m: 'blue' }],
            ['path', { d: 'M8 1.5v13M1.5 8h13M8 1.5c-3 3.5-3 9.5 0 13M8 1.5c3 3.5 3 9.5 0 13', line: '#dfe9f6', width: 0.8 }]],
        archive: [['rect', { x: 2.5, y: 5.5, width: 11, height: 8, rx: 0.8, m: 'tan' }],
            ['rect', { x: 1.5, y: 2.5, width: 13, height: 3, rx: 0.8, m: 'tan' }],
            ['path', { d: 'M6.5 8.5h3', line: '#5f4515', width: 1.2 }]],
        folder: [['path', { d: 'M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z', m: 'blue' }],
            ['path', { d: 'M2 7.5h12', line: '#c9d8eb', width: 0.8 }]],
        record: [['circle', { cx: 8, cy: 8, r: 5.5, m: 'red' }]],
        stop: [['rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1, m: 'steel' }]],
        trash: [['path', { d: 'M3.5 5.5h9l-.8 8.2a1 1 0 0 1-1 .8h-5.4a1 1 0 0 1-1-.8z', m: 'steel' }],
            ['rect', { x: 2.5, y: 3.5, width: 11, height: 2, rx: 0.6, m: 'steel' }],
            ['path', { d: 'M6.5 3.5V2h3v1.5', line: '#3a4049' }],
            ['path', { d: 'M6.5 7.5v5M9.5 7.5v5', line: '#6b737d' }]],
        fetch: [['rect', { x: 3.5, y: 1.5, width: 9, height: 12, rx: 1, m: 'paper' }],
            ['path', { d: 'M6.5 4.5h3V8h2L8 11.5 4.5 8h2z', m: 'blue' }]],
        code: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1, m: 'paper' }],
            ['path', { d: 'M6 6L4 8l2 2M10 6l2 2-2 2', line: '#3f679c', width: 1.3 }]],
        dockLeft: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1, m: 'paper' }],
            ['rect', { x: 2, y: 3, width: 4, height: 10, fill: '#6f8fb9' }]],
        dockRight: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1, m: 'paper' }],
            ['rect', { x: 10, y: 3, width: 4, height: 10, fill: '#6f8fb9' }]],
        reset: [['path', { d: 'M12.5 8.5a4.5 4.5 0 1 1-1.4-3.3', line: '#3f679c', width: 1.6 }],
            ['path', { d: 'M12 2.5v3h-3', line: '#3f679c', width: 1.6 }]],
        hide: [['path', { d: 'M1.5 8c2-3.5 11-3.5 13 0-2 3.5-11 3.5-13 0z', m: 'paper' }],
            ['circle', { cx: 8, cy: 8, r: 2, m: 'blue' }],
            ['path', { d: 'M3 13L13 3', line: '#ae4637', width: 1.6 }]],
        help: [['circle', { cx: 8, cy: 8, r: 6.5, m: 'blue' }],
            ['path', { d: 'M6.3 6.2a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.7-.8 1.3v.3', line: '#ffffff', width: 1.5 }],
            ['circle', { cx: 8, cy: 11.6, r: 0.9, fill: '#ffffff' }]],
        check: [['circle', { cx: 8, cy: 8, r: 6.5, m: 'green' }],
            ['path', { d: 'M5 8.2l2 2 4-4.2', line: '#ffffff', width: 1.8 }]],
        warning: [['path', { d: 'M8 1.5l6.8 12.2H1.2z', m: 'tan' }],
            ['path', { d: 'M8 6v3.5', line: '#3a2a08', width: 1.6 }],
            ['circle', { cx: 8, cy: 11.6, r: 0.9, fill: '#3a2a08' }]],
        error: [['circle', { cx: 8, cy: 8, r: 6.5, m: 'red' }],
            ['path', { d: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8', line: '#ffffff', width: 1.7 }]],
        info: [['circle', { cx: 8, cy: 8, r: 6.5, m: 'blue' }],
            ['path', { d: 'M8 7v4.5', line: '#ffffff', width: 1.8 }],
            ['circle', { cx: 8, cy: 4.8, r: 1, fill: '#ffffff' }]]
    };

    const SVG_NS = 'http://www.w3.org/2000/svg';
    let gradientSequence = 0;

    const svgNode = (doc, tag, attributes) => {
        const node = doc.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
    };

    // Each icon carries its own gradients so it renders correctly inside any
    // closed shadow root or popup document.
    const drawIcon = (doc, shapes, size, viewBox, materials = MATERIALS) => {
        const svg = svgNode(doc, 'svg', { viewBox, width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
        const defs = svgNode(doc, 'defs', {});
        const gradients = {};
        const gradient = (name) => {
            if (gradients[name]) return gradients[name];
            const id = `ct-g${++gradientSequence}`;
            const [top, bottom] = materials[name];
            const node = svgNode(doc, 'linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
            node.append(svgNode(doc, 'stop', { offset: 0, 'stop-color': top }), svgNode(doc, 'stop', { offset: 1, 'stop-color': bottom }));
            defs.appendChild(node);
            gradients[name] = `url(#${id})`;
            return gradients[name];
        };
        for (const [tag, spec] of shapes) {
            const { m, line, width, fill, ...attributes } = spec;
            if (m) Object.assign(attributes, { fill: gradient(m), stroke: materials[m][2], 'stroke-width': width || 1, 'stroke-linejoin': 'round' });
            else if (line) Object.assign(attributes, { fill: 'none', stroke: line, 'stroke-width': width || 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
            else if (fill) attributes.fill = fill;
            svg.appendChild(svgNode(doc, tag, attributes));
        }
        if (defs.childNodes.length) svg.insertBefore(defs, svg.firstChild);
        return svg;
    };

    const icon = (doc, name, size = 16) => drawIcon(doc, ICONS[name] || ICONS.info, size, '0 0 16 16');

    // The identity mark: the platform-accent speech bubble in front of a
    // document. Geometry matches assets/design/chat-toolkit-mark.svg; inline so
    // no moz-extension URL is exposed to pages.
    const MARK_SHAPES = [
        ['path', { d: 'M28 5H47L58 16V43a3 3 0 0 1-3 3H28a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z', m: 'tan', width: 3 }],
        ['path', { d: 'M47 5V14a2 2 0 0 0 2 2H58', line: '#5f4515', width: 3 }],
        ['path', { d: 'M17 20H38a13 13 0 0 1 13 13v2a13 13 0 0 1-13 13H24L12 59l2-11.6A13 13 0 0 1 4 35v-2a13 13 0 0 1 13-13Z', m: 'accent', width: 3.5 }],
        ['circle', { cx: 16, cy: 34, r: 3.8, fill: '#f4f7fb' }],
        ['circle', { cx: 27.5, cy: 34, r: 3.8, fill: '#f4f7fb' }],
        ['circle', { cx: 39, cy: 34, r: 3.8, fill: '#f4f7fb' }]
    ];
    const mark = (doc, size = 16, platform = '') => {
        const accent = accentFor(platform);
        return drawIcon(doc, MARK_SHAPES, size, '0 0 64 64', { ...MATERIALS, accent: [accent.top, accent.low, accent.key] });
    };

    // Small DOM builder: h('button', { class: 'x', onclick }, child, 'text').
    const h = (doc, tag, attributes = {}, ...children) => {
        const node = doc.createElement(tag);
        for (const [key, value] of Object.entries(attributes || {})) {
            if (value == null || value === false) continue;
            if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key === 'text') node.textContent = String(value);
            else node.setAttribute(key, value === true ? '' : String(value));
        }
        for (const child of children.flat()) {
            if (child == null || child === false) continue;
            node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
        }
        return node;
    };

    // ---- shared stylesheet ---------------------------------------------------
    // A shallow matte-plastic panel: keyline borders, a soft inner bevel, and
    // controls that sit raised until selected, when they press into the panel.
    // Charcoal by default; silver when the system prefers a light scheme.
    const STYLES = `
        .ct{--face-top:#474d55;--face-bot:#363b42;--bar-top:#3c4148;--bar-bot:#2c3035;--key:#15181c;--glow:rgba(255,255,255,.13);
            --text:#e7eaee;--muted:#aab2bc;--key-top:#5a616b;--key-bot:#454b53;--key-hi:rgba(255,255,255,.2);--key-lo:rgba(0,0,0,.35);
            --well:#262a2f;--press-top:#2b2f35;--press-bot:#353a41;--emboss:rgba(0,0,0,.45);--focus:#9dc0ea;--row-hover:rgba(255,255,255,.07);
            --shadow:0 3px 10px rgba(0,0,0,.45);
            color:var(--text);font:11.5px/1.3 Tahoma,"Segoe UI",Verdana,system-ui,sans-serif}
        @media (prefers-color-scheme: light){.ct{--face-top:#eef1f4;--face-bot:#d7dce2;--bar-top:#e2e6eb;--bar-bot:#c9cfd7;--key:#646d78;
            --glow:rgba(255,255,255,.75);--text:#1d232b;--muted:#4f5864;--key-top:#fbfcfd;--key-bot:#dde2e8;--key-hi:rgba(255,255,255,.95);
            --key-lo:rgba(80,90,105,.28);--well:#b8c0ca;--press-top:#c6cdd6;--press-bot:#d6dce3;--emboss:rgba(255,255,255,.8);
            --focus:#2d5f9e;--row-hover:rgba(40,60,90,.08);--shadow:0 3px 10px rgba(30,40,55,.28)}}
        .ct *,.ct *::before,.ct *::after{box-sizing:border-box}
        .ct button{font:inherit;color:inherit;cursor:pointer;margin:0}
        .ct :focus-visible{outline:1px dotted var(--focus);outline-offset:1px}
        .face{background:linear-gradient(var(--face-top),var(--face-bot));border:1px solid var(--key);border-radius:6px;
            box-shadow:inset 0 1px 0 var(--glow),var(--shadow);overflow:hidden}
        .ct .bar{display:flex;align-items:center;gap:4px;height:22px;padding:0 3px 0 2px;background:linear-gradient(var(--bar-top),var(--bar-bot));
            border-bottom:1px solid var(--key);box-shadow:inset 0 1px 0 var(--glow)}
        .ct .bar .name{flex:1;font-weight:bold;font-size:11px;text-shadow:0 1px 0 var(--emboss);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .ct .bar .who{font-size:10.5px;color:var(--muted);white-space:nowrap}
        .ct .tool{display:inline-grid;place-items:center;width:17px;height:16px;padding:0;border:1px solid var(--key);border-radius:3px;
            background:linear-gradient(var(--key-top),var(--key-bot));box-shadow:inset 0 1px 0 var(--key-hi)}
        .ct .tool:active,.ct .tool[aria-expanded="true"]{background:linear-gradient(var(--press-top),var(--press-bot));box-shadow:inset 0 1px 2px var(--key-lo)}
        .ct .tool::before{content:"";display:block}
        .ct .caret::before{border:3.5px solid transparent;border-top:4px solid var(--text);margin-top:4px}
        .ct .minus::before{width:7px;height:2px;background:var(--text);box-shadow:0 1px 0 var(--emboss)}
        .ct .grip{width:8px;height:14px;border:0;padding:0;background:radial-gradient(circle,var(--muted) 0.8px,transparent 1.2px) 0 0/4px 4px;
            box-shadow:none;cursor:grab;touch-action:none;opacity:.8}
        .ct .rec{width:8px;height:8px;border-radius:50%;border:1px solid #561d15;background:linear-gradient(#e9a397,#ae4637)}
        .ct .rec[hidden]{display:none}
        .ct .body{display:grid;gap:5px;padding:5px}
        .ct .hint{margin:0;font-size:10.5px;color:var(--muted)}
        .ct .hint:empty{display:none}
        .ct .primary{display:grid;grid-template-columns:1fr 1fr;gap:4px}
        .ct .go{display:flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 5px;border:1px solid var(--ac-key);border-radius:4px;
            background:linear-gradient(var(--ac-top),var(--ac-low));color:var(--ac-ink);font-weight:bold;white-space:nowrap;
            box-shadow:inset 0 1px 0 rgba(255,255,255,.32),0 1px 0 var(--emboss);text-shadow:0 -1px 0 rgba(0,0,0,.25)}
        .ct .go:hover{filter:brightness(1.06)}
        .ct .go:active,.ct .go[aria-busy="true"]{background:linear-gradient(var(--ac-low),var(--ac-top));box-shadow:inset 0 1px 3px rgba(0,0,0,.45);
            padding-top:1px}
        .ct .go[aria-busy="true"]{cursor:progress}
        .ct .go .label{overflow:hidden;text-overflow:ellipsis}
        .ct .seg{display:flex;margin:0;padding:1px;border:1px solid var(--key);border-radius:4px;background:var(--well);
            box-shadow:inset 0 1px 2px var(--key-lo),0 1px 0 var(--glow)}
        .ct .seg label{flex:1;position:relative;display:block}
        .ct .seg input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
        .ct .seg span{display:flex;align-items:center;justify-content:center;height:18px;padding:0 4px;white-space:nowrap;
            background:linear-gradient(var(--key-top),var(--key-bot));border:1px solid var(--key);margin-right:-1px;
            box-shadow:inset 0 1px 0 var(--key-hi),inset 0 -1px 0 var(--key-lo);text-shadow:0 1px 0 var(--emboss)}
        .ct .seg label:first-child span{border-radius:3px 0 0 3px}
        .ct .seg label:last-child span{border-radius:0 3px 3px 0;margin-right:0}
        .ct .seg input:checked+span{background:linear-gradient(var(--press-top),var(--press-bot));
            box-shadow:inset 0 2px 3px var(--key-lo),inset 1px 0 2px var(--key-lo);padding-top:2px;font-weight:bold}
        .ct .seg input:focus-visible+span{outline:1px dotted var(--focus);outline-offset:-3px}
        .ct details{border-top:1px solid var(--key);box-shadow:inset 0 1px 0 var(--glow);margin:0 -5px -5px;padding:0 5px}
        .ct summary{display:flex;align-items:center;gap:4px;height:18px;cursor:pointer;color:var(--muted);font-size:10.5px;list-style:none}
        .ct summary::-webkit-details-marker{display:none}
        .ct summary::before{content:"";border:3.5px solid transparent;border-left:4px solid var(--muted);margin-right:1px}
        .ct details[open] summary::before{border:3.5px solid transparent;border-top:4px solid var(--muted);margin:3px 2px 0 -1px}
        .ct .adv{display:grid;padding-bottom:4px}
        .ct .row{display:flex;align-items:center;gap:5px;height:19px;padding:0 4px;border:1px solid transparent;border-radius:3px;
            background:none;text-align:left;font-size:11px;white-space:nowrap}
        .ct .row:hover{background:var(--row-hover);border-color:var(--key-lo)}
        .ct .row:active,.ct .row[aria-pressed="true"]{background:linear-gradient(var(--press-top),var(--press-bot));box-shadow:inset 0 1px 2px var(--key-lo)}
        .ct .row[aria-busy="true"]{cursor:progress;opacity:.75}
        .ct .group{margin:3px 4px 1px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
        .ct .state{margin:2px 4px;font-size:10.5px;color:var(--muted)}
        .ct .state:empty{display:none}
        .ct .menu{position:absolute;z-index:1;min-width:150px;padding:2px;display:grid}
        .ct .menu[hidden]{display:none}
        .ct .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`;

    const model = {
        PROVIDERS, providerForHost, FORMATS, SCOPES, formatName,
        PREFS_KEY, DEFAULT_PREFS, normalizePrefs, loadPrefs, savePrefs, inPrivateContext,
        PRIMARY, ADVANCED, advancedFor, ICONS, icon, mark, accentFor, accentCSS, h, STYLES, MARK_SHAPES
    };

    if (typeof window !== 'undefined' && window.__chatToolkit) window.__chatToolkit.model = model;
    if (typeof globalThis !== 'undefined') globalThis.ChatToolkitModel = model;
})();
