package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"google.golang.org/protobuf/encoding/protojson"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ate "github.com/agent-substrate/substrate/pkg/api/v1alpha1"
	atefake "github.com/agent-substrate/substrate/pkg/client/clientset/versioned/fake"
	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	coordination "k8s.io/api/coordination/v1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	kubefake "k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

type profilesAPI struct {
	pb.ControlClient
	workersList []*pb.Worker
	actors      []*pb.Actor
	assigned    bool
	unknown     bool
	drained     int
	resumeStart chan string
	resumeEnd   chan struct{}
	resumed     *pb.Actor
	actorState  pb.ActorState
}

func (a *profilesAPI) ListWorkers(context.Context, *pb.ListWorkersRequest, ...grpc.CallOption) (*pb.ListWorkersResponse, error) {
	if a.unknown {
		return nil, fmt.Errorf("unavailable")
	}
	return &pb.ListWorkersResponse{Workers: a.workersList}, nil
}
func (a *profilesAPI) ListActors(context.Context, *pb.ListActorsRequest, ...grpc.CallOption) (*pb.ListActorsResponse, error) {
	return &pb.ListActorsResponse{Actors: a.actors}, nil
}
func (a *profilesAPI) ListWorkerActorAssignments(context.Context, *pb.ListWorkerActorAssignmentsRequest, ...grpc.CallOption) (*pb.ListWorkerActorAssignmentsResponse, error) {
	r := &pb.ListWorkerActorAssignmentsResponse{}
	if a.assigned {
		r.ActorAssignments = []*pb.ActorAssignment{{}}
	}
	return r, nil
}
func (a *profilesAPI) DrainWorker(context.Context, *pb.DrainWorkerRequest, ...grpc.CallOption) (*pb.DrainWorkerResponse, error) {
	a.drained++
	a.workersList[0].Status.State = pb.WorkerState_WORKER_STATE_DRAINING
	return &pb.DrainWorkerResponse{}, nil
}
func (a *profilesAPI) GetWorker(context.Context, *pb.GetWorkerRequest, ...grpc.CallOption) (*pb.Worker, error) {
	return a.workersList[0], nil
}
func (a *profilesAPI) GetActor(_ context.Context, r *pb.GetActorRequest, _ ...grpc.CallOption) (*pb.Actor, error) {
	return &pb.Actor{Metadata: &pb.ResourceMetadata{Name: r.Actor.Name}, ActorTemplate: ref("legacy"), Status: &pb.ActorStatus{State: a.actorState}}, nil
}
func (a *profilesAPI) ResumeActor(_ context.Context, r *pb.ResumeActorRequest, _ ...grpc.CallOption) (*pb.ResumeActorResponse, error) {
	a.resumeStart <- r.Actor.Name
	<-a.resumeEnd
	return &pb.ResumeActorResponse{Actor: a.resumed}, nil
}
func profileFixture(t *testing.T) (*workerManager, *profilesAPI) {
	t.Helper()
	c := workerCatalog{Mode: "active", DefaultID: "standard", Node: "host", WorkerImage: "worker@sha256:fixture", BaseTemplate: json.RawMessage(`{"metadata":{"atespace":"pvm-agents","name":"base"},"sandboxConfig":{"configName":"gvisor-default","sandboxClass":"gvisor"},"containers":[{"name":"app","image":"runtime@sha256:fixture"}]}`), Bindings: map[string]profileBinding{"legacy": {ProfileID: "standard", Revision: 1}}}
	rev, e := makeRevision(&c, "standard", 1, profileSize{8000, 8256, 4})
	if e != nil {
		t.Fatal(e)
	}
	c.Profiles = []workerProfile{{ID: "standard", Name: "Standard", Version: 1, MaxWorkers: 8, Enabled: true, Revisions: []profileRevision{rev}}}
	c.Bindings[rev.Template] = profileBinding{ProfileID: "standard", Revision: 1}
	raw, _ := json.Marshal(c)
	kube := kubefake.NewClientset(&core.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "worker-profiles", Namespace: space, ResourceVersion: "1"}, Data: map[string]string{"catalog.json": string(raw)}}, &core.Node{ObjectMeta: metav1.ObjectMeta{Name: "host"}, Status: core.NodeStatus{Allocatable: core.ResourceList{core.ResourceCPU: resource.MustParse("100"), core.ResourceMemory: resource.MustParse("100Gi")}, Conditions: []core.NodeCondition{{Type: core.NodeReady, Status: core.ConditionTrue}}}})
	api := &profilesAPI{}
	pools := atefake.NewSimpleClientset()
	pools.PrependReactor("create", "workerpools", func(action ktesting.Action) (bool, runtime.Object, error) {
		obj := action.(ktesting.CreateAction).GetObject().(*ate.WorkerPool)
		obj.UID = types.UID(obj.Name + "-uid")
		return false, nil, nil
	})
	return &workerManager{kube: kube, pools: pools, api: api, configName: "worker-profiles", emptySince: map[string]time.Time{}}, api
}
func TestProfileDivision(t *testing.T) {
	for _, test := range []struct {
		size        profileSize
		cpu, memory int64
	}{{profileSize{8000, 8256, 4}, 2000, 2048}, {profileSize{12600, 17000, 3}, 4200, 5645}} {
		if err := test.size.validate(); err != nil {
			t.Fatal(err)
		}
		cpu, memory := test.size.sandbox()
		if cpu != test.cpu || memory != test.memory {
			t.Fatal(cpu, memory)
		}
	}
	for _, size := range []profileSize{{0, 8256, 4}, {8250, 64, 4}, {251, 65, 4}, {8250, 8256, 0}, {-1, 1, 1}} {
		if size.validate() == nil {
			t.Fatal("accepted invalid resources", size)
		}
	}
}
func TestProfileEditsPreserveVersionsAndRejectConflicts(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	input := profileInput{profileSize: profileSize{4000, 4609, 2}, Name: "Changed", Version: 1, MaxWorkers: 8, Enabled: true}
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal(err)
	}
	if err := m.editProfile(ctx, "PUT", "standard", input); status.Code(err) != codes.Aborted {
		t.Fatal("stale version accepted", err)
	}
	_, c, err := m.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Profiles[0].Revisions) != 2 || c.Profiles[0].Revisions[0].CPUMilli != 8000 || c.Bindings["legacy"].Revision != 1 {
		t.Fatal("existing version mutated")
	}
	c.DefaultID = "other"
	cm, _, _ := m.read(ctx)
	if err = m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	api.actors = []*pb.Actor{{ActorTemplate: ref("legacy"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_SUSPENDED}}}
	if err = m.editProfile(ctx, "DELETE", "standard", profileInput{Version: 2}); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("used profile deleted", err)
	}
}

func TestLegacyReserveSurvivesMetadataEditsAndNewRevision(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	cm, c, _ := m.read(ctx)
	legacy := &c.Profiles[0].Revisions[0]
	legacy.MemoryMiB = 8704
	legacy.ReservedMemoryMiB = 0
	before, _ := json.Marshal(legacy)
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	input := profileInput{profileSize: legacy.profileSize, Name: "Renamed", Version: 1, MaxWorkers: 8, Enabled: true}
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Profiles[0].Revisions) != 1 {
		t.Fatal("metadata edit created a resource version")
	}
	w := httptest.NewRecorder()
	(&server{workerManager: m}).workerRoutes(w, httptest.NewRequest("GET", "/api/worker-profiles", nil))
	var view struct {
		Profiles []map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil || len(view.Profiles) != 1 || view.Profiles[0]["reserved_memory_mib"] != float64(512) || view.Profiles[0]["sandbox_memory_mib"] != float64(2048) {
		t.Fatal("legacy API limits changed", w.Body.String(), err)
	}
	input.Version = 2
	input.ReservedMemoryMiB = 32
	if err := m.editProfile(ctx, "PUT", "standard", input); status.Code(err) != codes.InvalidArgument {
		t.Fatal("accepted an unsupported reserve", err)
	}
	input.ReservedMemoryMiB = 64
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if _, memory := c.revision("standard", 2).sandbox(); memory != 2160 {
		t.Fatal("reserve change with identical total budget was lost", memory)
	}
	input.Version = 3
	input.MemoryMiB = 8256
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	after, _ := json.Marshal(c.revision("standard", 1))
	if string(before) != string(after) || c.Bindings["legacy"].Revision != 1 {
		t.Fatal("legacy limits, images or binding changed")
	}
	for _, test := range []struct {
		revision        int
		memory, reserve int64
	}{{1, 8704, 512}, {3, 8256, 64}} {
		rev := c.revision("standard", test.revision)
		cpu, memory := rev.sandbox()
		pool := poolFor(c, managedInstance{Name: "test", ProfileID: "standard", Revision: test.revision})
		if cpu != 2000 || memory != 2048 || pool.Spec.Template.Resources.Limits.Memory().Value() != test.memory<<20 || pool.Spec.ReservedResources.Memory().Value() != test.reserve<<20 {
			t.Fatal("wrong revision budget", test.revision, cpu, memory, pool.Spec)
		}
	}
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal(err)
	}
	pools, _ := m.pools.ApiV1alpha1().WorkerPools(space).List(ctx, metav1.ListOptions{})
	if len(pools.Items) != 1 || pools.Items[0].Spec.ReservedResources.Memory().Value() != 512<<20 {
		t.Fatal("Resume must retain the original Worker reserve", pools)
	}
}
func TestCPUReserveChangePreservesOldVersionsAndExplicitZero(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	cm, c, _ := m.read(ctx)
	legacy := &c.Profiles[0].Revisions[0]
	legacy.CPUMilli = 8250
	legacy.ReservedCPUMilli = nil
	before, _ := json.Marshal(legacy)
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	input := profileInput{profileSize: legacy.profileSize, Name: "Renamed", Version: 1, MaxWorkers: 8, Enabled: true}
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Profiles[0].Revisions) != 1 || c.revision("standard", 1).cpuReserve() != 250 {
		t.Fatal("metadata edit changed the legacy CPU reserve")
	}
	input.Version = 2
	reserve := int64(100)
	input.ReservedCPUMilli = &reserve
	if err := m.editProfile(ctx, "PUT", "standard", input); status.Code(err) != codes.InvalidArgument {
		t.Fatal("accepted an unsupported CPU reserve", err)
	}
	reserve = 0
	if err := m.editProfile(ctx, "PUT", "standard", input); status.Code(err) != codes.InvalidArgument {
		t.Fatal("accepted a reserve change that makes fractional sandbox CPUs", err)
	}
	input.CPUMilli = 8000
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if cpu, _ := c.revision("standard", 2).sandbox(); cpu != 2000 || c.revision("standard", 2).cpuReserve() != 0 {
		t.Fatal("explicit zero was lost", cpu)
	}
	_, c, _ = m.read(ctx)
	after, _ := json.Marshal(c.revision("standard", 1))
	if string(before) != string(after) || c.Bindings["legacy"].Revision != 1 {
		t.Fatal("legacy resource version or binding changed")
	}
	for _, test := range []struct {
		revision       int
		total, reserve int64
	}{{1, 8250, 250}, {2, 8000, 0}} {
		cpu, _ := c.revision("standard", test.revision).sandbox()
		pool := poolFor(c, managedInstance{Name: "test", ProfileID: "standard", Revision: test.revision})
		if cpu != 2000 || pool.Spec.Template.Resources.Limits.Cpu().MilliValue() != test.total || pool.Spec.ReservedResources.Cpu().MilliValue() != test.reserve {
			t.Fatal("wrong CPU budget for resource version", test.revision, pool.Spec)
		}
	}
	w := httptest.NewRecorder()
	(&server{workerManager: m}).workerRoutes(w, httptest.NewRequest("GET", "/api/worker-profiles", nil))
	var view struct {
		Profiles []map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil || len(view.Profiles) != 1 || view.Profiles[0]["reserved_cpu_milli"] != float64(0) || view.Profiles[0]["sandbox_cpu_milli"] != float64(2000) {
		t.Fatal("API must report the new CPU reserve", w.Body.String(), err)
	}
}

func TestNewProfilesRequireWholeSandboxCPU(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	for _, size := range []profileSize{{1500, 8256, 1}, {3000, 8256, 2}, {8001, 8256, 4}} {
		input := profileInput{profileSize: size, Name: "Fractional", MaxWorkers: 8, Enabled: true}
		if err := m.editProfile(ctx, "POST", "", input); status.Code(err) != codes.InvalidArgument {
			t.Fatal("accepted fractional CPU", size, err)
		}
	}
	cm, c, _ := m.read(ctx)
	legacy, err := makeRevision(c, "standard", 1, profileSize{6000, 8256, 4})
	if err != nil {
		t.Fatal(err)
	}
	c.Profiles[0].Revisions[0] = legacy
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	input := profileInput{profileSize: legacy.profileSize, Name: "Renamed", Version: 1, MaxWorkers: 8, Enabled: true}
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal("metadata edit changed existing fractional limits", err)
	}
	input.Version = 2
	input.MemoryMiB++
	if err := m.editProfile(ctx, "PUT", "standard", input); status.Code(err) != codes.InvalidArgument {
		t.Fatal("new resource version retained fractional CPU", err)
	}
	input.CPUMilli = 8000
	if err := m.editProfile(ctx, "PUT", "standard", input); err != nil {
		t.Fatal("whole CPU rejected", err)
	}
}

func TestConcurrentCapacityReservesOneStartingWorker(t *testing.T) {
	m, _ := profileFixture(t)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := m.ensureCapacity(context.Background(), profileBinding{"standard", 1}, nil, nil); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	_, c, err := m.read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	pools, _ := m.pools.ApiV1alpha1().WorkerPools(space).List(context.Background(), metav1.ListOptions{})
	if len(c.Instances) != 1 || len(pools.Items) != 1 {
		t.Fatal("duplicate starting Workers", len(c.Instances), len(pools.Items))
	}
	p := pools.Items[0]
	if p.Spec.Replicas != 1 || *p.Spec.MaxActors != 4 || p.Spec.Template.Resources.Requests.Cpu().MilliValue() != 8000 || p.Spec.ReservedResources.Memory().Value() != 64<<20 {
		t.Fatal("wrong pool", p.Spec)
	}
}
func TestRegisteredFreeWorkerDoesNotCauseDuplicateScaleUp(t *testing.T) {
	for _, scenario := range []string{"cold", "memory", "restorable", "full", "insufficient-cpu", "incompatible-memory", "selector", "empty-selector", "present-empty-selector"} {
		t.Run(scenario, func(t *testing.T) {
			m, api := profileFixture(t)
			ctx := context.Background()
			binding := profileBinding{"standard", 1}
			if err := m.ensureCapacity(ctx, binding, nil, nil); err != nil {
				t.Fatal(err)
			}
			_, c, _ := m.read(ctx)
			runtime := &pb.SandboxRuntime{SandboxClass: "gvisor", Version: &pb.VersionedSandboxCompat{SchemaVersion: "v1"}}
			worker := &pb.Worker{Metadata: &pb.ResourceMetadata{Name: "ready"}, WorkerNamespace: space, WorkerPool: c.Instances[0].Name, SandboxClass: "gvisor", Labels: map[string]string{managedLabel: "true", profileLabel: "standard", revisionLabel: "1"}, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, DefaultRuntime: runtime, Capacity: &pb.WorkerResources{Actors: 4, Resources: &pb.Resources{Limits: []*pb.Limits{{Name: "cpu", Quantity: "8"}, {Name: "memory", Quantity: "8Gi"}}}}}}
			actor := &pb.Actor{Status: &pb.ActorStatus{}}
			wantPools := 1
			switch scenario {
			case "memory", "restorable", "incompatible-memory":
				actor.Status.Snapshots = []*pb.Snapshot{{Fidelity: pb.SnapshotFidelity_SNAPSHOT_FIDELITY_MEMORY, SandboxRuntime: runtime}}
				if scenario != "memory" {
					worker.Status.DefaultRuntime = &pb.SandboxRuntime{SandboxClass: "gvisor", Version: &pb.VersionedSandboxCompat{SchemaVersion: "v2"}}
					if scenario == "restorable" {
						worker.Status.RestorableRuntimes = []*pb.SandboxRuntime{runtime}
					} else {
						wantPools = 2
					}
				}
			case "full":
				worker.Status.Allocated = &pb.WorkerResources{Actors: 4}
				wantPools = 2
			case "insufficient-cpu":
				worker.Status.Allocated = &pb.WorkerResources{Actors: 1, Resources: &pb.Resources{Limits: []*pb.Limits{{Name: "cpu", Quantity: "7"}}}}
				wantPools = 2
			case "selector", "empty-selector", "present-empty-selector":
				value := ""
				if scenario == "selector" {
					value = "required"
				}
				actor.WorkerSelector = &pb.Selector{MatchLabels: map[string]string{"extra": value}}
				if scenario == "present-empty-selector" {
					worker.Labels["extra"] = ""
				} else {
					wantPools = 2
				}
			}
			api.workersList = []*pb.Worker{worker}
			observed := capacityState(api.workersList, binding)
			var wg sync.WaitGroup
			for range 12 {
				wg.Go(func() {
					if err := m.ensureCapacity(ctx, binding, observed, actor); err != nil {
						t.Error(err)
					}
				})
			}
			wg.Wait()
			_, c, _ = m.read(ctx)
			if len(c.Instances) != wantPools {
				t.Fatal("unexpected scale-up after an unchanged scheduler capacity failure", c.Instances)
			}
		})
	}
}

func TestHostBudgetIncludesPendingWorkersAndOtherPods(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	cm, c, _ := m.read(ctx)
	for n := range 8 {
		c.Instances = append(c.Instances, managedInstance{Name: fmt.Sprint("wp-", n), ProfileID: "standard", Revision: 1})
	}
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	count, _, _, err := m.budget(ctx, c)
	if err != nil || count != 8 {
		t.Fatal(count, err)
	}
	cm, c, _ = m.read(ctx)
	if err = m.add(ctx, cm, c, "standard", 1); status.Code(err) != codes.ResourceExhausted {
		t.Fatal("limit exceeded", err)
	}
	c.Instances = nil
	_, err = m.kube.CoreV1().Pods("system").Create(ctx, &core.Pod{ObjectMeta: metav1.ObjectMeta{Name: "busy"}, Spec: core.PodSpec{NodeName: "host", Containers: []core.Container{{Name: "busy", Resources: core.ResourceRequirements{Limits: core.ResourceList{core.ResourceCPU: resource.MustParse("99")}}}}}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err = m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	cm, c, _ = m.read(ctx)
	if err = m.add(ctx, cm, c, "standard", 1); status.Code(err) != codes.ResourceExhausted {
		t.Fatal("Host overcommitted", err)
	}
}
func TestScaleDownRequiresContinuousKnownEmptyState(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal(err)
	}
	_, c, _ := m.read(ctx)
	i := c.Instances[0]
	api.workersList = []*pb.Worker{{Metadata: &pb.ResourceMetadata{Name: "worker"}, WorkerNamespace: space, WorkerPool: i.Name, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, Capacity: &pb.WorkerResources{Actors: 4}}}}
	now := time.Now()
	if err := m.reconcile(ctx, now); err != nil {
		t.Fatal(err)
	}
	api.unknown = true
	if m.reconcile(ctx, now.Add(4*time.Minute)) == nil {
		t.Fatal("unknown state accepted")
	}
	api.unknown = false
	if err := m.reconcile(ctx, now.Add(6*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if api.drained != 0 {
		t.Fatal("unknown interval counted as empty")
	}
	api.assigned = true
	if err := m.reconcile(ctx, now.Add(12*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if api.drained != 0 {
		t.Fatal("assignment was ignored")
	}
	api.assigned = false
	if err := m.reconcile(ctx, now.Add(13*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcile(ctx, now.Add(18*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if api.drained != 1 {
		t.Fatal("idle worker not drained")
	}
	pools, _ := m.pools.ApiV1alpha1().WorkerPools(space).List(ctx, metav1.ListOptions{})
	if len(pools.Items) != 0 {
		t.Fatal("empty pool retained")
	}
}
func TestTwoResumesRemainParallelAndExcludeRetirement(t *testing.T) {
	m, api := profileFixture(t)
	api.resumeStart = make(chan string, 2)
	api.resumeEnd = make(chan struct{})
	var wg sync.WaitGroup
	for _, name := range []string{"one", "two"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.resume(context.Background(), name); err != nil {
				t.Error(err)
			}
		}()
	}
	for range 2 {
		select {
		case <-api.resumeStart:
		case <-time.After(3 * time.Second):
			t.Fatal("restores serialized")
		}
	}
	if m.placement.TryLock() {
		m.placement.Unlock()
		t.Fatal("retirement was allowed during Resume")
	}
	close(api.resumeEnd)
	wg.Wait()
	cm, c, _ := m.read(context.Background())
	c.Mode = "quiescing"
	if err := m.save(context.Background(), cm, c); err != nil {
		t.Fatal(err)
	}
	if _, err := m.resume(context.Background(), "one"); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("Resume admitted while quiescing", err)
	}
	if err := m.ensureCapacity(context.Background(), profileBinding{"standard", 1}, nil, nil); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("autoscale during quiescing", err)
	}
}

func TestManagerOwnershipWaitsForPreviousPod(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	m.podName = "old-panel"
	m.podUID = "old-uid"
	if err := m.claim(ctx); err != nil {
		t.Fatal(err)
	}
	_, err := m.kube.CoreV1().Pods(space).Create(ctx, &core.Pod{ObjectMeta: metav1.ObjectMeta{Name: m.podName, UID: types.UID(m.podUID)}, Status: core.PodStatus{Phase: core.PodRunning}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	m.podName = "new-panel"
	m.podUID = "new-uid"
	if err = m.claim(ctx); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("active manager replaced", err)
	}
	if _, _, err = m.read(ctx); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("foreign manager admitted", err)
	}
	if err = m.kube.CoreV1().Pods(space).Delete(ctx, "old-panel", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = m.claim(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.read(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerRoutesKeepAuthorizationAndLegacyCreation(t *testing.T) {
	m, _ := profileFixture(t)
	s := &server{workerManager: m, password: sha256.Sum256([]byte("test-password")), origin: "https://panel.test"}
	for _, tc := range []struct {
		path, origin, password, body string
		want                         int
	}{
		{"/api/worker-profiles", "", "", "{}", 401},
		{"/api/worker-profiles", "https://evil.test", "test-password", "{}", 403},
		{"/api/worker-profiles", s.origin, "test-password", `{"image":"arbitrary"}`, 400},
	} {
		req := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		req.SetBasicAuth("admin", tc.password)
		req.Header.Set("Origin", tc.origin)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
	s.workerManager = nil
	req := httptest.NewRequest("GET", "/api/worker-profiles", nil)
	req.SetBasicAuth("admin", "test-password")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"enabled":false`) {
		t.Fatal("legacy profile discovery blocked", rec.Body.String())
	}
}
func TestObsoleteIdleWorkerDoesNotHoldMinimum(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal(err)
	}
	_, c, _ := m.read(ctx)
	i := c.Instances[0]
	api.workersList = []*pb.Worker{{Metadata: &pb.ResourceMetadata{Name: "worker"}, WorkerNamespace: space, WorkerPool: i.Name, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, Capacity: &pb.WorkerResources{Actors: 4}}}}
	in := profileInput{profileSize: profileSize{4000, 4608, 2}, Name: "Standard", Version: 1, MinWorkers: 1, MaxWorkers: 1, Enabled: true}
	if err := m.editProfile(ctx, "PUT", "standard", in); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	// The old Worker occupies the maximum while its empty observation is collected.
	_ = m.reconcile(ctx, now)
	if err := m.reconcile(ctx, now.Add(workerIdleDelay)); err != nil {
		t.Fatal(err)
	}
	if api.drained != 1 {
		t.Fatal("obsolete version retained at minimum")
	}
	api.workersList = nil
	if err := m.reconcile(ctx, now.Add(workerIdleDelay+time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcile(ctx, now.Add(workerIdleDelay+2*time.Second)); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Instances) != 1 || c.Instances[0].Revision != 2 {
		t.Fatal("new minimum not restored", c.Instances)
	}
}

func TestProfileConsoleUsesOnlyItsCatalogBindings(t *testing.T) {
	m, _ := profileFixture(t)
	s := &server{workerManager: m}
	ctx := context.Background()
	kind, err := s.actorKinds(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := kind(&pb.Actor{ActorTemplate: ref("profile-production-v1")}); got != "" {
		t.Fatal("foreign catalog admitted", got)
	}
	if got := kind(&pb.Actor{ActorTemplate: ref("legacy")}); got != "sandbox" {
		t.Fatal("own binding excluded", got)
	}
	previous := templatePrefix
	templatePrefix = "candidate-"
	defer func() { templatePrefix = previous }()
	if got := consoleKind(&pb.Actor{ActorTemplate: ref("profile-production-v1")}); got != "" {
		t.Fatal("candidate prefix bypassed", got)
	}
}

func TestLegacyRetirementRequiresCompleteInventory(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	_, c, _ := m.read(ctx)
	pool := poolFor(c, managedInstance{Name: "agents", ProfileID: "standard", Revision: 1})
	pool.Spec.Replicas = 4
	created, err := m.pools.ApiV1alpha1().WorkerPools(space).Create(ctx, pool, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	api.workersList = []*pb.Worker{{Metadata: &pb.ResourceMetadata{Name: "worker"}, WorkerNamespace: space, WorkerPool: "agents", Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE}}}
	if err = m.retireLegacy(ctx, string(created.UID)); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("incomplete inventory accepted", err)
	}
	if api.drained != 0 {
		t.Fatal("incomplete inventory drained")
	}
	if _, err = m.pools.ApiV1alpha1().WorkerPools(space).Get(ctx, "agents", metav1.GetOptions{}); err != nil {
		t.Fatal("pool deleted", err)
	}
}

func TestPendingOldResumeCanReplaceNewMinimum(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	in := profileInput{profileSize: profileSize{4000, 4608, 2}, Name: "Standard", Version: 1, MinWorkers: 1, MaxWorkers: 1, Enabled: true}
	if err := m.editProfile(ctx, "PUT", "standard", in); err != nil {
		t.Fatal(err)
	}
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 2}, nil, nil); err != nil {
		t.Fatal(err)
	}
	_, c, _ := m.read(ctx)
	i := c.Instances[0]
	api.workersList = []*pb.Worker{{Metadata: &pb.ResourceMetadata{Name: "worker"}, WorkerNamespace: space, WorkerPool: i.Name, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, Capacity: &pb.WorkerResources{Actors: 2}}}}
	m.wanted = map[profileBinding]int{{"standard", 1}: 1}
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal("old Resume rejected instead of waiting", err)
	}
	now := time.Now()
	_ = m.reconcile(ctx, now)
	if err := m.reconcile(ctx, now.Add(workerIdleDelay)); err != nil {
		t.Fatal(err)
	}
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal("old Resume rejected during capacity handoff", err)
	}
	api.workersList = nil
	if err := m.reconcile(ctx, now.Add(workerIdleDelay+time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcile(ctx, now.Add(workerIdleDelay+2*time.Second)); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Instances) != 1 || c.Instances[0].Revision != 1 {
		t.Fatal("old revision minimum not restored", c.Instances)
	}
}

func TestProfileConsoleLoadsCatalogOnceAndPropagatesFailure(t *testing.T) {
	m, api := profileFixture(t)
	for n := range 50 {
		api.actors = append(api.actors, &pb.Actor{Metadata: &pb.ResourceMetadata{Name: fmt.Sprint("sandbox-", n)}, ActorTemplate: ref("legacy"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_SUSPENDED}})
	}
	s := &server{workerManager: m, api: api, consoleEnabled: true}
	calls := 0
	fail := false
	m.kube.(*kubefake.Clientset).PrependReactor("get", "configmaps", func(ktesting.Action) (bool, runtime.Object, error) {
		calls++
		if fail {
			return true, nil, fmt.Errorf("unavailable")
		}
		return false, nil, nil
	})
	rec := httptest.NewRecorder()
	s.consoleList(rec, httptest.NewRequest("GET", "/api/console", nil))
	var inventory struct {
		Agents []consoleAgent `json:"agents"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &inventory); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || len(inventory.Agents) != 50 || calls != 1 {
		t.Fatal(rec.Code, len(inventory.Agents), calls)
	}
	fail = true
	rec = httptest.NewRecorder()
	s.consoleList(rec, httptest.NewRequest("GET", "/api/console", nil))
	if rec.Code == 200 {
		t.Fatal("catalog error returned a partial inventory")
	}
}

func TestResumeRestartsOnlyItsWorkersEmptyObservation(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	api.resumeStart = make(chan string, 1)
	api.resumeEnd = make(chan struct{})
	close(api.resumeEnd)
	api.resumed = &pb.Actor{Status: &pb.ActorStatus{WorkerAssignment: &pb.WorkerAssignment{Worker: &pb.ObjectRef{Name: "worker"}}}}
	api.workersList = []*pb.Worker{{WorkerPool: "used"}}
	m.emptySince["used"] = time.Now().Add(-workerIdleDelay)
	m.emptySince["other"] = m.emptySince["used"]
	if _, err := m.resume(ctx, "sandbox"); err != nil {
		t.Fatal(err)
	}
	if !m.emptySince["used"].IsZero() || m.emptySince["other"].IsZero() {
		t.Fatal("placement did not restart the correct idle clock", m.emptySince)
	}
}

func TestCapacityChangeRetriesPlacementBeforeReportingLimit(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal(err)
	}
	cm, c, _ := m.read(ctx)
	c.Profiles[0].MaxWorkers = 1
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	api.workersList = []*pb.Worker{{Metadata: &pb.ResourceMetadata{Name: "newly-ready"}, WorkerNamespace: space, WorkerPool: c.Instances[0].Name, Labels: map[string]string{profileLabel: "standard", revisionLabel: "1"}, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, Capacity: &pb.WorkerResources{Actors: 4}}}}
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, map[string]string{}, nil); err != nil {
		t.Fatal("stale scheduling failure reported exhaustion", err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Instances) != 1 {
		t.Fatal("unnecessary Worker added", c.Instances)
	}
}

func TestInvalidLegacyRetirementCannotActivateManagement(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	cm, c, _ := m.read(ctx)
	c.Mode = "quiescing"
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	s := &server{workerManager: m}
	s.workerRoutes(rec, httptest.NewRequest("PUT", "/api/worker-management", strings.NewReader(`{"mode":"active","version":"1","legacy_pool_uid":"old"}`)))
	_, c, _ = m.read(ctx)
	if rec.Code != 400 || c.Mode != "quiescing" {
		t.Fatal("rejected request enabled placement", rec.Code, c.Mode)
	}
}

func TestBlockedMinimumDoesNotStarveAnotherProfile(t *testing.T) {
	m, api := profileFixture(t)
	ctx := context.Background()
	if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
		t.Fatal(err)
	}
	_, c, _ := m.read(ctx)
	api.workersList = []*pb.Worker{{WorkerNamespace: space, WorkerPool: c.Instances[0].Name, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, Allocated: &pb.WorkerResources{Actors: 1}}}}
	if err := m.editProfile(ctx, "PUT", "standard", profileInput{profileSize: profileSize{4000, 4608, 2}, Name: "Standard", Version: 1, MinWorkers: 1, MaxWorkers: 1, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := m.editProfile(ctx, "POST", "", profileInput{profileSize: profileSize{2000, 2560, 1}, Name: "Other", MinWorkers: 1, MaxWorkers: 1, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcile(ctx, time.Now()); status.Code(err) != codes.ResourceExhausted {
		t.Fatal("blocked minimum not reported", err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Instances) != 2 || c.Instances[1].ProfileID == "standard" {
		t.Fatal("unrelated minimum starved", c.Instances)
	}
}

func TestChangingDefaultInvalidatesThePreviousProfilesVersion(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	if err := m.editProfile(ctx, "POST", "", profileInput{profileSize: profileSize{2000, 2560, 1}, Name: "Other", MaxWorkers: 1, Enabled: true, Default: true}); err != nil {
		t.Fatal(err)
	}
	if err := m.editProfile(ctx, "PUT", "standard", profileInput{profileSize: profileSize{8000, 8256, 4}, Name: "Renamed", Version: 1, MaxWorkers: 8, Enabled: true, Default: true}); status.Code(err) != codes.Aborted {
		t.Fatal("stale form restored the previous default", err)
	}
}

func TestQuiesceFencesRoutedRequestsAndAllowsSuspendControl(t *testing.T) {
	m, api := profileFixture(t)
	api.actorState = pb.ActorState_ACTOR_STATE_RUNNING
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()
	s := &server{workerManager: m, api: api, transport: &http.Transport{DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(upstream.URL, "http://"))
	}}}
	defer s.transport.CloseIdleConnections()
	finished := make(chan error, 1)
	go func() {
		response, err := s.workload(context.Background(), "sandbox", "GET", "/session", nil)
		if response != nil {
			response.Body.Close()
		}
		finished <- err
	}()
	<-started
	if m.placement.TryLock() {
		m.placement.Unlock()
		t.Fatal("in-flight router request was not fenced")
	}
	quiesced := make(chan int, 1)
	go func() {
		rec := httptest.NewRecorder()
		s.workerRoutes(rec, httptest.NewRequest("PUT", "/api/worker-management", strings.NewReader(`{"mode":"quiescing","version":"1"}`)))
		quiesced <- rec.Code
	}()
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if code := <-quiesced; code != 200 {
		t.Fatal(code)
	}
	if response, err := s.workload(context.Background(), "sandbox", "GET", "/session", nil); status.Code(err) != codes.FailedPrecondition || response != nil {
		t.Fatal("routed probe admitted after quiesce", err)
	}
	if err := s.runtimeGate(context.Background(), "sandbox", true); err != nil {
		t.Fatal("Suspend blocked by quiesce", err)
	}
	api.actorState = pb.ActorState_ACTOR_STATE_SUSPENDED
	if err := s.runtimeGate(context.Background(), "sandbox", false); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("control request could wake a saved sandbox", err)
	}
	if calls.Load() != 2 {
		t.Fatal("unexpected router calls", calls.Load())
	}
}

func TestHostExhaustionWaitsForAnEmptyOtherRevision(t *testing.T) {
	for _, exhausted := range []string{"workers", "cpu"} {
		t.Run(exhausted, func(t *testing.T) {
			m, api := profileFixture(t)
			ctx := context.Background()
			if err := m.editProfile(ctx, "PUT", "standard", profileInput{profileSize: profileSize{4000, 4608, 2}, Name: "Standard", Version: 1, MinWorkers: 1, MaxWorkers: 8, Enabled: true}); err != nil {
				t.Fatal(err)
			}
			if err := m.ensureCapacity(ctx, profileBinding{"standard", 2}, nil, nil); err != nil {
				t.Fatal(err)
			}
			_, c, _ := m.read(ctx)
			api.workersList = []*pb.Worker{{WorkerNamespace: space, WorkerPool: c.Instances[0].Name, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE, Capacity: &pb.WorkerResources{Actors: 2}}}}
			count := 7
			if exhausted == "cpu" {
				count = 1
			}
			for n := range count {
				pod := &core.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprint("other-", n), Labels: map[string]string{"ate.dev/worker-pool": "other"}}, Spec: core.PodSpec{NodeName: "host", Containers: []core.Container{{Name: "other"}}}}
				if exhausted == "cpu" {
					pod.Spec.Containers[0].Resources.Limits = core.ResourceList{core.ResourceCPU: resource.MustParse("91")}
				}
				if _, err := m.kube.CoreV1().Pods(space).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			if err := m.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); err != nil {
				t.Fatal("reclaimable Host capacity rejected", err)
			}
			_, c, _ = m.read(ctx)
			if len(c.Instances) != 1 {
				t.Fatal("Host budget exceeded", c.Instances)
			}
		})
	}
}

func sharedCatalogManagers(t *testing.T) (*workerManager, *workerManager) {
	t.Helper()
	m, _ := profileFixture(t)
	ctx := context.Background()
	m.podName, m.podUID = "production", "production-uid"
	if err := m.claim(ctx); err != nil {
		t.Fatal(err)
	}
	cm, _, _ := m.read(ctx)
	cm.Name, cm.ResourceVersion = "candidate", ""
	if _, err := m.kube.CoreV1().ConfigMaps(space).Create(ctx, cm, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	other := &workerManager{kube: m.kube, pools: m.pools, api: m.api, configName: "candidate", podName: "candidate", podUID: "candidate-uid"}
	// The candidate starts with an unclaimed copy of the production resource version.
	cm, err := m.kube.CoreV1().ConfigMaps(space).Get(ctx, "candidate", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var c workerCatalog
	if err = json.Unmarshal([]byte(cm.Data["catalog.json"]), &c); err != nil {
		t.Fatal(err)
	}
	c.OwnerPod, c.OwnerUID = "", ""
	if err = other.save(ctx, cm, &c); err != nil {
		t.Fatal(err)
	}
	if err = other.claim(ctx); err != nil {
		t.Fatal(err)
	}
	for _, manager := range []*workerManager{m, other} {
		_, err = m.kube.CoreV1().Pods(space).Create(ctx, &core.Pod{ObjectMeta: metav1.ObjectMeta{Name: manager.podName, UID: types.UID(manager.podUID)}, Status: core.PodStatus{Phase: core.PodRunning}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
	}
	kube := m.kube.(*kubefake.Clientset)
	gvr := coordination.SchemeGroupVersion.WithResource("leases")
	kube.PrependReactor("update", "leases", func(action ktesting.Action) (bool, runtime.Object, error) {
		next := action.(ktesting.UpdateAction).GetObject().(*coordination.Lease)
		current, err := kube.Tracker().Get(gvr, space, next.Name)
		if err != nil {
			return true, nil, err
		}
		old := current.(*coordination.Lease)
		if old.ResourceVersion != next.ResourceVersion {
			return true, nil, apierrors.NewConflict(schema.GroupResource{Group: "coordination.k8s.io", Resource: "leases"}, next.Name, fmt.Errorf("stale Lease"))
		}
		next.ResourceVersion += "1"
		return true, next, kube.Tracker().Update(gvr, next, space)
	})
	return m, other
}

func TestHostLeaseFencesLiveOwnersAndRecoversDeadOwners(t *testing.T) {
	m, other := sharedCatalogManagers(t)
	release, err := m.lockHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if unlock, e := other.lockHost(ctx); e == nil {
		unlock()
		t.Fatal("live owner's allocation was not fenced")
	}
	if err = m.kube.CoreV1().Pods(space).Delete(context.Background(), m.podName, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	unlock, err := other.lockHost(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	release()
	lease, err := other.kube.CoordinationV1().Leases(space).Get(context.Background(), "worker-profile-allocation", metav1.GetOptions{})
	if err != nil || lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity != other.podUID {
		t.Fatal("stale release cleared the recovered owner", err)
	}
}

func TestConcurrentCatalogsShareHostBudgetIncludingFailedStarts(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprint(failed), func(t *testing.T) {
			m, other := sharedCatalogManagers(t)
			ctx := context.Background()
			_, c, _ := m.read(ctx)
			for n := range 7 {
				_, err := m.pools.ApiV1alpha1().WorkerPools(space).Create(ctx, poolFor(c, managedInstance{Name: fmt.Sprint("preexisting-", n), ProfileID: "standard", Revision: 1}), metav1.CreateOptions{})
				if err != nil {
					t.Fatal(err)
				}
			}
			if failed {
				m.pools.(*atefake.Clientset).PrependReactor("create", "workerpools", func(ktesting.Action) (bool, runtime.Object, error) {
					return true, nil, fmt.Errorf("Worker API unavailable")
				})
			}
			start, results := make(chan struct{}), make(chan error, 2)
			for _, manager := range []*workerManager{m, other} {
				go func() {
					<-start
					manager.mu.Lock()
					defer manager.mu.Unlock()
					cm, c, err := manager.read(ctx)
					if err == nil {
						err = manager.add(ctx, cm, c, "standard", 1)
					}
					results <- err
				}()
			}
			close(start)
			exhausted := 0
			for range 2 {
				if status.Code(<-results) == codes.ResourceExhausted {
					exhausted++
				}
			}
			_, production, _ := m.read(ctx)
			_, candidate, _ := other.read(ctx)
			pools, _ := m.pools.ApiV1alpha1().WorkerPools(space).List(ctx, metav1.ListOptions{})
			wantPools := 8
			if failed {
				wantPools = 7
			}
			if exhausted != 1 || len(production.Instances)+len(candidate.Instances) != 1 || len(pools.Items) != wantPools {
				t.Fatal("Host reservation exceeded", exhausted, len(production.Instances), len(candidate.Instances), len(pools.Items))
			}
		})
	}
}

func TestQuiescingReconciliationReleasesAnUncertainHostLock(t *testing.T) {
	m, _ := sharedCatalogManagers(t)
	ctx := context.Background()
	cm, c, _ := m.read(ctx)
	c.Mode = "quiescing"
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	if _, err := m.lockHost(ctx); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcile(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	lease, err := m.kube.CoordinationV1().Leases(space).Get(ctx, "worker-profile-allocation", metav1.GetOptions{})
	if err != nil || lease.Spec.HolderIdentity != nil {
		t.Fatal("uncertain release not recovered while quiescing", err)
	}
}

func TestHostQuiescingBlocksActiveCandidateAdmissions(t *testing.T) {
	m, other := sharedCatalogManagers(t)
	ctx := context.Background()
	cm, c, _ := other.read(ctx)
	c.Profiles[0].MinWorkers = 1
	if err := other.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	cm, c, _ = m.read(ctx)
	c.Mode = "quiescing"
	if err := m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	if err := other.active(ctx); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("candidate remained active", err)
	}
	if _, err := other.template(ctx, ""); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("candidate Create admitted", err)
	}
	if _, err := other.resume(ctx, "sandbox"); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("candidate Resume admitted", err)
	}
	if err := other.ensureCapacity(ctx, profileBinding{"standard", 1}, nil, nil); status.Code(err) != codes.FailedPrecondition {
		t.Fatal("candidate scaling admitted", err)
	}
	if err := other.reconcile(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	_, c, _ = other.read(ctx)
	if len(c.Instances) != 0 {
		t.Fatal("candidate minimum allocated during shutdown")
	}
	s := &server{workerManager: other, api: other.api}
	if unlock, err := s.admitRoute(ctx, "sandbox", false); status.Code(err) != codes.FailedPrecondition {
		if unlock != nil {
			unlock()
		}
		t.Fatal("candidate route admitted", err)
	}
	other.api.(*profilesAPI).actorState = pb.ActorState_ACTOR_STATE_RUNNING
	unlock, err := s.admitRoute(ctx, "sandbox", true)
	if err != nil {
		t.Fatal("candidate Suspend blocked", err)
	}
	unlock()
}

func TestRuntimeRefreshPreservesExistingProfileVersions(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	cm, c, err := m.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := json.Marshal(c.Profiles[0].Revisions[0])
	var base pb.ActorTemplate
	if err = protojson.Unmarshal(c.BaseTemplate, &base); err != nil {
		t.Fatal(err)
	}
	base.Containers[0].Image = "runtime@sha256:new-native"
	c.BaseTemplate, _ = protojson.Marshal(&base)
	c.WorkerImage = "worker@sha256:new-native"
	if err = m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	in := profileInput{profileSize: profileSize{8000, 8256, 4}, Name: "Standard", Version: 1, MaxWorkers: 8, Enabled: true, RefreshRuntime: true}
	if err = m.editProfile(ctx, "PUT", "standard", in); err != nil {
		t.Fatal(err)
	}
	_, c, err = m.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	p := c.Profiles[0]
	retained, _ := json.Marshal(p.Revisions[0])
	if len(p.Revisions) != 2 || string(original) != string(retained) || p.Revisions[1].WorkerImage != c.WorkerImage {
		t.Fatal("Runtime refresh mutated an old revision")
	}
	var next pb.ActorTemplate
	if err = protojson.Unmarshal(p.Revisions[1].TemplateSpec, &next); err != nil || next.Containers[0].Image != "runtime@sha256:new-native" {
		t.Fatal("New revision did not use the current runtime", err)
	}
	in.Version = p.Version
	if err = m.editProfile(ctx, "PUT", "standard", in); err != nil {
		t.Fatal(err)
	}
	_, c, _ = m.read(ctx)
	if len(c.Profiles[0].Revisions) != 2 {
		t.Fatal("Repeated runtime refresh created another revision")
	}
}

func TestRuntimeRefreshKeepsLegacyResourceBudgets(t *testing.T) {
	m, _ := profileFixture(t)
	ctx := context.Background()
	cm, c, err := m.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	old := &c.Profiles[0].Revisions[0]
	reserve := int64(250)
	old.CPUMilli, old.ReservedCPUMilli, old.ReservedMemoryMiB = 8250, &reserve, 256
	var saved pb.ActorTemplate
	if err = protojson.Unmarshal(old.TemplateSpec, &saved); err != nil {
		t.Fatal(err)
	}
	saved.Resources = &pb.Resources{Limits: []*pb.Limits{{Name: "cpu", Quantity: "2000m"}, {Name: "memory", Quantity: "2000Mi"}}}
	old.TemplateSpec, _ = protojson.Marshal(&saved)
	original, _ := json.Marshal(old)
	var base pb.ActorTemplate
	if err = protojson.Unmarshal(c.BaseTemplate, &base); err != nil {
		t.Fatal(err)
	}
	base.Containers[0].Image = "runtime@sha256:updated"
	c.BaseTemplate, _ = protojson.Marshal(&base)
	if err = m.save(ctx, cm, c); err != nil {
		t.Fatal(err)
	}
	in := profileInput{profileSize: old.profileSize, Name: "Standard", Version: 1, MaxWorkers: 8, Enabled: true, ReservedCPUMilli: &reserve, ReservedMemoryMiB: 256, RefreshRuntime: true}
	if err = m.editProfile(ctx, "PUT", "standard", in); err != nil {
		t.Fatal(err)
	}
	_, c, err = m.read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	versions := c.Profiles[0].Revisions
	retained, _ := json.Marshal(versions[0])
	if len(versions) != 2 || string(original) != string(retained) || versions[1].cpuReserve() != 250 || versions[1].memoryReserve() != 256 {
		t.Fatal("Legacy budgets or old revision changed")
	}
	var updated pb.ActorTemplate
	if err = protojson.Unmarshal(versions[1].TemplateSpec, &updated); err != nil || updated.Resources.String() != saved.Resources.String() || updated.Containers[0].Image != "runtime@sha256:updated" {
		t.Fatal("Legacy limits changed", err)
	}
}
