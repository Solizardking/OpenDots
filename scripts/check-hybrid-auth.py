"""Run hybrid auth against a disposable local PostgreSQL instance, never .env."""
import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
for executable in ('initdb', 'pg_ctl', 'createdb', 'node'):
    if not shutil.which(executable):
        raise SystemExit('Required local test tool missing: ' + executable)
with tempfile.TemporaryDirectory(prefix='chatgptee-hybrid-pg-') as folder:
    data = Path(folder) / 'pgdata'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    def run(args):
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode:
            raise SystemExit(result.stderr)
    run(['initdb','-D',str(data),'--auth=trust','--no-locale','-U','hybrid_fixture'])
    run(['pg_ctl','-D',str(data),'-l',str(Path(folder)/'postgres.log'),'-o',f'-h 127.0.0.1 -p {port} -k {folder}','-w','start'])
    try:
        run(['createdb','-h','127.0.0.1','-p',str(port),'-U','hybrid_fixture','hybrid_fixture'])
        env = os.environ.copy()
        env['HYBRID_TEST_POSTGRES_URL'] = f'postgresql://hybrid_fixture@127.0.0.1:{port}/hybrid_fixture'
        env['DO_NOT_TRACK'] = '1'
        command = ['node','node_modules/vitest/vitest.mjs','run','tests/hybrid-auth.test.ts','--exclude','artifacts/**','--exclude','agent/**']
        if '--browser' in os.sys.argv:
            command = ['node','--import','tsx','scripts/check-hybrid-browser.ts']
        checked = subprocess.run(command,cwd=root,env=env,capture_output=True,text=True)
        print(checked.stdout,end='')
        print(checked.stderr,end='')
        artifact=root/'artifacts/hybrid-auth'
        artifact.mkdir(parents=True,exist_ok=True)
        (artifact/('browser-check.log' if '--browser' in os.sys.argv else 'postgres-check.log')).write_text(checked.stdout+checked.stderr)
        if checked.returncode:
            raise SystemExit(checked.returncode)
    finally:
        run(['pg_ctl','-D',str(data),'-m','fast','-w','stop'])
