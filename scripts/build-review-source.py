"""Build a fresh reviewer source ZIP from an explicit public-file allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('output', help='New reviewer .zip path; never overwritten')
args = parser.parse_args()
target = Path(args.output).resolve()
target.parent.mkdir(parents=True, exist_ok=True)

names = [
    '.gitignore', '.gitattributes', 'README.md', 'LICENSE', 'CONTRIBUTING.md',
    'SECURITY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'bun.lock',
    'scripts/build-xpi.py', 'scripts/build-review-source.py', 'scripts/build-icons.py',
    'scripts/capture-listing-screenshots.py',
    'tests/helpers/toolkit.js',
    'assets/design/chat-toolkit-mark.svg', 'assets/design/listing-harness/index.html',
    'assets/design/listing-harness/harness.js',
    '.github/workflows/ci.yml', '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md',
    'amo/LISTING.md', 'amo/PRIVACY.md', 'amo/REVIEWER-NOTES.md', 'amo/SUBMIT.md',
]
names += [p.relative_to(root).as_posix() for p in (root / 'extension-src').rglob('*') if p.is_file()]
names += [p.relative_to(root).as_posix() for p in (root / 'tests/public').glob('*.test.js')]
names += [p.relative_to(root).as_posix() for p in (root / 'docs').glob('*.md')]
names += [p.relative_to(root).as_posix() for p in (root / 'store' / 'icons').glob('*.png')]

for name in names:
    path = root / name
    if not path.is_file():
        raise ValueError(f'Missing public source file: {name}')
    if name.startswith('extension-src/') and path.suffix not in {'.js', '.json', '.html', '.png'}:
        raise ValueError(f'Unexpected runtime file type: {name}')
    if path.is_symlink():
        raise ValueError(f'Symlinks are not packaged: {name}')
if len(names) != len(set(names)):
    raise ValueError('Duplicate allowlist entry')

with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(names):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (root / name).read_bytes())
with zipfile.ZipFile(target) as archive:
    if archive.testzip() is not None:
        raise ValueError('Source ZIP CRC readback failed')
    if len(archive.namelist()) != len(names) or set(archive.namelist()) != set(names):
        raise ValueError('Source ZIP differs from allowlist')
    for name in names:
        if archive.read(name) != (root / name).read_bytes():
            raise ValueError(f'Source ZIP bytes differ: {name}')

print(json.dumps({
    'observation': 'Every source ZIP member matches the explicit public-file allowlist and its on-disk bytes; all CRCs read back.',
    'output': str(target), 'file_count': len(names), 'bytes': target.stat().st_size,
    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
    'files': sorted(names),
}, indent=2))
