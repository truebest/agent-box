"""Refresh enabled profiles for new native sandboxes after a verified deployment."""
import argparse
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import time
import urllib.request

ROOT = Path('/home/operator/substrate-agent-box-host')
ATE = ROOT/'vendor/substrate/bin/kubectl-ate'


def catalog():
    raw = subprocess.check_output(['kubectl','-n','pvm-agents','get','configmap','worker-profiles','--ignore-not-found','-o','json'])
    if not raw.strip():
        return None
    return json.loads(json.loads(raw)['data']['catalog.json'])


def identities():
    value = json.loads(subprocess.check_output([str(ATE),'get','actors','-A','-o','json']))
    return {a['metadata']['uid']:dict(name=a['metadata']['name'],template=a['actorTemplate']) for a in value.get('actors',[])}


def published(repository, revision):
    req = urllib.request.Request('http://127.0.0.1:5001/v2/'+repository+'/manifests/ci-'+revision,
        headers={'Accept':'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
    with urllib.request.urlopen(req) as response:
        digest=response.headers['Docker-Content-Digest']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',digest):
        raise ValueError('Invalid published image digest')
    return 'localhost:5001/'+repository+'@'+digest


def main(release):
    os.umask(0o077)
    release=release.resolve()
    if release.parent!=Path('/home/operator/substrate-releases'):
        raise ValueError('Use a verified release directory')
    revision=(release/'revision.txt').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{40}',revision):
        raise ValueError('Invalid release identity')
    before=catalog()
    if before is None:
        print(json.dumps(dict(revision=revision,profiles_refreshed=[],reason='Worker profiles are not installed')))
        return
    images=json.loads((ROOT/'images.json').read_text())
    if images['sandbox']['image']!=published('agents/native',revision) or images['panel']!=published('panel',revision):
        raise ValueError('Deploy the verified runtime and panel first')
    if before['mode']!='active' or before['base_template']['containers'][0]['image']!=images['sandbox']['image']:
        raise ValueError('The native catalog does not match the verified release')
    original=identities()
    record=ROOT/'archives'/('native-runtime-'+revision+'-'+str(time.time_ns())+'.json')
    record.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    record.write_text(json.dumps(dict(revision=revision,catalog=before,actors=original),indent=2)+'\n')
    life=runpy.run_path(str(ROOT/'deploy/host-lifecycle.py'))
    refreshed=[]
    with life['forward_panel']('svc/panel',19543) as process:
        def request(method,path,body=None):
            return life['request'](method,path,body,port=19543)
        deadline=time.monotonic()+30
        while True:
            try:
                profiles=request('GET','/api/worker-profiles')['profiles']
                break
            except RuntimeError:
                if process.poll() is not None or time.monotonic()>=deadline:
                    raise
                time.sleep(.2)
        for view in profiles:
            if not view['enabled']:
                continue
            current=next(p for p in before['profiles'] if p['id']==view['id'])
            latest=current['revisions'][-1]
            if latest['worker_image']==before['worker_image'] and latest['template_spec']['containers']==before['base_template']['containers']:
                continue
            if current['version']!=view['version']:
                raise RuntimeError('Profile changed during deployment; reload before refreshing')
            fields=['name','version','cpu_milli','memory_mib','slots','min_workers','max_workers','enabled','default','reserved_cpu_milli','reserved_memory_mib']
            body={key:view[key] for key in fields}
            body['refresh_runtime']=True
            request('PUT','/api/worker-profiles/'+view['id'],body)
            refreshed.append(view['id'])
    after=catalog()
    if after is None:
        raise RuntimeError('Worker profile catalog disappeared during refresh')
    for old in before['profiles']:
        current=next(p for p in after['profiles'] if p['id']==old['id'])
        if current['revisions'][:len(old['revisions'])]!=old['revisions']:
            raise RuntimeError('An existing immutable runtime revision changed')
    remaining=identities()
    if any(remaining.get(uid)!=identity for uid,identity in original.items()):
        raise RuntimeError('Sandbox identity changed; inspect the deployment record')
    result=dict(revision=revision,runtime=images['sandbox']['image'],profiles_refreshed=refreshed,
                actors_preserved=len(original),record=str(record))
    (release/'native-runtime-refresh.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release',type=Path)
    main(parser.parse_args().release)
