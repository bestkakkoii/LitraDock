"""Operator setup only: download the exact pinned font, verifying bytes before publication."""
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parent
for row in json.loads((root / 'assets-manifest.json').read_text(encoding='utf-8')):
    path = root / row['path']
    if path.exists():
        data = path.read_bytes()
    else:
        if not row['path'].startswith('fonts/'):
            raise SystemExit('Packaged style/license asset missing.')
        with urllib.request.urlopen(row['url'], timeout=90) as response:
            data = response.read(row['bytes'] + 1)
    if len(data) != row['bytes'] or hashlib.sha256(data).hexdigest() != row['sha256']:
        raise SystemExit('Asset hash/length mismatch; existing files unchanged.')
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(data)
    print('Verified ' + row['path'])
