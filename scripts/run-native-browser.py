"""Run a closed-transport browser qualification against native handlers and fresh PG.

Caller creates the explicitly named disposable database and supplies its protected
configuration. No database deletion, provider request or production process occurs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}

parser = argparse.ArgumentParser()
parser.add_argument('--user-route', action='store_true', help='Run isolated browser-origin PubMed workflow')
parser.add_argument('--bundles', action='store_true', help='Run isolated prepared bundle/byte-range browser workload')
parser.add_argument('--plans', action='store_true', help='Run the focused processing-plan browser workload')
parser.add_argument('--multirun', action='store_true', help='Run the focused multi-run saved-set browser workload')
parser.add_argument('--continuation', action='store_true', help='Run the focused durable search continuation workload')
parser.add_argument('--revision', required=True)
parser.add_argument('--config', type=Path, required=True)
parser.add_argument('--manifest', type=Path, required=True)
parser.add_argument('--frontend-directory', type=Path, required=True)
parser.add_argument('--output-directory', type=Path, required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
if not re.fullmatch(r'[0-9a-f]{40}', args.revision):
    sys.exit('Exact source revision required')
if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True, **flags).strip() != args.revision:
    sys.exit('Checkout/source revision mismatch')
subprocess.run(['git', 'diff', '--exit-code', args.revision, '--', 'src/literature-server', 'src/literature-web', 'tests/native-browser', 'scripts/run-native-browser.py'], cwd=repo, check=True, **flags)
untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '--', 'src/literature-server', 'tests/native-browser'], cwd=repo, text=True, **flags).strip()
if untracked:
    sys.exit('Untracked acceptance source is not allowed')
manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
if manifest.get('source_revision') != args.revision:
    sys.exit('Manifest/source revision mismatch')
cfg = json.loads(args.config.read_text(encoding='utf-8'))
cfg['FrontendDirectory'] = str(args.frontend_directory.resolve())
out = args.output_directory.resolve()
out.mkdir(parents=True, exist_ok=False)
config_file, input_file = out/'config.json', out/'input.json'
config_file.write_text(json.dumps(cfg), encoding='utf-8')
config_file.chmod(0o600)
env = dict(os.environ, LITRADOCK_BROWSER_TEST='yes', LITRADOCK_GO_CONFIG=str(config_file), NATIVE_BROWSER_INPUT=str(input_file), NATIVE_BROWSER_REVISION=args.revision, NATIVE_BROWSER_MANIFEST=str(args.manifest.resolve()))
if args.bundles:
    env['LITRADOCK_BUNDLE_BROWSER_TEST'] = 'yes'
if args.plans:
    env['LITRADOCK_PLAN_BROWSER_TEST'] = 'yes'
if args.multirun:
    env['LITRADOCK_MULTIRUN_BROWSER_TEST'] = 'yes'
if args.continuation:
    env['LITRADOCK_CONTINUATION_BROWSER_TEST'] = 'yes'
if args.user_route:
    env['LITRADOCK_USER_ROUTE_BROWSER_TEST'] = 'yes'
binary = out/('browser-server.exe' if os.name == 'nt' else 'browser-server')
with (out/'compile.log').open('wb') as log:
    subprocess.run(['go', 'test', '-c', '-o', str(binary)], cwd=repo/'src/literature-server', env=env, stdout=log, stderr=subprocess.STDOUT, check=True, **flags)
process = None
try:
    with (out/'server.log').open('wb') as server_log:
        process = subprocess.Popen([str(binary), '-test.run=^TestBrowserServer$', '-test.v', '-test.timeout=13m'], cwd=repo/'src/literature-server', env=env, stdout=server_log, stderr=subprocess.STDOUT, **flags)
        deadline = time.monotonic()+40
        while not input_file.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('Guarded test server did not become ready; inspect synthetic server log')
            time.sleep(.2)
        # The ready receipt never goes to stdout or a distributable artifact.
        data = json.loads(input_file.read_text(encoding='utf-8'))
        env['NATIVE_BROWSER_URL'] = data['origin']
        with (out/'browser.log').open('wb') as log:
            npm = 'npm.cmd' if os.name == 'nt' else 'npm'
            command = [npm, 'run', 'test:multirun'] if args.multirun else ([npm, 'run', 'test:plans'] if args.plans else [npm, 'test'])
            if args.bundles:
                command = [npm, 'run', 'test:bundles']
            if args.continuation:
                command = [npm, 'run', 'test:continuation']
            if args.user_route:
                command = ['node', 'user-route-browser-regression.mjs']
            subprocess.run(command, cwd=repo/'tests/native-browser', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=480, check=True, **flags)
        Path(str(input_file)+'.stop').touch()
        if process.wait(timeout=20) != 0:
            raise RuntimeError('Test server exit failed')
        receipt = {'revision': args.revision, 'scope': 'Actual native PostgreSQL/compiled handlers/static frontend; exclusively synthetic source transport, no live coverage', 'test_binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'manifest_sha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(), 'browser_exit': 0, 'server_exit': 0, 'plans': args.plans}
        receipt['multirun'] = args.multirun
        receipt['continuation'] = args.continuation
        receipt['bundles'] = args.bundles
        receipt['user_route'] = args.user_route
        (out/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
        print(json.dumps(receipt))
finally:
    if process is not None and process.poll() is None:
        Path(str(input_file)+'.stop').touch()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
