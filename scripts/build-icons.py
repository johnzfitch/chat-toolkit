"""Rasterize the Chat Toolkit SVG master into runtime and listing PNGs.

Source (edit this, never the PNGs):
  assets/design/chat-toolkit-mark.svg   matte identity mark

Outputs:
  extension-src/icons/chat-toolkit-{16,32,48,64,96,128}.png   identity (manifest)
  extension-src/icons/toolbar/ink-dark-{16,32,64}.png          for light toolbars (dark keyline)
  extension-src/icons/toolbar/ink-light-{16,32,64}.png         for dark toolbars (light halo)
  store/icons/chat-toolkit-{32,64,128,256,512}.png            AMO listing and promotional

Requires Python 3.10+, Pillow, and resvg-py (pip install pillow resvg-py).
Existing outputs are replaced; the SVG master is the only input.
"""
import hashlib
import io
import json
from pathlib import Path

import resvg_py
from PIL import Image

root = Path(__file__).resolve().parent.parent
design = root / 'assets' / 'design'
mark = (design / 'chat-toolkit-mark.svg').read_text(encoding='utf-8')
if '<g id="halo"/>' not in mark:
    raise ValueError('Mark master must contain the empty halo group')

# Firefox names theme icons by the theme's text colour: "dark" is used with
# dark text (light toolbars), "light" with light text (dark toolbars). On a
# dark toolbar the dark keyline disappears, so that variant gains a light halo
# drawn behind the same silhouette.
HALO = ('<g id="halo" fill="#f4f6f9" stroke="#f4f6f9" stroke-width="7" stroke-linejoin="round" opacity=".9">'
        '<path d="M28 5H47L58 16V43a3 3 0 0 1-3 3H28a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"/>'
        '<path d="M17 20H38a13 13 0 0 1 13 13v2a13 13 0 0 1-13 13H24L12 59l2-11.6A13 13 0 0 1 4 35v-2a13 13 0 0 1 13-13Z"/></g>')
TOOLBAR = {'ink-dark': mark, 'ink-light': mark.replace('<g id="halo"/>', HALO)}


def render(svg, size):
    data = bytes(resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size))
    image = Image.open(io.BytesIO(data)).convert('RGBA')
    if image.size != (size, size):
        raise ValueError(f'Rasterizer returned {image.size} for {size}px')
    return image


def write(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG', optimize=True)
    path.write_bytes(buffer.getvalue())
    return {'path': path.relative_to(root).as_posix(), 'size': image.size[0],
            'bytes': len(buffer.getvalue()), 'sha256': hashlib.sha256(buffer.getvalue()).hexdigest()}


outputs = []
for size in (16, 32, 48, 64, 96, 128):
    outputs.append(write(render(mark, size), root / 'extension-src' / 'icons' / f'chat-toolkit-{size}.png'))
for name, svg in TOOLBAR.items():
    for size in (16, 32, 64):
        outputs.append(write(render(svg, size),
                             root / 'extension-src' / 'icons' / 'toolbar' / f'{name}-{size}.png'))
for size in (32, 64, 128, 256, 512):
    outputs.append(write(render(mark, size), root / 'store' / 'icons' / f'chat-toolkit-{size}.png'))

print(json.dumps({
    'observation': 'Rendered every PNG from the SVG master and checked each pixel size.',
    'resvg_py': getattr(resvg_py, '__version__', 'unknown'),
    'outputs': outputs,
}, indent=2))
