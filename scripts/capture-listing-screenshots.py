"""Capture 1280x800 AMO listing screenshots from the synthetic harness.

Development tool; not part of the extension or its build. Requires Python
3.10+, Selenium 4, and a Firefox binary (geckodriver is fetched by Selenium
Manager). The harness renders the real panel/popup code from extension-src/
over a neutral synthetic chat page, so screenshots show no provider site and
no real conversation.

  python scripts/capture-listing-screenshots.py --firefox "C:/Program Files/Firefox Nightly/firefox.exe"
"""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

root = Path(__file__).resolve().parent.parent
harness = root / 'assets' / 'design' / 'listing-harness'
out = root / 'store' / 'screenshots'

parser = argparse.ArgumentParser()
parser.add_argument('--firefox', required=True, help='Firefox binary to drive')
args = parser.parse_args()

# Build the popup preview: the real popup.html with a stub browser API
# (a supported tab, empty preferences) injected before its scripts.
popup = (root / 'extension-src' / 'popup' / 'popup.html').read_text(encoding='utf-8')
lib = (root / 'extension-src' / 'lib').as_uri()
stub = """<script>
window.browser = {
  tabs: { async query() { return [{ id: 1, url: 'https://example.invalid/chat' }]; },
          async sendMessage() { return { conversation: true, context: 'Saved conversation open' }; } },
  runtime: { async openOptionsPage() {} },
  storage: { local: { async get() { return {}; }, async set() {} } },
  extension: { inIncognitoContext: false }
};
</script>
<script src="%s/ui-model.js"></script>
<script>ChatToolkitModel.PROVIDERS.demo = { name: 'Example chat', hosts: ['example.invalid'] };</script>
<script src="%s/../popup/popup.js"></script>""" % (lib, lib)
popup = re.sub(r'<script src="\.\./lib/ui-model\.js"></script>\s*<script src="popup\.js"></script>', lambda _: stub, popup)
if 'example.invalid' not in popup:
    raise ValueError('popup.html script tags changed; update the preview generator')
(harness / 'popup-preview.html').write_text(popup, encoding='utf-8')

SHOTS = [
    ('01-export-palette.png', 'state=default', 'Export palette: copy or save the selected messages and file type'),
    ('02-advanced-tools.png', 'state=advanced', 'Advanced tools: inspectors, comparison, and diagnostic captures'),
    ('03-panel-menu.png', 'state=menu', 'Panel menu: docking, reset, hide on this site, and help'),
    ('04-report.png', 'state=report', 'Comparison report kept inside the browser'),
    ('05-collapsed.png', 'state=collapsed', 'Collapsed launcher with a result notification'),
    ('06-toolbar-popup.png', 'state=popup', 'Toolbar popup with the same export controls'),
]

options = Options()
options.binary_location = args.firefox
options.add_argument('-headless')
options.set_preference('security.fileuri.strict_origin_policy', False)
driver = webdriver.Firefox(options=options)
records = []
try:
    driver.set_window_size(1280, 800)
    inner = driver.execute_script('return [window.innerWidth, window.innerHeight]')
    # Size the viewport, not the outer window, to 1280x800.
    driver.set_window_size(1280 + (1280 - inner[0]), 800 + (800 - inner[1]))
    out.mkdir(parents=True, exist_ok=True)
    for name, query, caption in SHOTS:
        driver.get((harness / 'index.html').as_uri() + '?' + query)
        end = time.time() + 15
        ready = None
        while time.time() < end:
            ready = driver.execute_script('return document.documentElement.dataset.ready')
            if ready:
                break
            time.sleep(0.2)
        if ready != '1':
            raise RuntimeError(f'{name}: harness not ready ({ready})')
        time.sleep(0.3)
        path = out / name
        driver.save_screenshot(str(path))
        records.append({'file': path.relative_to(root).as_posix(), 'caption': caption,
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    records.append({'viewport': driver.execute_script('return [window.innerWidth, window.innerHeight]'),
                    'firefox': driver.capabilities.get('browserVersion')})
finally:
    driver.quit()
    (harness / 'popup-preview.html').unlink(missing_ok=True)
print(json.dumps(records, indent=2))
