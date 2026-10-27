# Worker profiles

A Worker profile sets CPU, memory, sandbox slots and minimum and maximum Worker
counts. The scheduler places sandboxes on matching gVisor Workers in Kubernetes.
Agent kind, model and prompt are selected when creating a sandbox.

## Resource allocation

The profile editor accepts whole CPU cores and memory per sandbox. Worker totals
are calculated as:

```text
Worker CPU = sandbox CPU × slots
Worker memory = sandbox memory × slots + 64 MiB
```

For example, four slots of 2 CPU and 2048 MiB use a Worker allocation of 8000
millicores and 8256 MiB. Changing the slot count preserves each sandbox's limits.

The API uses integer millicores and MiB. Sandbox limits are the Worker allocation
minus its service reserve, divided by slots. CPU limits are shared upper bounds.
Size memory and capacity for the processes running in your sandboxes.

Resource versions store their CPU and memory reserves. Existing versions keep
those values when resumed. Names and scaling settings can be edited without
creating a resource version. Changes to CPU, memory or slots create a version
for new sandboxes. Existing sandboxes keep their template, images and limits.

Profiles default to zero minimum and eight maximum Workers. The Host limit is
eight Workers across its managed pools, including starting and terminating Pods.
Before reserving a Worker, the manager checks node resources, Pod requests,
limits, overhead and pending reservations. Kubernetes makes the final admission
decision. Each managed WorkerPool has one replica.

## Scaling and lifecycle

The catalog is stored in the `pvm-agents/worker-profiles` ConfigMap. It records
profile settings, resource versions, template bindings and Worker reservations.
Updates use Kubernetes resource-version checks. Conflicting profile edits return
HTTP 409.

A reservation is recorded before its WorkerPool is created. Pending and failed
starts continue to count against capacity until reconciled. A Kubernetes Lease
serializes Host capacity checks across catalogs.

A Worker must remain empty for five minutes before retirement. The manager drains
it, checks assignments and removes the recorded WorkerPool UID. Failed checks keep
the Worker available for inspection. Minimum Worker counts are reconciled
periodically. Pending resumes can reclaim empty Workers for a saved resource version.

Disabling a profile stops new sandbox creation while allowing existing sandboxes
to resume. Deletion requires the profile to have no Workers or sandboxes.

The `active` management mode allows creation, resume and scaling. `quiescing`
stops admission and allows suspension. Runtime handshakes use the same admission
barrier because routing can resume a sandbox. The host lifecycle service enters
this mode before saving the pool for shutdown.

## API

Routes require panel authentication and Origin validation.

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/worker-profiles` | GET, POST | List and create profiles |
| `/api/worker-profiles/{id}` | GET, PUT, DELETE | Read, update or delete a profile |
| `/api/workers` | GET | Worker state, resource version, slots and allocations |
| `/api/worker-management` | GET, PUT | Read or update management mode |
| `/api/agents` | POST | Create a sandbox with an optional `profile_id` |

Profile inputs include `name`, `cpu_milli`, `memory_mib`, `slots`, `min_workers`,
`max_workers`, `enabled`, `default` and the current integer `version`.
`reserved_cpu_milli` and `reserved_memory_mib` specify the service reserve.
DELETE requires `version` in its JSON body. Management PUT requires `mode` and
its string `version`.

## Setup and updates

Build the controller, Worker, runtime and panel with `sh ci/check.sh`. Apply the
WorkerPool CRD and `deploy/worker-profiles-rbac.yaml` before enabling
Worker profiles on the panel. Configure the panel container's identity through
the Kubernetes downward API:

```yaml
env:
  - name: WORKER_PROFILES
    value: "true"
  - name: WORKER_CATALOG
    value: worker-profiles
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  - name: POD_UID
    valueFrom:
      fieldRef:
        fieldPath: metadata.uid
```

Use `deploy/worker-profiles.py` to bootstrap the catalog and manage profiles.
Create a backup, then select the node, Worker image and sandbox template:

```sh
python3 deploy/worker-profiles.py backup /secure/path/profiles-backup
python3 deploy/worker-profiles.py bootstrap --template TEMPLATE --node NODE --worker-image IMAGE_DIGEST
```

The main catalog starts in `quiescing` mode. After enabling the panel and
verifying the new configuration, complete the cutover:

```sh
python3 deploy/worker-profiles.py cutover --url https://panel.example.com:8443 --backup /secure/path/profiles-backup
```

Cutover saves and verifies snapshots, replaces the fixed `agents` pool with
profile management and enables admission. It resumes sandboxes that were running
before the cutover. The Host's `fs.inotify.max_user_instances` must be at least 1024.

Test changes with a distinct candidate catalog and template selector. Keep test
Workers isolated from user sandboxes. Back up the catalog, templates and image
digests before updates. See [deployment](DEPLOYMENT.md) for storage and recovery.
