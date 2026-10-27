"""Create a new KIND cluster using the local installation settings."""
import json
from pathlib import Path
import subprocess as sp
import tempfile
from configuration import load

config = load()
existing = sp.check_output(['kind', 'get', 'clusters'], text=True).splitlines()
if config['kind_cluster'] in existing:
    raise SystemExit('The configured cluster already exists. It will not be replaced.')
if not Path(config['workspace_mount'], '.substrate-volume').exists():
    raise SystemExit('Run deploy/prepare-host.py before creating the cluster')
cluster = {
    'kind': 'Cluster', 'apiVersion': 'kind.x-k8s.io/v1alpha4',
    'featureGates': {'ClusterTrustBundle': True, 'ClusterTrustBundleProjection': True, 'PodCertificateRequest': True},
    'runtimeConfig': {'certificates.k8s.io/v1beta1': 'true'},
    'nodes': [{'role': 'control-plane', 'extraMounts': [
        {'hostPath': config['workspace_mount'], 'containerPath': '/var/lib/ate', 'propagation': 'HostToContainer'},
        {'hostPath': '/dev', 'containerPath': '/host-dev', 'propagation': 'HostToContainer'},
    ]}],
    'networking': {'ipFamily': 'ipv4'},
    'kubeadmConfigPatches': ['kind: KubeletConfiguration\nserializeImagePulls: false\nmaxParallelImagePulls: 4\n'],
}
with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as file:
    json.dump(cluster, file)
    file.flush()
    sp.run(['kind', 'create', 'cluster', '--name', config['kind_cluster'], '--retain', '--config', file.name], check=True)
print('Cluster created:', config['kube_context'])
