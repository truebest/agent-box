#!/bin/sh
set -eu
test "${SOURCE_BRANCH:-}" = main
revision=${SOURCE_REVISION:-}
case "$revision" in
  ''|*[!0-9a-f]*) printf '%s\n' 'A full Git commit SHA is required.' >&2; exit 1 ;;
esac
test "${#revision}" -eq 40
test "$(cat artifacts/revision.txt)" = "$revision"
(cd artifacts && sha256sum -c SHA256SUMS)
(cd artifacts && sha256sum -c RUNTIME_SHA256SUMS)
(cd artifacts && sha256sum -c worker-SHA256SUMS && sha256sum -c controller-SHA256SUMS)
build_number=${BUILD_NUMBER:-}
case "$build_number" in
  ''|*[!0-9]*) printf '%s\n' 'A pipeline build number is required.' >&2; exit 1 ;;
esac
test -n "${AGENT_BOX_DEPLOY_SSH_KEY_B64:-}"
umask 077
ssh_directory=$(mktemp -d)
trap 'rm -rf "$ssh_directory"' EXIT
printf '%s' "$AGENT_BOX_DEPLOY_SSH_KEY_B64" | base64 -d > "$ssh_directory/key"
unset AGENT_BOX_DEPLOY_SSH_KEY_B64
deploy_target=${AGENT_BOX_DEPLOY_TARGET:?Set the deployment SSH user and host}
install_dir=${AGENT_BOX_INSTALL_DIR:?Set the installation repository path}
case "$deploy_target" in
  ''|*[!a-zA-Z0-9_.@:-]*|-*) exit 1 ;;
esac
case "$install_dir" in
  /*) ;;
  *) exit 1 ;;
esac
case "$install_dir" in
  *[!a-zA-Z0-9_./-]*|*..*) exit 1 ;;
esac
remote_config=${AGENT_BOX_DEPLOY_CONFIG:-$install_dir/deploy/install.local.json}
case "$remote_config" in
  /*) ;;
  *) exit 1 ;;
esac
case "$remote_config" in
  *[!a-zA-Z0-9_./-]*|*..*) exit 1 ;;
esac
release="$install_dir/archives/releases/$revision-$build_number"
ssh -F /dev/null -i "$ssh_directory/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=ci/known_hosts "$deploy_target" "mkdir -p '$release' && chmod 700 '$release'"
scp -F /dev/null -i "$ssh_directory/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=ci/known_hosts artifacts/panel.tar.gz artifacts/runtime.tar.gz artifacts/SHA256SUMS artifacts/RUNTIME_SHA256SUMS artifacts/revision.txt artifacts/image-id.json artifacts/runtime-image-id.json artifacts/worker.tar.gz artifacts/worker-image-id.json artifacts/worker-SHA256SUMS artifacts/controller.tar.gz artifacts/controller-image-id.json artifacts/controller-SHA256SUMS deploy/worker-profiles-rbac.yaml deploy/host-lifecycle.py vendor/substrate/manifests/ate-install/generated/ate.dev_workerpools.yaml deploy/panel-image.py deploy/refresh-native-runtime.py deploy/configuration.py "$deploy_target:$release/"
ssh -F /dev/null -i "$ssh_directory/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=ci/known_hosts "$deploy_target" "AGENT_BOX_CONFIG='$remote_config' python3 '$release/panel-image.py' '$release' && AGENT_BOX_CONFIG='$remote_config' python3 '$release/refresh-native-runtime.py' '$release'"
