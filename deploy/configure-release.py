"""Apply the agent-box-host install overlay to an untouched Substrate v0.5.0 tree."""
from pathlib import Path
import sys

root = Path(sys.argv[1]) / "manifests/ate-install"


def replace(file, old, new):
    path = root / file
    text = path.read_text()
    assert old in text, (file, old)
    path.write_text(text.replace(old, new))


replace("kind/postgres/kustomization.yaml", "value: 1Gi", "value: 16Gi")
replace("kind/rustfs.yaml", "storage: 1Gi", "storage: 1Ti\n  storageClassName: agent-thin")
for file in ("kind/rustfs.yaml", "kind/kustomization.yaml", "kind/atelet/kustomization.yaml"):
    for name in ("RUSTFS_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "RUSTFS_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"):
        key = "access-key" if name in ("RUSTFS_ACCESS_KEY", "AWS_ACCESS_KEY_ID") else "secret-key"
        import re
        path = root / file
        text = path.read_text()
        text = re.sub(r'(?P<i> +)- name: ' + name + r'\n +value: "?rustfsadmin"?',
                      lambda m: f'{m["i"]}- name: {name}\n{m["i"]}  valueFrom:\n{m["i"]}    secretKeyRef:\n{m["i"]}      name: substrate-storage\n{m["i"]}      key: {key}', text)
        path.write_text(text)
replace("postgres/postgres.yaml", "- name: POSTGRES_HOST_AUTH_METHOD\n          value: trust", "- name: POSTGRES_PASSWORD\n          valueFrom:\n            secretKeyRef:\n              name: substrate-storage\n              key: postgres-password")
replace("atelet.yaml", "      initContainers:\n", '''      initContainers:
      - name: require-ate-volume
        image: postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
        command: [sh, -ec, 'test -e /var/lib/ate/.substrate-volume && test "$(stat -f -c %T /var/lib/ate)" = xfs']
        volumeMounts:
        - name: run-ateom
          mountPath: /var/lib/ate
          mountPropagation: HostToContainer
''')
replace("atenet-router.yaml", '- "--ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/ate-e2e-router-client/sa/router-client"', '- "--ingress-auth-mode=static-mtls"\n        - "--ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/pvm-agents/sa/panel"')
replace("atenet-router.yaml", '--port-http=8080', '--port-http=0')
replace("atenet-router.yaml", '--port-connect=8081', '--port-connect=0')
replace("atenet-router.yaml", '  - name: http\n    port: 80\n    targetPort: 8080\n    protocol: TCP\n', '')
replace("atenet-router.yaml", '  - name: connect\n    port: 8081\n    targetPort: 8081\n    protocol: TCP\n', '')
assert not any("rustfsadmin" in (root / f).read_text() for f in ("kind/rustfs.yaml", "kind/kustomization.yaml", "kind/atelet/kustomization.yaml"))
