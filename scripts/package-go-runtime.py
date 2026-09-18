# Code-only candidate packaging. Assertions are deliberate verification gates: do not run with python -O.
from pathlib import Path
import subprocess,hashlib,json,tarfile,io,argparse,sys,os
flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
if sys.flags.optimize:
 raise SystemExit('Optimized Python disables verification gates and is unsupported.')
parser=argparse.ArgumentParser(description='Build a code-only native runtime archive from an exact source revision and two equal offline builds.')
parser.add_argument('--revision', required=True)
parser.add_argument('--build-directory', type=Path, required=True)
parser.add_argument('--frontend-directory', type=Path)
parser.add_argument('--frontend-repeat-directory', type=Path)
args=parser.parse_args()
p=args.build_directory.resolve();repo=Path(__file__).resolve().parents[1];revision=args.revision
assert len(revision)==40 and all(c in '0123456789abcdef' for c in revision), 'Full immutable source revision required'
sha=lambda b:hashlib.sha256(b).hexdigest()
source={}
locked=subprocess.run(['git','-C',str(repo),'ls-tree','-r','--name-only',revision,'--','src/literature-server'],capture_output=True,text=True,check=True,**flags).stdout.splitlines()
expected={x for x in locked if Path(x).name in ['go.mod','go.sum'] or x.endswith('.go') and not x.endswith('_test.go')}
for f in sorted((repo/'src/literature-server').glob('*')):
 if f.name in ['go.mod','go.sum'] or f.suffix=='.go' and not f.name.endswith('_test.go'):
  rel=f.relative_to(repo).as_posix();blob=subprocess.run(['git','-C',str(repo),'show',revision+':'+rel],capture_output=True,check=True,**flags).stdout;assert blob==f.read_bytes().replace(b'\r\n',b'\n');source[rel]=sha(blob)
assert set(source)==expected, 'Missing or unexpected production source member'
server=(p/'server').read_bytes();assert server==(p/'server-repeat').read_bytes();notices=subprocess.run(['git','-C',str(repo),'show',revision+':src/literature-server/THIRD_PARTY_NOTICES.md'],capture_output=True,check=True,**flags).stdout
manifest={'format':'litradock.go.runtime.v1','source_revision':revision,'source_sha256':source,'compiler':'go1.27.1','target':'linux/amd64 GOAMD64=v1 CGO_ENABLED=0','flags':['-buildvcs=false','-trimpath'],'files':{'server':sha(server),'THIRD_PARTY_NOTICES.md':sha(notices)},'scope':'isolated native candidate; no public cutover, signed release or full license/vulnerability clearance'}
files={'server':server,'THIRD_PARTY_NOTICES.md':notices}
license_path='LICENSE' if subprocess.run(['git','-C',str(repo),'ls-tree','--name-only',revision,'--','LICENSE'],capture_output=True,text=True,check=True,**flags).stdout.strip() else 'deployment/private-candidate/LICENSE'
license_bytes=subprocess.run(['git','-C',str(repo),'show',revision+':'+license_path],capture_output=True,check=True,**flags).stdout
assert b'GNU AFFERO GENERAL PUBLIC LICENSE' in license_bytes, 'Reviewed project license required'
files['LICENSE']=license_bytes
manifest['files']['LICENSE']=sha(license_bytes)
manifest['project_license_git_path']=license_path
if args.frontend_directory:
 assert args.frontend_repeat_directory, 'Independent repeated frontend output required'
 web=repo/'src/literature-web';dist=args.frontend_directory.resolve();repeat=args.frontend_repeat_directory.resolve()
 paths=subprocess.run(['git','-C',str(repo),'ls-tree','-r','--name-only',revision,'--','src/literature-web'],capture_output=True,text=True,check=True,**flags).stdout.splitlines()
 assert paths, 'Frontend source must be committed'
 for rel in paths:
  blob=subprocess.run(['git','-C',str(repo),'show',revision+':'+rel],capture_output=True,check=True,**flags).stdout
  assert blob==(repo/rel).read_bytes().replace(b'\r\n',b'\n'), 'Frontend differs from revision'
  source[rel]=sha(blob)
 members={x.relative_to(dist).as_posix():x.read_bytes() for x in dist.rglob('*') if x.is_file()}
 repeated={x.relative_to(repeat).as_posix():x.read_bytes() for x in repeat.rglob('*') if x.is_file()}
 assert members==repeated and 'index.html' in members, 'Repeated frontend output differs'
 import re
 assert len(members)==3 and all(k=='index.html' or re.fullmatch(r'assets/index-[A-Za-z0-9_-]+\.(js|css)',k) for k in members), 'Unreviewed frontend member'
 html=members['index.html'].decode()
 assert all('/'+k in html for k in members if k!='index.html'), 'Frontend reference mismatch'
 locked=json.loads((web/'package-lock.json').read_text())['packages'];runtime=[];license_text=[]
 for name in ['react','react-dom','scheduler']:
  pkg=json.loads((web/'node_modules'/name/'package.json').read_text());lock=locked['node_modules/'+name];assert pkg['version']==lock['version'] and pkg['license']=='MIT'
  license=(web/'node_modules'/name/'LICENSE').read_bytes();runtime.append({'package':name,'version':pkg['version'],'registry':lock['resolved'],'integrity':lock['integrity'],'license_sha256':sha(license)})
  license_text.append('## '+name+' '+pkg['version']+'\n\n'+license.decode())
 files.update({'web/'+k:v for k,v in members.items()});files['FRONTEND_NOTICES.md']='\n\n'.join(license_text).encode();manifest['frontend_runtime']=runtime
 manifest['frontend_build']='Vite static build, repeated output byte equality; Node runtime not required on server'
 manifest['files']={k:sha(v) for k,v in files.items()}
files['manifest.json']=(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()
def pack(values):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as t:
  for name,b in sorted(values.items()):
   info=tarfile.TarInfo(name);info.size=len(b);info.mode=0o755 if name=='server' else 0o644;info.mtime=0;t.addfile(info,io.BytesIO(b))
 return out.getvalue()
def verify(b):
 with tarfile.open(fileobj=io.BytesIO(b)) as t:
  members=t.getmembers();assert {x.name for x in members}==set(files) and len(members)==len(files) and all(x.isfile() for x in members)
  m=json.loads(t.extractfile('manifest.json').read());assert m==manifest
  for name,expected in m['files'].items():assert sha(t.extractfile(name).read())==expected
b=pack(files);assert b==pack(files);verify(b)
controls=[]
for label,changed in [('missing',{k:v for k,v in files.items() if k!='server'}),('unexpected',dict(files,**{'testdata/unexpected.json':b'{}'})),('modified',dict(files,server=server+b'X'))]:
 try:verify(pack(changed));raise RuntimeError('Negative control accepted')
 except AssertionError:controls.append(label)
(p/'runtime.tar').write_bytes(b);(p/'runtime-manifest.json').write_bytes(files['manifest.json']);(p/'runtime-package.json').write_text(json.dumps({'archive_sha256':sha(b),'bytes':len(b),'binary_sha256':sha(server),'members':sorted(files),'deterministic_rebuild_binary':True,'deterministic_archive':True,'rejected_controls':controls,'source_revision':revision},indent=2))
print((p/'runtime-package.json').read_text())
