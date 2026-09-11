"""Run a bounded synthetic command and sample relevant Linux process RSS; never read argv/env."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

output = Path(sys.argv[1])
command = sys.argv[2:]
if command[:1] == ['--']:
    command = command[1:]
started = time.monotonic()
child = subprocess.Popen(command)
peaks = {}
total_peak = 0
samples = 0
page = os.sysconf('SC_PAGE_SIZE')
while True:
    current = {}
    for directory in Path('/proc').iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            name = (directory / 'comm').read_text().strip()
            if not (name in {'dotnet', 'node', 'postgres', 'pg_dump', 'pg_restore'} or name.startswith(('chrome', 'chromium'))):
                continue
            rss = int((directory / 'statm').read_text().split()[1]) * page
            current[name] = current.get(name, 0) + rss
        except (OSError, ValueError, IndexError):
            continue
    for name, rss in current.items():
        peaks[name] = max(peaks.get(name, 0), rss)
    total_peak = max(total_peak, sum(current.values()))
    samples += 1
    if child.poll() is not None:
        break
    if time.monotonic() - started > 480:
        child.kill()
        child.wait()
        break
    time.sleep(.1)
output.write_text(json.dumps({
    'elapsedSeconds': time.monotonic() - started,
    'samples': samples,
    'intervalSeconds': .1,
    'aggregateObservedRssPeakBytes': total_peak,
    'categoryRssPeaksBytes': peaks,
    'exitCode': child.returncode,
    'scope': 'Host-visible dotnet, PostgreSQL server/dump/restore, Node and Chromium process RSS; shared pages can be counted repeatedly; includes compiler processes if present; excludes kernel, filesystem cache, unrelated processes and between-sample peaks. No production capacity extrapolation.'
}, indent=2), encoding='utf-8')
sys.exit(child.returncode or 0)
