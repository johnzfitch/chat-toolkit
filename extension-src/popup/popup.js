const status = document.querySelector('.s');
const SUPPORTED = [
    'claude.ai',
    'chatgpt.com',
    'chat.openai.com',
    'grok.com',
    'openrouter.ai',
    'gemini.google.com',
    'aistudio.google.com'
];

const setStatus = (text, color) => {
    status.textContent = text;
    status.style.color = color;
};

for (const button of document.querySelectorAll('button')) {
    button.addEventListener('click', async () => {
        setStatus('...', '#6e7681');
        try {
            if (button.dataset.a === 'open-help') {
                await browser.runtime.openOptionsPage();
                window.close();
                return;
            }
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            const url = new URL(tab?.url || 'about:blank');
            if (url.protocol !== 'https:' || !SUPPORTED.includes(url.hostname)) throw new Error('Open a supported chat first');
            await browser.tabs.sendMessage(tab.id, { action: button.dataset.a });
            setStatus('OK', '#7ee787');
            setTimeout(() => window.close(), 500);
        } catch (e) {
            setStatus(e.message || 'Error', '#f85149');
        }
    });
}
