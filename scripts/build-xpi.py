"""Build a fresh XPI from extension-src plus LICENSE and read every member back."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import zipfile
import zlib

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('output', help='New .xpi path (existing files are never overwritten)')
args = parser.parse_args()
source = root / 'extension-src'
target = Path(args.output).resolve()
target.parent.mkdir(parents=True, exist_ok=True)
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
files = {p.relative_to(source).as_posix(): p for p in sorted(source.rglob('*')) if p.is_file()}
files['LICENSE'] = root / 'LICENSE'
for name, path in files.items():
    if path.is_symlink() or (name != 'LICENSE' and path.suffix not in {'.js', '.json', '.html', '.png'}):
        raise ValueError(f'Unexpected runtime file: {name}')
referenced = manifest['background']['scripts'] + [s for group in manifest['content_scripts'] for s in group['js']]
referenced += list(manifest['icons'].values()) + manifest.get('web_accessible_resources', [])
referenced += [manifest['browser_action']['default_popup']]
referenced += list(manifest['browser_action']['default_icon'].values())
referenced += [path for icon in manifest['browser_action'].get('theme_icons', []) for path in (icon['light'], icon['dark'])]
if manifest.get('options_ui'):
    referenced.append(manifest['options_ui']['page'])
for name in referenced:
    if name not in files:
        raise ValueError(f'Missing manifest resource: {name}')
with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
    for name, path in files.items():
        # Stable metadata makes the reviewer's rebuild byte-for-byte repeatable
        # with the same Python/zlib versions, regardless of checkout timestamps.
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())
with zipfile.ZipFile(target) as archive:
    if archive.testzip() is not None:
        raise ValueError('ZIP CRC readback failed')
    if len(archive.namelist()) != len(set(archive.namelist())) or set(archive.namelist()) != set(files):
        raise ValueError('ZIP member set differs from extension-src')
    for name, path in files.items():
        if archive.read(name) != path.read_bytes():
            raise ValueError(f'Archive bytes differ from source: {name}')
print(json.dumps({
    'observation': 'Every XPI member matches its source file, all ZIP CRCs read back, and every manifest resource exists.',
    'output': str(target), 'version': manifest['version'], 'file_count': len(files),
    'bytes': target.stat().st_size,
    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
    'signed': False,
    'python': platform.python_version(),
    'zlib': zlib.ZLIB_RUNTIME_VERSION,
}, indent=2))
