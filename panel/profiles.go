package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	ate "github.com/agent-substrate/substrate/pkg/api/v1alpha1"
	ateclient "github.com/agent-substrate/substrate/pkg/client/clientset/versioned"
	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

const profileLabel = "agent-box/profile"
const revisionLabel = "agent-box/revision"
const managedLabel = "agent-box/managed"
const catalogLabel = "agent-box/worker-catalog"
const reserveCPU = 0
const reserveMemory = 64
const hostWorkerLimit = 8
const workerIdleDelay = 5 * time.Minute
const sandboxOperationTimeout = workerIdleDelay + 5*time.Minute

type profileSize struct {
	CPUMilli  int64 `json:"cpu_milli"`
	MemoryMiB int64 `json:"memory_mib"`
	Slots     int32 `json:"slots"`
}

func (p profileSize) sandbox() (int64, int64) {
	return (p.CPUMilli - reserveCPU) / int64(p.Slots), (p.MemoryMiB - reserveMemory) / int64(p.Slots)
}
func (p profileSize) validate() error {
	if p.Slots < 1 || p.Slots > 1000 || p.CPUMilli <= reserveCPU || p.CPUMilli >= 1000000 || p.MemoryMiB <= reserveMemory || p.MemoryMiB > 1<<30 {
		return status.Error(codes.InvalidArgument, "Invalid Worker CPU, memory or slot count")
	}
	cpu, memory := p.sandbox()
	if cpu < 1 || memory < 1 {
		return status.Error(codes.InvalidArgument, "Every sandbox must have positive CPU and memory after the service reserve")
	}
	return nil
}

type profileRevision struct {
	profileSize
	Revision          int             `json:"revision"`
	Template          string          `json:"template"`
	TemplateSpec      json.RawMessage `json:"template_spec"`
	WorkerImage       string          `json:"worker_image"`
	SandboxConfig     string          `json:"sandbox_config"`
	Legacy            bool            `json:"legacy,omitempty"`
	ReservedMemoryMiB int64           `json:"reserved_memory_mib,omitempty"`
	ReservedCPUMilli  *int64          `json:"reserved_cpu_milli,omitempty"`
}

func (r profileRevision) cpuReserve() int64 {
	if r.ReservedCPUMilli == nil {
		return 250
	}
	return *r.ReservedCPUMilli
}

func (r profileRevision) memoryReserve() int64 {
	if r.ReservedMemoryMiB == 0 {
		return 512 // Catalog versions created before reserves were stored explicitly.
	}
	return r.ReservedMemoryMiB
}

func (r profileRevision) sandbox() (int64, int64) {
	return (r.CPUMilli - r.cpuReserve()) / int64(r.Slots), (r.MemoryMiB - r.memoryReserve()) / int64(r.Slots)
}

type workerProfile struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Version    int               `json:"version"`
	MinWorkers int               `json:"min_workers"`
	MaxWorkers int               `json:"max_workers"`
	Enabled    bool              `json:"enabled"`
	Deleted    bool              `json:"deleted,omitempty"`
	Revisions  []profileRevision `json:"revisions"`
}
type managedInstance struct {
	Name      string `json:"name"`
	ProfileID string `json:"profile_id"`
	Revision  int    `json:"revision"`
	UID       string `json:"uid,omitempty"`
	Draining  bool   `json:"draining,omitempty"`
}
type profileBinding struct {
	ProfileID string `json:"profile_id"`
	Revision  int    `json:"revision"`
}
type workerCatalog struct {
	OwnerPod     string                    `json:"owner_pod,omitempty"`
	OwnerUID     string                    `json:"owner_uid,omitempty"`
	Mode         string                    `json:"mode"`
	DefaultID    string                    `json:"default_id"`
	Node         string                    `json:"node"`
	WorkerImage  string                    `json:"worker_image"`
	BaseTemplate json.RawMessage           `json:"base_template"`
	Profiles     []workerProfile           `json:"profiles"`
	Bindings     map[string]profileBinding `json:"bindings"`
	Instances    []managedInstance         `json:"instances"`
}
type workerManager struct {
	podName    string
	podUID     string
	kube       kubernetes.Interface
	pools      ateclient.Interface
	api        pb.ControlClient
	configName string
	mu         sync.Mutex
	placement  sync.RWMutex
	emptySince map[string]time.Time
	wanted     map[profileBinding]int
}

func newWorkerManager(api pb.ControlClient) (*workerManager, error) {
	ca, err := roots("/run/kubernetes/ca.crt")
	if err != nil {
		return nil, err
	}
	_ = ca
	cfg := &rest.Config{Host: "https://kubernetes.default.svc", BearerTokenFile: "/run/kubernetes/token", TLSClientConfig: rest.TLSClientConfig{CAFile: "/run/kubernetes/ca.crt"}, Timeout: 15 * time.Second}
	kube, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	pools, err := ateclient.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	name := os.Getenv("WORKER_CATALOG")
	if name == "" {
		name = "worker-profiles"
	}
	m := &workerManager{kube: kube, pools: pools, api: api, configName: name, emptySince: map[string]time.Time{}, podName: os.Getenv("POD_NAME"), podUID: os.Getenv("POD_UID")}
	if m.podName == "" || m.podUID == "" {
		return nil, fmt.Errorf("Worker manager requires its Pod name and UID")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = m.claim(ctx); err != nil {
		return nil, err
	}
	return m, nil
}
func (m *workerManager) read(ctx context.Context) (*core.ConfigMap, *workerCatalog, error) {
	cm, err := m.kube.CoreV1().ConfigMaps(space).Get(ctx, m.configName, metav1.GetOptions{})
	if err != nil {
		return nil, nil, err
	}
	var c workerCatalog
	if json.Unmarshal([]byte(cm.Data["catalog.json"]), &c) != nil || (c.Mode != "active" && c.Mode != "quiescing") || c.Node == "" || c.DefaultID == "" {
		return nil, nil, status.Error(codes.FailedPrecondition, "Worker catalog is unavailable or invalid")
	}
	if m.podUID != "" && c.OwnerUID != m.podUID {
		return nil, nil, status.Error(codes.FailedPrecondition, "Another panel owns Worker management")
	}
	return cm, &c, nil
}
func (m *workerManager) claim(ctx context.Context) error {
	cm, err := m.kube.CoreV1().ConfigMaps(space).Get(ctx, m.configName, metav1.GetOptions{})
	if err != nil {
		return err
	}
	var c workerCatalog
	if err = json.Unmarshal([]byte(cm.Data["catalog.json"]), &c); err != nil {
		return err
	}
	if c.OwnerUID != "" && c.OwnerUID != m.podUID {
		pod, e := m.kube.CoreV1().Pods(space).Get(ctx, c.OwnerPod, metav1.GetOptions{})
		if e != nil && !apierrors.IsNotFound(e) {
			return e
		}
		if e == nil && string(pod.UID) == c.OwnerUID && pod.Status.Phase != core.PodSucceeded && pod.Status.Phase != core.PodFailed {
			return status.Error(codes.FailedPrecondition, "Previous Worker manager Pod still exists; wait for it to stop")
		}
	}
	c.OwnerPod = m.podName
	c.OwnerUID = m.podUID
	return m.save(ctx, cm, &c)
}

func (m *workerManager) save(ctx context.Context, cm *core.ConfigMap, c *workerCatalog) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	cm.Data["catalog.json"] = string(data)
	if cm.Labels == nil {
		cm.Labels = map[string]string{}
	}
	cm.Labels[catalogLabel] = "true"
	_, err = m.kube.CoreV1().ConfigMaps(space).Update(ctx, cm, metav1.UpdateOptions{})
	if apierrors.IsConflict(err) {
		return status.Error(codes.Aborted, "Worker settings changed; reload and retry")
	}
	return err
}
func (c *workerCatalog) profile(id string) *workerProfile {
	for i := range c.Profiles {
		if c.Profiles[i].ID == id {
			return &c.Profiles[i]
		}
	}
	return nil
}
func (c *workerCatalog) revision(id string, revision int) *profileRevision {
	p := c.profile(id)
	if p != nil {
		for i := range p.Revisions {
			if p.Revisions[i].Revision == revision {
				return &p.Revisions[i]
			}
		}
	}
	return nil
}
func (m *workerManager) mode(ctx context.Context, c *workerCatalog) (string, error) {
	if c.Mode != "active" || m.configName == "worker-profiles" {
		return c.Mode, nil
	}
	cm, err := m.kube.CoreV1().ConfigMaps(space).Get(ctx, "worker-profiles", metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return c.Mode, nil
	}
	if err != nil {
		return "", err
	}
	var host workerCatalog
	if json.Unmarshal([]byte(cm.Data["catalog.json"]), &host) != nil || (host.Mode != "active" && host.Mode != "quiescing") {
		return "", status.Error(codes.FailedPrecondition, "Host management mode is unavailable")
	}
	return host.Mode, nil
}
func (m *workerManager) active(ctx context.Context) error {
	_, c, err := m.read(ctx)
	var mode string
	if err == nil {
		mode, err = m.mode(ctx, c)
	}
	if err == nil && mode != "active" {
		err = status.Error(codes.FailedPrecondition, "Host is quiescing; Create and Resume are blocked")
	}
	return err
}

// Router requests can resume an Actor, so quiescing must wait for their handshakes.
func (s *server) admitRoute(ctx context.Context, name string, suspendControl bool) (func(), error) {
	m := s.workerManager
	if m == nil {
		return func() {}, nil
	}
	m.placement.RLock()
	_, c, err := m.read(ctx)
	var mode string
	if err == nil {
		mode, err = m.mode(ctx, c)
	}
	if err == nil && mode != "active" {
		if suspendControl {
			var actor *pb.Actor
			actor, err = s.actor(ctx, name)
			if err == nil && actor.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
				err = status.Error(codes.FailedPrecondition, "Suspend control requires a running sandbox")
			}
		} else {
			err = status.Error(codes.FailedPrecondition, "Host is quiescing; runtime requests are blocked")
		}
	}
	if err != nil {
		m.placement.RUnlock()
		return nil, err
	}
	return m.placement.RUnlock, nil
}

func (m *workerManager) template(ctx context.Context, id string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, c, err := m.read(ctx)
	if err != nil {
		return "", err
	}
	mode, err := m.mode(ctx, c)
	if err != nil {
		return "", err
	}
	if mode != "active" {
		return "", status.Error(codes.FailedPrecondition, "Host is quiescing")
	}
	if id == "" {
		id = c.DefaultID
	}
	p := c.profile(id)
	if p == nil || p.Deleted || !p.Enabled {
		return "", status.Error(codes.InvalidArgument, "Worker profile is not enabled for new sandboxes")
	}
	rev := p.Revisions[len(p.Revisions)-1]
	var template pb.ActorTemplate
	if err = protojson.Unmarshal(rev.TemplateSpec, &template); err != nil {
		return "", err
	}
	existing, err := m.api.GetActorTemplate(ctx, &pb.GetActorTemplateRequest{ActorTemplate: ref(rev.Template)})
	if status.Code(err) == codes.NotFound {
		existing, err = m.api.CreateActorTemplate(ctx, &pb.CreateActorTemplateRequest{ActorTemplate: &template})
		if err != nil {
			existing, err = m.api.GetActorTemplate(ctx, &pb.GetActorTemplateRequest{ActorTemplate: ref(rev.Template)})
		}
	}
	if err != nil {
		return "", err
	}
	existing = proto.Clone(existing).(*pb.ActorTemplate)
	existing.Metadata = template.Metadata
	existing.Status = nil
	if !proto.Equal(existing, &template) {
		return "", status.Error(codes.FailedPrecondition, "Immutable profile template differs from its catalog version")
	}
	return rev.Template, nil
}

type profileInput struct {
	profileSize
	Name              string `json:"name"`
	Version           int    `json:"version"`
	MinWorkers        int    `json:"min_workers"`
	MaxWorkers        int    `json:"max_workers"`
	Enabled           bool   `json:"enabled"`
	Default           bool   `json:"default"`
	ReservedMemoryMiB int64  `json:"reserved_memory_mib,omitempty"`
	ReservedCPUMilli  *int64 `json:"reserved_cpu_milli,omitempty"`
	RefreshRuntime    bool   `json:"refresh_runtime,omitempty"`
}

func makeRevision(c *workerCatalog, id string, number int, size profileSize) (profileRevision, error) {
	var template pb.ActorTemplate
	if err := protojson.Unmarshal(c.BaseTemplate, &template); err != nil {
		return profileRevision{}, err
	}
	name := fmt.Sprintf("profile-%s-v%d", id, number)
	template.Metadata = &pb.ResourceMetadata{Atespace: space, Name: name}
	template.Status = nil
	template.WorkerSelector = &pb.Selector{MatchLabels: map[string]string{managedLabel: "true", profileLabel: id, revisionLabel: strconv.Itoa(number)}}
	cpu, memory := size.sandbox()
	template.Resources = &pb.Resources{Limits: []*pb.Limits{{Name: "cpu", Quantity: fmt.Sprintf("%dm", cpu)}, {Name: "memory", Quantity: fmt.Sprintf("%dMi", memory)}}}
	raw, err := protojson.Marshal(&template)
	cpuReserve := int64(reserveCPU)
	return profileRevision{profileSize: size, Revision: number, Template: name, TemplateSpec: raw, WorkerImage: c.WorkerImage, SandboxConfig: template.GetSandboxConfig().GetConfigName(), ReservedMemoryMiB: reserveMemory, ReservedCPUMilli: &cpuReserve}, err
}
func (m *workerManager) editProfile(ctx context.Context, method, id string, in profileInput) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cm, c, err := m.read(ctx)
	if err != nil {
		return err
	}
	p := c.profile(id)
	if method == http.MethodPost {
		if id != "" {
			return status.Error(codes.InvalidArgument, "POST requires the profiles collection")
		}
		generated, e := generatedSandboxName()
		if e != nil {
			return e
		}
		id = strings.TrimPrefix(generated, "sandbox-")
		c.Profiles = append(c.Profiles, workerProfile{ID: id})
		p = &c.Profiles[len(c.Profiles)-1]
	} else if p == nil || p.Deleted {
		return status.Error(codes.NotFound, "Worker profile not found")
	} else if in.Version != p.Version {
		return status.Error(codes.Aborted, "Profile changed; reload and retry")
	}
	if method == http.MethodDelete {
		if c.DefaultID == id {
			return status.Error(codes.FailedPrecondition, "Choose another default profile before deleting")
		}
		for _, instance := range c.Instances {
			if instance.ProfileID == id {
				return status.Error(codes.FailedPrecondition, "Profile still has Workers")
			}
		}
		for token := ""; ; {
			page, e := m.api.ListActors(ctx, &pb.ListActorsRequest{Atespace: space, Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
			if e != nil {
				return e
			}
			for _, actor := range page.GetActors() {
				if b, ok := c.Bindings[actor.GetActorTemplate().GetName()]; ok && b.ProfileID == id {
					return status.Error(codes.FailedPrecondition, "Profile is used by a sandbox, including suspended sandboxes")
				}
			}
			token = page.GetNextPageToken()
			if token == "" {
				break
			}
		}
		p.Deleted = true
		p.Enabled = false
		p.Version++
		return m.save(ctx, cm, c)
	}
	if err = in.profileSize.validate(); err != nil {
		return err
	}
	newRevision := len(p.Revisions) == 0
	runtimeOnly := false
	if !newRevision {
		previous := p.Revisions[len(p.Revisions)-1]
		newRevision = previous.profileSize != in.profileSize || in.ReservedMemoryMiB != 0 && in.ReservedMemoryMiB != previous.memoryReserve() || in.ReservedCPUMilli != nil && *in.ReservedCPUMilli != previous.cpuReserve()
		if in.RefreshRuntime && !newRevision {
			var existing, desired pb.ActorTemplate
			if protojson.Unmarshal(previous.TemplateSpec, &existing) != nil || protojson.Unmarshal(c.BaseTemplate, &desired) != nil {
				return status.Error(codes.FailedPrecondition, "Profile runtime is invalid")
			}
			newRevision = previous.WorkerImage != c.WorkerImage || !proto.Equal(
				&pb.ActorTemplate{Containers: existing.GetContainers()},
				&pb.ActorTemplate{Containers: desired.GetContainers()})
			runtimeOnly = newRevision
		}
	}
	if newRevision && !runtimeOnly && in.CPUMilli%(int64(in.Slots)*1000) != 0 {
		return status.Error(codes.InvalidArgument, "New resource versions require a whole number of CPU cores per sandbox")
	}
	if newRevision && !runtimeOnly && in.ReservedCPUMilli != nil && *in.ReservedCPUMilli != reserveCPU {
		return status.Error(codes.InvalidArgument, "New resource versions do not add a Worker CPU reserve")
	}
	if newRevision && !runtimeOnly && in.ReservedMemoryMiB != 0 && in.ReservedMemoryMiB != reserveMemory {
		return status.Error(codes.InvalidArgument, "New resource versions require a 64 MiB Worker reserve")
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 80 || in.MinWorkers < 0 || in.MaxWorkers < 1 || in.MaxWorkers > hostWorkerLimit || in.MinWorkers > in.MaxWorkers {
		return status.Error(codes.InvalidArgument, "Invalid profile name or Worker limits")
	}
	node, err := m.kube.CoreV1().Nodes().Get(ctx, c.Node, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if in.CPUMilli > node.Status.Allocatable.Cpu().MilliValue() || in.MemoryMiB > node.Status.Allocatable.Memory().Value()/(1<<20) {
		return status.Error(codes.InvalidArgument, "Worker size exceeds the Host's allocatable CPU or memory")
	}
	minimum := in.MinWorkers
	for _, other := range c.Profiles {
		if other.ID != id && !other.Deleted {
			minimum += other.MinWorkers
		}
	}
	if minimum > hostWorkerLimit {
		return status.Error(codes.InvalidArgument, "Profile minimums exceed the Host Worker limit")
	}
	if !in.Enabled && (in.Default || c.DefaultID == id) {
		return status.Error(codes.InvalidArgument, "The default profile must allow new sandboxes")
	}
	p.Name = strings.TrimSpace(in.Name)
	p.Enabled = in.Enabled
	p.MinWorkers = in.MinWorkers
	p.MaxWorkers = in.MaxWorkers
	p.Version++
	if newRevision {
		rev, e := makeRevision(c, id, len(p.Revisions)+1, in.profileSize)
		if e != nil {
			return e
		}
		if runtimeOnly {
			previous := p.Revisions[len(p.Revisions)-1]
			var oldTemplate, updated pb.ActorTemplate
			if protojson.Unmarshal(previous.TemplateSpec, &oldTemplate) != nil || protojson.Unmarshal(rev.TemplateSpec, &updated) != nil {
				return status.Error(codes.FailedPrecondition, "Profile runtime is invalid")
			}
			updated.Resources = oldTemplate.Resources
			if rev.TemplateSpec, err = protojson.Marshal(&updated); err != nil {
				return err
			}
			rev.ReservedMemoryMiB = previous.ReservedMemoryMiB
			rev.ReservedCPUMilli = previous.ReservedCPUMilli
		}
		p.Revisions = append(p.Revisions, rev)
		c.Bindings[rev.Template] = profileBinding{ProfileID: id, Revision: rev.Revision}
	}
	if in.Default {
		if old := c.profile(c.DefaultID); old != nil && old.ID != id {
			old.Version++
		}
		c.DefaultID = id
	}
	return m.save(ctx, cm, c)
}
func (s *server) workerRoutes(w http.ResponseWriter, r *http.Request) {
	m := s.workerManager
	if m == nil {
		if r.Method == http.MethodGet && r.URL.Path == "/api/worker-profiles" {
			reply(w, map[string]any{"enabled": false, "profiles": []any{}})
			return
		}
		http.Error(w, "Worker profiles are not enabled", 503)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	var err error
	switch {
	case r.URL.Path == "/api/worker-management":
		if r.Method == http.MethodPut {
			var in struct {
				Mode          string `json:"mode"`
				Version       string `json:"version"`
				LegacyPoolUID string `json:"legacy_pool_uid,omitempty"`
			}
			if decode(r, &in) != nil || (in.Mode != "active" && in.Mode != "quiescing") || (in.LegacyPoolUID != "" && in.Mode != "quiescing") {
				http.Error(w, "Invalid management mode", 400)
				return
			}
			m.placement.Lock()
			defer m.placement.Unlock()
			m.mu.Lock()
			defer m.mu.Unlock()
			var cm *core.ConfigMap
			var c *workerCatalog
			cm, c, err = m.read(ctx)
			if err == nil && cm.ResourceVersion != in.Version {
				err = status.Error(codes.Aborted, "Management state changed; reload and retry")
			}
			if err == nil {
				c.Mode = in.Mode
				err = m.save(ctx, cm, c)
				if err == nil && in.LegacyPoolUID != "" {
					err = m.retireLegacy(ctx, in.LegacyPoolUID)
				}
			}
		} else if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", 405)
			return
		}
		if err == nil {
			cm, c, e := m.read(ctx)
			err = e
			if err == nil {
				reply(w, map[string]any{"mode": c.Mode, "version": cm.ResourceVersion, "host_worker_limit": hostWorkerLimit, "idle_seconds": int(workerIdleDelay.Seconds())})
				return
			}
		}
	case r.URL.Path == "/api/workers" && r.Method == http.MethodGet:
		var view any
		view, err = m.workerView(ctx)
		if err == nil {
			reply(w, view)
			return
		}
	case r.URL.Path == "/api/worker-profiles" || strings.HasPrefix(r.URL.Path, "/api/worker-profiles/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/worker-profiles")
		id = strings.TrimPrefix(id, "/")
		if r.Method == http.MethodGet {
			_, c, e := m.read(ctx)
			err = e
			if err == nil {
				profiles := []map[string]any{}
				for _, p := range c.Profiles {
					if p.Deleted || id != "" && p.ID != id {
						continue
					}
					rev := p.Revisions[len(p.Revisions)-1]
					cpu, memory := rev.sandbox()
					profiles = append(profiles, map[string]any{"id": p.ID, "name": p.Name, "version": p.Version, "revision": rev.Revision, "cpu_milli": rev.CPUMilli, "memory_mib": rev.MemoryMiB, "slots": rev.Slots, "min_workers": p.MinWorkers, "max_workers": p.MaxWorkers, "enabled": p.Enabled, "default": p.ID == c.DefaultID, "sandbox_cpu_milli": cpu, "sandbox_memory_mib": memory, "reserved_cpu_milli": rev.cpuReserve(), "reserved_memory_mib": rev.memoryReserve()})
				}
				reply(w, map[string]any{"enabled": true, "profiles": profiles, "default_id": c.DefaultID})
				return
			}
		} else if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodDelete {
			var in profileInput
			if r.Method == http.MethodPost {
				in.MaxWorkers = 8
				in.Enabled = true
			}
			if decode(r, &in) != nil {
				http.Error(w, "Invalid profile", 400)
				return
			}
			// Exclude admissions while deleting bindings or changing the default.
			m.placement.Lock()
			defer m.placement.Unlock()
			err = m.editProfile(ctx, r.Method, id, in)
			if err == nil {
				reply(w, map[string]bool{"ok": true})
				return
			}
		} else {
			http.Error(w, "Method not allowed", 405)
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	s.fail(w, err)
}

func resourcesFor(size profileSize) core.ResourceList {
	return core.ResourceList{core.ResourceCPU: *resource.NewMilliQuantity(size.CPUMilli, resource.DecimalSI), core.ResourceMemory: *resource.NewQuantity(size.MemoryMiB*(1<<20), resource.BinarySI)}
}
func poolFor(c *workerCatalog, i managedInstance) *ate.WorkerPool {
	rev := c.revision(i.ProfileID, i.Revision)
	labels := map[string]string{managedLabel: "true", profileLabel: i.ProfileID, revisionLabel: strconv.Itoa(i.Revision)}
	if rev.Legacy {
		labels["workload"] = space
	}
	slots := rev.Slots
	return &ate.WorkerPool{ObjectMeta: metav1.ObjectMeta{Name: i.Name, Namespace: space, Labels: labels}, Spec: ate.WorkerPoolSpec{Replicas: 1, WorkerImage: rev.WorkerImage, MaxActors: &slots, ReservedResources: resourcesFor(profileSize{CPUMilli: rev.cpuReserve(), MemoryMiB: rev.memoryReserve()}), SandboxClasses: []ate.WorkerPoolSandboxClass{{Name: ate.SandboxClassGvisor, ConfigRef: &ate.SandboxConfigReference{Name: rev.SandboxConfig}}}, Template: &ate.WorkerPoolPodTemplate{NodeSelector: map[string]string{"kubernetes.io/hostname": c.Node}, Resources: &core.ResourceRequirements{Requests: resourcesFor(rev.profileSize), Limits: resourcesFor(rev.profileSize)}}}}
}
