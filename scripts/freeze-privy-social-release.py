"""Freeze auth changes over the verified ChatGPTEE hybrid source, without secrets."""
from pathlib import Path
import datetime, hashlib, json, shutil
root=Path(__file__).resolve().parent.parent
base=root/'artifacts/hybrid-auth/releases/chatgptee-hybrid-20261010T170957Z/stage'
assert (base/'public/hybrid-auth-release.json').exists()
release_id='chatgptee-privy-social-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
release_dir=root/'artifacts/hybrid-auth/releases'/release_id
stage=release_dir/'stage'
shutil.copytree(base,stage,ignore=shutil.ignore_patterns('node_modules','dist','.env','.env.*'))
for name in ['src/client/PrivySignIn.tsx','src/server/better-auth.ts','src/server/privy-auth.ts']:
 shutil.copy2(root/name,stage/name)
p=stage/'src/client/AuthGate.tsx';text=p.read_text()
def replace(old,new):
 global text
 assert text.count(old)==1,old
 text=text.replace(old,new)
replace('  socialProviders?: string[];','  socialProviders?: string[];\n  privySocialProviders?: string[];')
replace('''          {config.betterAuth && (
            <SocialSignIn config={config} onError={setError} />
          )}''','''          {config.privyAppId && !!config.privySocialProviders?.length ? (
            <Suspense fallback={<p>Loading sign-in options…</p>}>
              <PrivySignIn config={config} onSession={setSession} onError={setError} />
            </Suspense>
          ) : config.betterAuth && (
            <SocialSignIn config={config} onError={setError} />
          )}''')
replace('          {config.privyAppId && (','          {config.privyAppId && !config.privySocialProviders?.length && (')
replace('''                  <PrivySignIn
                    config={config}
                    onSession={setSession}''','''                  <PrivySignIn
                    config={config}
                    walletOnly
                    onSession={setSession}''')
replace('''              <SocialSignIn config={config} link onError={setError} />''','''              {config.privyAppId && !!config.privySocialProviders?.length ? (
                <Suspense fallback={<p>Loading account options…</p>}>
                  <PrivySignIn config={config} link workspaceId={session.user.id} onSession={() => void refresh()} onError={setError} />
                </Suspense>
              ) : <SocialSignIn config={config} link onError={setError} />}''')
p.write_text(text)
# Inventory source inputs before generated metadata and output directories.
(stage/'public/hybrid-auth-release.json').unlink()
files=sorted([[str(p.relative_to(stage)),hashlib.sha256(p.read_bytes()).hexdigest()] for p in stage.rglob('*') if p.is_file()])
source_hash=hashlib.sha256(json.dumps(files,separators=(',',':')).encode()).hexdigest()
release={'releaseId':release_id,'sourceHash':source_hash,'sourceFiles':len(files),'auth':'Privy + Better Auth','socialAuth':'Privy Google, X, GitHub','baseURL':'https://chatgptee.ai','basePath':'/api/auth','sourceCommit':'625452e06cde74cb25b0ce319e2c1be0488f5a5f'}
(stage/'public/hybrid-auth-release.json').write_text(json.dumps(release,indent=2)+'\n')
manifest={'stage':str(stage),'release':release,'files':files,'baseRelease':'chatgptee-hybrid-20261010T170957Z','changedRuntimeFiles':['src/client/AuthGate.tsx','src/client/PrivySignIn.tsx','src/server/better-auth.ts','src/server/privy-auth.ts']}
(release_dir/'release-source.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'artifacts/hybrid-auth/social-release-candidate.json').write_text(json.dumps({'stage':str(stage),'release':release,'deployed':False,'status':'prepared'},indent=2)+'\n')
print(json.dumps({'stage':str(stage),'release':release}))
