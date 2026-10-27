package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"strconv"
	"strings"
	"time"

	"github.com/agent-substrate/substrate/internal/hardware"
	"github.com/agent-substrate/substrate/internal/resources"
	ate "github.com/agent-substrate/substrate/pkg/api/v1alpha1"
	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	coordination "k8s.io/api/coordination/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"
)

// The non-expiring Lease fences allocations until its owning Pod has stopped.
func (m *workerManager) lockHost(ctx context.Context) (func(), error) {
	leases := m.kube.CoordinationV1().Leases(space)
	for {
		lease, err := leases.Get(ctx, "worker-profile-allocation", metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			lease, err = leases.Create(ctx, &coordination.Lease{ObjectMeta: metav1.ObjectMeta{Name: "worker-profile-allocation", Annotations: map[string]string{"pod": m.podName}}, Spec: coordination.LeaseSpec{HolderIdentity: &m.podUID}}, metav1.CreateOptions{})
			if apierrors.IsAlreadyExists(err) {
				continue
			}
		}
		if err != nil {
			return nil, err
		}
		holder := lease.Spec.HolderIdentity
		available := holder == nil || *holder == "" || *holder == m.podUID
		if !available {
			pod, e := m.kube.CoreV1().Pods(space).Get(ctx, lease.Annotations["pod"], metav1.GetOptions{})
			if e != nil && !apierrors.IsNotFound(e) {
				return nil, e
			}
			available = apierrors.IsNotFound(e) || string(pod.UID) != *holder || pod.Status.Phase == core.PodSucceeded || pod.Status.Phase == core.PodFailed
		}
		if available {
			lease.Spec.HolderIdentity = &m.podUID
			lease.Annotations = map[string]string{"pod": m.podName}
			lease, err = leases.Update(ctx, lease, metav1.UpdateOptions{})
			if apierrors.IsConflict(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			return func() {
				release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				lease.Spec.HolderIdentity = nil
				if _, e := leases.Update(release, lease, metav1.UpdateOptions{}); e != nil {
					log.Printf("Host allocation Lease release deferred: %v", e)
				}
			}, nil
		}
		select {
		case <-ctx.Done():
			return nil, status.FromContextError(ctx.Err()).Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (m *workerManager) workers(ctx context.Context) ([]*pb.Worker, error) {
	var result []*pb.Worker
	for token := ""; ; {
		page, err := m.api.ListWorkers(ctx, &pb.ListWorkersRequest{Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
		if err != nil {
			return nil, err
		}
		result = append(result, page.GetWorkers()...)
		token = page.GetNextPageToken()
		if token == "" {
			return result, nil
		}
	}
}
func poolWorkers(workers []*pb.Worker, name string) []*pb.Worker {
	var result []*pb.Worker
	for _, w := range workers {
		if w.GetWorkerNamespace() == space && w.GetWorkerPool() == name {
			result = append(result, w)
		}
	}
	return result
}
func (m *workerManager) empty(ctx context.Context, w *pb.Worker) (bool, error) {
	if w.GetStatus().GetAllocated().GetActors() != 0 {
		return false, nil
	}
	page, err := m.api.ListWorkerActorAssignments(ctx, &pb.ListWorkerActorAssignmentsRequest{Worker: &pb.ObjectRef{Name: w.GetMetadata().GetName()}, Options: &pb.ListOptions{PageSize: 1}})
	if err != nil {
		return false, err
	}
	return len(page.GetActorAssignments()) == 0 && page.GetNextPageToken() == "", nil
}

// Reserve the larger of requests and limits, including init containers and Pod overhead.
func podBudget(p core.Pod) (int64, int64) {
	var cpu, memory, sideCPU, sideMemory, initCPU, initMemory int64
	budget := func(r core.ResourceRequirements) (int64, int64) {
		return max(r.Requests.Cpu().MilliValue(), r.Limits.Cpu().MilliValue()), max(r.Requests.Memory().Value(), r.Limits.Memory().Value())
	}
	for _, c := range p.Spec.Containers {
		x, y := budget(c.Resources)
		cpu += x
		memory += y
	}
	for _, c := range p.Spec.InitContainers {
		x, y := budget(c.Resources)
		if c.RestartPolicy != nil && *c.RestartPolicy == core.ContainerRestartPolicyAlways {
			sideCPU += x
			sideMemory += y
			x, y = 0, 0
		}
		initCPU = max(initCPU, sideCPU+x)
		initMemory = max(initMemory, sideMemory+y)
	}
	cpu = max(cpu+sideCPU, initCPU)
	memory = max(memory+sideMemory, initMemory)
	if p.Spec.Resources != nil {
		x, y := budget(*p.Spec.Resources)
		cpu = max(cpu, x)
		memory = max(memory, y)
	}
	return cpu + p.Spec.Overhead.Cpu().MilliValue(), memory + p.Spec.Overhead.Memory().Value()
}
func (m *workerManager) budget(ctx context.Context, c *workerCatalog) (int, int64, int64, error) {
	node, err := m.kube.CoreV1().Nodes().Get(ctx, c.Node, metav1.GetOptions{})
	if err != nil {
		return 0, 0, 0, err
	}
	if node.Spec.Unschedulable {
		return 0, 0, 0, status.Error(codes.FailedPrecondition, "Host is unschedulable")
	}
	ready := false
	for _, condition := range node.Status.Conditions {
		if condition.Type == core.NodeReady && condition.Status == core.ConditionTrue {
			ready = true
		}
	}
	if !ready {
		return 0, 0, 0, status.Error(codes.FailedPrecondition, "Host is not Ready")
	}
	pools, err := m.pools.ApiV1alpha1().WorkerPools(space).List(ctx, metav1.ListOptions{})
	if err != nil {
		return 0, 0, 0, err
	}
	pods, err := m.kube.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return 0, 0, 0, err
	}
	cpu, memory := node.Status.Allocatable.Cpu().MilliValue(), node.Status.Allocatable.Memory().Value()
	present := map[string]int{}
	count := 0
	for _, pod := range pods.Items {
		if pod.Status.Phase == core.PodSucceeded || pod.Status.Phase == core.PodFailed {
			continue
		}
		if pod.Spec.NodeName != "" && pod.Spec.NodeName != c.Node {
			continue
		}
		x, y := podBudget(pod)
		cpu -= x
		memory -= y
		if pod.Namespace == space && pod.Labels["ate.dev/worker-pool"] != "" {
			present[pod.Labels["ate.dev/worker-pool"]]++
			count++
		}
	}
	known := map[string]bool{}
	for _, pool := range pools.Items {
		known[pool.Name] = true
		missing := max(0, int(pool.Spec.Replicas)-present[pool.Name])
		count += missing
		if missing > 0 {
			if pool.Spec.Template == nil || pool.Spec.Template.Resources == nil {
				return 0, 0, 0, status.Error(codes.FailedPrecondition, "WorkerPool resource budget is unknown")
			}
			r := pool.Spec.Template.Resources
			cpu -= int64(missing) * max(r.Requests.Cpu().MilliValue(), r.Limits.Cpu().MilliValue())
			memory -= int64(missing) * max(r.Requests.Memory().Value(), r.Limits.Memory().Value())
		}
	}
	catalogs, err := m.kube.CoreV1().ConfigMaps(space).List(ctx, metav1.ListOptions{LabelSelector: catalogLabel + "=true"})
	if err != nil {
		return 0, 0, 0, err
	}
	all := []*workerCatalog{c}
	for _, cm := range catalogs.Items {
		if cm.Name == m.configName {
			continue
		}
		var other workerCatalog
		if err = json.Unmarshal([]byte(cm.Data["catalog.json"]), &other); err != nil || other.Node == "" {
			return 0, 0, 0, status.Error(codes.FailedPrecondition, "Another Worker catalog is invalid")
		}
		if other.Node == c.Node {
			all = append(all, &other)
		}
	}
	for _, catalog := range all {
		for _, i := range catalog.Instances {
			if !known[i.Name] {
				rev := catalog.revision(i.ProfileID, i.Revision)
				if rev == nil {
					return 0, 0, 0, status.Error(codes.FailedPrecondition, "Unknown instance revision")
				}
				count++
				cpu -= rev.CPUMilli
				memory -= rev.MemoryMiB * (1 << 20)
			}
		}
	}
	return count, cpu, memory, nil
}
func (m *workerManager) realize(ctx context.Context, c *workerCatalog, i *managedInstance) error {
	pool, err := m.pools.ApiV1alpha1().WorkerPools(space).Get(ctx, i.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) && i.UID == "" && !i.Draining {
		pool, err = m.pools.ApiV1alpha1().WorkerPools(space).Create(ctx, poolFor(c, *i), metav1.CreateOptions{})
		// A lost response may still have created the pool. Its reserved name is reused.
		if err != nil {
			pool, err = m.pools.ApiV1alpha1().WorkerPools(space).Get(ctx, i.Name, metav1.GetOptions{})
		}
	}
	if err != nil {
		return err
	}
	if pool.Labels[managedLabel] != "true" || pool.Labels[profileLabel] != i.ProfileID || pool.Spec.Replicas != 1 || (i.UID != "" && i.UID != string(pool.UID)) {
		return status.Error(codes.FailedPrecondition, "Managed WorkerPool identity changed")
	}
	i.UID = string(pool.UID)
	return nil
}
func (m *workerManager) add(ctx context.Context, cm *core.ConfigMap, c *workerCatalog, id string, revision int) error {
	rev := c.revision(id, revision)
	p := c.profile(id)
	if rev == nil || p == nil {
		return status.Error(codes.FailedPrecondition, "Unknown profile revision")
	}
	count := 0
	for _, i := range c.Instances {
		if i.ProfileID == id {
			count++
		}
	}
	if count >= p.MaxWorkers {
		return status.Error(codes.ResourceExhausted, "Profile Worker limit reached; suspend an idle sandbox and retry")
	}
	unlock, err := m.lockHost(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	total, cpu, memory, err := m.budget(ctx, c)
	if err != nil {
		return err
	}
	if total >= hostWorkerLimit || cpu < rev.CPUMilli || memory < rev.MemoryMiB*(1<<20) {
		return status.Error(codes.ResourceExhausted, "Host Worker limit or CPU/memory allocation budget exhausted")
	}
	name, err := generatedSandboxName()
	if err != nil {
		return err
	}
	instance := managedInstance{Name: "wp-" + strings.TrimPrefix(name, "sandbox-"), ProfileID: id, Revision: revision}
	c.Instances = append(c.Instances, instance)
	if err = m.save(ctx, cm, c); err != nil {
		return err
	}
	// Persist the intent before creating a Pod; failed starts continue counting toward every limit.
	return m.realize(ctx, c, &instance)
}
func capacityState(workers []*pb.Worker, b profileBinding) map[string]string {
	state := map[string]string{}
	for _, worker := range workers {
		if worker.GetWorkerNamespace() == space && worker.GetLabels()[profileLabel] == b.ProfileID && worker.GetLabels()[revisionLabel] == strconv.Itoa(b.Revision) {
			status := worker.GetStatus()
			state[worker.GetMetadata().GetName()] = status.GetState().String() + status.GetCapacity().String() + status.GetAllocated().String()
		}
	}
	return state
}

func workerHasProfileRoom(worker *pb.Worker, actor *pb.Actor, revision *profileRevision) bool {
	var template pb.ActorTemplate
	if revision == nil || protojson.Unmarshal(revision.TemplateSpec, &template) != nil {
		return false
	}
	state := worker.GetStatus()
	if worker.GetSandboxClass() != template.GetSandboxConfig().GetSandboxClass() || state.GetAllocated().GetActors() >= state.GetCapacity().GetActors() {
		return false
	}
	if node := actor.GetStatus().GetAssignedNode(); node != "" && node != worker.GetNodeName() {
		return false
	}
	for _, selector := range []*pb.Selector{template.GetWorkerSelector(), actor.GetWorkerSelector()} {
		if !labels.SelectorFromSet(selector.GetMatchLabels()).Matches(labels.Set(worker.GetLabels())) {
			return false
		}
	}
	// Defer only for unambiguously compatible Workers; Substrate selects the snapshot.
	for _, snapshot := range actor.GetStatus().GetSnapshots() {
		if snapshot.GetFidelity() > pb.SnapshotFidelity_SNAPSHOT_FIDELITY_VOLUMES && !hardware.WorkerMatches(state, snapshot.GetSandboxRuntime()) {
			return false
		}
	}
	free, err := resources.ParseQuantities(state.GetCapacity().GetResources())
	if err != nil || free == nil {
		return false
	}
	used, err := resources.ParseQuantities(state.GetAllocated().GetResources())
	if err != nil {
		return false
	}
	want, err := resources.ParseQuantities(template.GetResources())
	if err != nil {
		return false
	}
	free.Sub(used)
	return free.Covers(want)
}

func (m *workerManager) ensureCapacity(ctx context.Context, b profileBinding, observed map[string]string, actor *pb.Actor) error {
	m.placement.RLock()
	defer m.placement.RUnlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	cm, c, err := m.read(ctx)
	if err != nil {
		return err
	}
	mode, err := m.mode(ctx, c)
	if err != nil {
		return err
	}
	if mode != "active" {
		return status.Error(codes.FailedPrecondition, "Host is quiescing")
	}
	workers, err := m.workers(ctx)
	if err != nil {
		return err
	}
	if observed != nil && !maps.Equal(observed, capacityState(workers, b)) {
		return nil
	}
	for n := range c.Instances {
		i := &c.Instances[n]
		if i.ProfileID != b.ProfileID || i.Revision != b.Revision {
			continue
		}
		if i.Draining {
			return nil
		}
		if err = m.realize(ctx, c, i); err != nil {
			return err
		}
		registered := poolWorkers(workers, i.Name)
		if len(registered) == 0 {
			return nil
		}
		for _, worker := range registered {
			if worker.GetStatus().GetState() != pb.WorkerState_WORKER_STATE_ACTIVE || worker.GetStatus().GetCapacity().GetActors() == 0 {
				return nil
			}
			if workerHasProfileRoom(worker, actor, c.revision(b.ProfileID, b.Revision)) {
				return nil
			}
		}
	}
	err = m.add(ctx, cm, c, b.ProfileID, b.Revision)
	if status.Code(err) != codes.ResourceExhausted {
		return err
	}
	for _, i := range c.Instances {
		if i.ProfileID != b.ProfileID {
			continue
		}
		if i.Draining {
			return nil
		}
		if i.Revision == b.Revision {
			continue
		}
		for _, worker := range poolWorkers(workers, i.Name) {
			empty, e := m.empty(ctx, worker)
			if e != nil {
				return e
			}
			if empty {
				return nil
			}
		}
	}
	return err
}
func (m *workerManager) resume(ctx context.Context, name string) (*pb.ResumeActorResponse, error) {
	_, c, err := m.read(ctx)
	if err != nil {
		return nil, err
	}
	mode, err := m.mode(ctx, c)
	if err != nil {
		return nil, err
	}
	if mode != "active" {
		return nil, status.Error(codes.FailedPrecondition, "Host is quiescing; Resume is blocked")
	}
	actor, err := m.api.GetActor(ctx, &pb.GetActorRequest{Actor: ref(name)})
	if err != nil {
		return nil, err
	}
	binding, ok := c.Bindings[actor.GetActorTemplate().GetName()]
	if !ok {
		return nil, status.Error(codes.FailedPrecondition, "Sandbox template is not mapped to a Worker profile")
	}
	m.mu.Lock()
	if m.wanted == nil {
		m.wanted = map[profileBinding]int{}
	}
	m.wanted[binding]++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.wanted[binding]--
		if m.wanted[binding] == 0 {
			delete(m.wanted, binding)
		}
		m.mu.Unlock()
	}()
	var observed map[string]string
	for {
		m.placement.RLock()
		if e := m.active(ctx); e != nil {
			m.placement.RUnlock()
			return nil, e
		}
		result, e := m.api.ResumeActor(ctx, &pb.ResumeActorRequest{Actor: ref(name)})
		if !workerCapacityError(e) {
			m.mu.Lock()
			assigned := result.GetActor().GetStatus().GetWorkerAssignment().GetWorker()
			if assigned.GetName() != "" {
				worker, readErr := m.api.GetWorker(ctx, &pb.GetWorkerRequest{Worker: assigned})
				if readErr == nil && worker.GetWorkerPool() != "" {
					delete(m.emptySince, worker.GetWorkerPool())
				} else {
					clear(m.emptySince)
				}
			} else {
				clear(m.emptySince)
			}
			m.mu.Unlock()
			m.placement.RUnlock()
			return result, e
		}
		m.placement.RUnlock()
		if observed == nil {
			workers, readErr := m.workers(ctx)
			if readErr != nil {
				return nil, readErr
			}
			observed = capacityState(workers, binding)
			continue
		}
		actor, err = m.api.GetActor(ctx, &pb.GetActorRequest{Actor: ref(name)})
		if err != nil {
			return nil, err
		}
		if err = m.ensureCapacity(ctx, binding, observed, actor); err != nil && status.Code(err) != codes.Aborted {
			return nil, err
		}
		observed = nil
		select {
		case <-ctx.Done():
			return nil, status.FromContextError(ctx.Err()).Err()
		case <-time.After(time.Second):
		}
	}
}
func (m *workerManager) reconcile(ctx context.Context, now time.Time) error {
	// Reconciliation never waits on ordinary restores; two Resume calls remain independent.
	if !m.placement.TryLock() {
		return nil
	}
	defer m.placement.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	// Retry an uncertain release even when this catalog no longer needs capacity.
	lease, err := m.kube.CoordinationV1().Leases(space).Get(ctx, "worker-profile-allocation", metav1.GetOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err == nil && lease.Spec.HolderIdentity != nil && *lease.Spec.HolderIdentity == m.podUID {
		lease.Spec.HolderIdentity = nil
		if _, err = m.kube.CoordinationV1().Leases(space).Update(ctx, lease, metav1.UpdateOptions{}); err != nil {
			return err
		}
	}
	cm, c, err := m.read(ctx)
	if err != nil {
		return err
	}
	mode, err := m.mode(ctx, c)
	if err != nil || mode != "active" {
		clear(m.emptySince)
		return err
	}
	workers, err := m.workers(ctx)
	if err != nil {
		clear(m.emptySince)
		return err
	}
	for n := range c.Instances {
		i := &c.Instances[n]
		if i.Draining {
			removed, e := m.retire(ctx, c, *i, workers)
			if e != nil {
				return e
			}
			if removed {
				c.Instances = append(c.Instances[:n], c.Instances[n+1:]...)
				return m.save(ctx, cm, c)
			}
			continue
		}
		if err = m.realize(ctx, c, i); err != nil {
			delete(m.emptySince, i.Name)
			return err
		}
		owned := poolWorkers(workers, i.Name)
		empty := len(owned) == 1
		for _, worker := range owned {
			if worker.GetStatus().GetState() != pb.WorkerState_WORKER_STATE_ACTIVE {
				empty = false
				break
			}
			ok, e := m.empty(ctx, worker)
			if e != nil {
				delete(m.emptySince, i.Name)
				return e
			}
			empty = empty && ok
		}
		if !empty {
			delete(m.emptySince, i.Name)
			continue
		}
		if m.emptySince[i.Name].IsZero() {
			m.emptySince[i.Name] = now
			continue
		}
		p := c.profile(i.ProfileID)
		count := 0
		for _, other := range c.Instances {
			if other.ProfileID == i.ProfileID && !other.Draining && other.Revision == m.desiredRevision(p) {
				count++
			}
		}
		if now.Sub(m.emptySince[i.Name]) < workerIdleDelay || (i.Revision == m.desiredRevision(p) && count <= p.MinWorkers) {
			continue
		}
		i.Draining = true
		if err = m.save(ctx, cm, c); err != nil {
			return err
		}
		_, err = m.retire(ctx, c, *i, workers)
		return err
	}
	var blocked error
	for _, p := range c.Profiles {
		if p.Deleted {
			continue
		}
		count := 0
		for _, i := range c.Instances {
			if i.ProfileID == p.ID && !i.Draining && i.Revision == m.desiredRevision(&p) {
				count++
			}
		}
		if count < p.MinWorkers {
			err := m.add(ctx, cm, c, p.ID, m.desiredRevision(&p))
			if status.Code(err) == codes.ResourceExhausted {
				if blocked == nil {
					blocked = err
				}
				continue
			}
			if err != nil {
				return err
			}
			return blocked
		}
	}
	return blocked
}
func (m *workerManager) retire(ctx context.Context, c *workerCatalog, i managedInstance, workers []*pb.Worker) (bool, error) {
	pool, err := m.pools.ApiV1alpha1().WorkerPools(space).Get(ctx, i.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		pods, e := m.kube.CoreV1().Pods(space).List(ctx, metav1.ListOptions{LabelSelector: "ate.dev/worker-pool=" + i.Name})
		if e != nil {
			return false, e
		}
		return len(pods.Items) == 0 && len(poolWorkers(workers, i.Name)) == 0, nil
	}
	if err != nil {
		return false, err
	}
	if string(pool.UID) != i.UID || i.UID == "" {
		return false, status.Error(codes.FailedPrecondition, "Refusing to remove a WorkerPool with a different UID")
	}
	owned := poolWorkers(workers, i.Name)
	if len(owned) == 0 {
		return false, nil
	}
	for _, worker := range owned {
		ok, e := m.empty(ctx, worker)
		if e != nil || !ok {
			return false, e
		}
		ref := &pb.ObjectRef{Name: worker.GetMetadata().GetName()}
		if _, e = m.api.DrainWorker(ctx, &pb.DrainWorkerRequest{Worker: ref}); e != nil {
			return false, e
		}
		current, e := m.api.GetWorker(ctx, &pb.GetWorkerRequest{Worker: ref})
		if e != nil {
			return false, e
		}
		ok, e = m.empty(ctx, current)
		if e != nil || !ok {
			return false, e
		}
	}
	uid := types.UID(i.UID)
	policy := metav1.DeletePropagationForeground
	err = m.pools.ApiV1alpha1().WorkerPools(space).Delete(ctx, i.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}, PropagationPolicy: &policy})
	return false, err
}
func (m *workerManager) run(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			call, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := m.reconcile(call, now)
			cancel()
			if err != nil {
				log.Printf("Worker reconciliation deferred: %v", err)
			}
		}
	}
}
func (m *workerManager) workerView(ctx context.Context) (any, error) {
	_, c, err := m.read(ctx)
	if err != nil {
		return nil, err
	}
	workers, err := m.workers(ctx)
	if err != nil {
		return nil, err
	}
	pools, err := m.pools.ApiV1alpha1().WorkerPools(space).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	byName := map[string]ate.WorkerPool{}
	for _, pool := range pools.Items {
		byName[pool.Name] = pool
	}
	result := []map[string]any{}
	for _, i := range c.Instances {
		rev := c.revision(i.ProfileID, i.Revision)
		if rev == nil {
			return nil, fmt.Errorf("Unknown Worker revision")
		}
		state := "Starting"
		occupied := int32(0)
		for _, worker := range poolWorkers(workers, i.Name) {
			state = strings.TrimPrefix(worker.GetStatus().GetState().String(), "WORKER_STATE_")
			occupied += worker.GetStatus().GetAllocated().GetActors()
		}
		pool := byName[i.Name]
		if pool.DeletionTimestamp != nil || i.Draining {
			state = "Draining"
		}
		result = append(result, map[string]any{"name": i.Name, "profile_id": i.ProfileID, "profile_name": c.profile(i.ProfileID).Name, "revision": i.Revision, "state": state, "occupied": occupied, "available": max(0, rev.Slots-occupied), "slots": rev.Slots, "cpu_milli": rev.CPUMilli, "memory_mib": rev.MemoryMiB})
	}
	mode, err := m.mode(ctx, c)
	if err != nil {
		return nil, err
	}
	return map[string]any{"workers": result, "mode": mode, "host_worker_limit": hostWorkerLimit}, nil
}

func (m *workerManager) retireLegacy(ctx context.Context, uid string) error {
	pool, err := m.pools.ApiV1alpha1().WorkerPools(space).Get(ctx, "agents", metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if string(pool.UID) != uid {
		return status.Error(codes.Aborted, "Legacy pool UID changed")
	}
	workers, err := m.workers(ctx)
	if err != nil {
		return err
	}
	owned := poolWorkers(workers, "agents")
	if len(owned) != int(pool.Spec.Replicas) || len(owned) == 0 {
		return status.Error(codes.FailedPrecondition, "Legacy Worker inventory is incomplete; retaining the pool")
	}
	for _, worker := range owned {
		state := worker.GetStatus().GetState()
		if state != pb.WorkerState_WORKER_STATE_ACTIVE && state != pb.WorkerState_WORKER_STATE_DRAINING {
			return status.Error(codes.FailedPrecondition, "Legacy Worker state is unknown; retaining the pool")
		}
		empty, e := m.empty(ctx, worker)
		if e != nil {
			return e
		}
		if !empty {
			return status.Error(codes.FailedPrecondition, "Legacy Worker still has assignments")
		}
	}
	for _, worker := range owned {
		ref := &pb.ObjectRef{Name: worker.GetMetadata().GetName()}
		if _, err = m.api.DrainWorker(ctx, &pb.DrainWorkerRequest{Worker: ref}); err != nil {
			return err
		}
		current, e := m.api.GetWorker(ctx, &pb.GetWorkerRequest{Worker: ref})
		if e != nil {
			return e
		}
		empty, e := m.empty(ctx, current)
		if e != nil {
			return e
		}
		if !empty {
			return status.Error(codes.FailedPrecondition, "An assignment appeared during Drain; retaining the pool")
		}
	}
	id := types.UID(uid)
	policy := metav1.DeletePropagationForeground
	return m.pools.ApiV1alpha1().WorkerPools(space).Delete(ctx, "agents", metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &id}, PropagationPolicy: &policy})
}

// Pending restores may need an older immutable version even when the minimum is full.
func (m *workerManager) desiredRevision(p *workerProfile) int {
	revision := p.Revisions[len(p.Revisions)-1].Revision
	for binding, count := range m.wanted {
		if binding.ProfileID == p.ID && count > 0 {
			revision = min(revision, binding.Revision)
		}
	}
	return revision
}
