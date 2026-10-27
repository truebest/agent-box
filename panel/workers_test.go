package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type capacityAPI struct {
	pb.ControlClient
	mu        sync.Mutex
	desired   int
	active    int
	slots     int
	pending   int
	patches   int
	requests  int
	version   int
	conflict  bool
	stuck     bool
	apiCode   int
	resumeErr error
	running   map[string]bool
}

func (a *capacityAPI) ResumeActor(_ context.Context, request *pb.ResumeActorRequest, _ ...grpc.CallOption) (*pb.ResumeActorResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.resumeErr != nil {
		return nil, a.resumeErr
	}
	name := request.GetActor().GetName()
	if a.running[name] {
		return &pb.ResumeActorResponse{}, nil
	}
	if a.slots == 0 {
		return nil, status.Error(codes.ResourceExhausted, "no worker has room for the actor")
	}
	a.slots--
	a.running[name] = true
	return &pb.ResumeActorResponse{}, nil
}

func (a *capacityAPI) ListWorkers(context.Context, *pb.ListWorkersRequest, ...grpc.CallOption) (*pb.ListWorkersResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pending > 0 && !a.stuck {
		a.pending--
		if a.pending == 0 {
			a.slots += 2 * (a.desired - a.active)
			a.active = a.desired
		}
	}
	var workers []*pb.Worker
	for i := 0; i < a.active; i++ {
		workers = append(workers, &pb.Worker{WorkerNamespace: space, WorkerPool: "agents", Labels: map[string]string{"workload": space},
			Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE}})
	}
	// Unrelated workers must not count as available capacity while ours is registering.
	workers = append(workers, &pb.Worker{WorkerNamespace: "other", WorkerPool: "agents", Labels: map[string]string{"workload": space},
		Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE}})
	return &pb.ListWorkersResponse{Workers: workers}, nil
}

func capacityServer(t *testing.T, a *capacityAPI, max int) *server {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.requests++
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("Missing private projected token")
		}
		if a.apiCode != 0 {
			w.WriteHeader(a.apiCode)
			fmt.Fprint(w, "private upstream error must not reach browser")
			return
		}
		switch {
		case r.Method == "GET" && r.URL.Path == workerPoolPath:
			json.NewEncoder(w).Encode(map[string]any{
				"metadata": map[string]string{"resourceVersion": fmt.Sprint(a.version)},
				"spec":     map[string]int{"replicas": a.desired},
				"status":   map[string]int{"readyReplicas": a.desired},
			})
		case r.Method == "PATCH" && r.URL.Path == workerPoolPath+"/scale":
			if r.Header.Get("Content-Type") != "application/merge-patch+json" {
				t.Error("Wrong scale patch type")
			}
			var patch struct {
				Metadata struct{ ResourceVersion string } `json:"metadata"`
				Spec     struct{ Replicas int }           `json:"spec"`
			}
			if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
				t.Error(err)
			}
			if patch.Metadata.ResourceVersion != fmt.Sprint(a.version) || patch.Spec.Replicas != a.desired+1 {
				t.Error("Scale patch did not guard version and increment by one")
			}
			a.desired++
			a.version++
			a.pending = 2
			a.patches++
			if a.conflict {
				a.conflict = false
				w.WriteHeader(http.StatusConflict)
				return
			}
			fmt.Fprint(w, "{}")
		default:
			t.Errorf("Unapproved Kubernetes request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusForbidden)
		}
	}))
	t.Cleanup(api.Close)
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("test-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if a.running == nil {
		a.running = map[string]bool{}
	}
	return &server{api: a, workerScaler: &workerScaler{client: api.Client(), url: api.URL, token: token, max: max, gate: make(chan struct{}, 1)}}
}

func TestWorkerAutoscalingSharesNewWorker(t *testing.T) {
	a := &capacityAPI{desired: 2, active: 2, version: 1}
	s := capacityServer(t, a, 8)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for _, name := range []string{"codex-one", "codex-two"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.resumeActor(ctx, name); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if a.patches != 1 || a.desired != 3 || len(a.running) != 2 {
		t.Fatalf("Concurrent creates did not share new capacity: %+v", a)
	}
}

func TestWorkerAutoscalingWaitsAfterConcurrentScaleConflict(t *testing.T) {
	a := &capacityAPI{desired: 2, active: 2, version: 1, conflict: true}
	s := capacityServer(t, a, 8)
	if _, err := s.resumeActor(context.Background(), "codex-one"); err != nil {
		t.Fatal(err)
	}
	if a.patches != 1 || a.desired != 3 {
		t.Fatal("Added an extra Worker after another scaler won the version conflict")
	}
}

func TestWorkerAutoscalingBoundsAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name         string
		max, apiCode int
		stuck        bool
		wantCode     codes.Code
		wantText     string
		patches      int
	}{
		{"limit", 2, 0, false, codes.ResourceExhausted, "WORKER_MAX_REPLICAS limit", 0},
		{"pending-worker-timeout", 8, 0, true, codes.DeadlineExceeded, "", 1},
		{"forbidden", 8, 403, false, codes.Unknown, "HTTP 403", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &capacityAPI{desired: 2, active: 2, version: 1, stuck: tc.stuck, apiCode: tc.apiCode}
			s := capacityServer(t, a, tc.max)
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err := s.resumeActor(ctx, "codex-one")
			if status.Code(err) != tc.wantCode || !strings.Contains(err.Error(), tc.wantText) || strings.Contains(err.Error(), "private upstream") || a.patches != tc.patches {
				t.Fatalf("Unsafe failure: err=%v patches=%d", err, a.patches)
			}
		})
	}
}

func TestWorkerAutoscalingDoesNotRetryOtherErrorsOrSuccessfulResume(t *testing.T) {
	for _, resumeErr := range []error{status.Error(codes.PermissionDenied, "denied"), status.Error(codes.ResourceExhausted, "quota exceeded"), nil} {
		a := &capacityAPI{desired: 2, active: 2, version: 1, slots: 1, resumeErr: resumeErr}
		s := capacityServer(t, a, 8)
		_, err := s.resumeActor(context.Background(), "codex-one")
		if status.Code(err) != status.Code(resumeErr) || a.requests != 0 {
			t.Fatalf("Unexpected autoscaling: %v requests=%d", err, a.requests)
		}
	}
}

func TestWorkerAutoscalingQueuedRequestCanCancel(t *testing.T) {
	a := &capacityAPI{desired: 2, active: 2, version: 1}
	s := capacityServer(t, a, 8)
	s.workerScaler.gate <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.resumeActor(ctx, "codex-one")
	if status.Code(err) != codes.Canceled || a.requests != 0 {
		t.Fatal("Canceled queued create attempted to scale")
	}
}

func TestWorkerAutoscalingCanBeDisabled(t *testing.T) {
	for _, limit := range []string{"", "0"} {
		scaler, err := newWorkerScaler(limit)
		if scaler != nil || err != nil {
			t.Fatal("Disabled scaler needs cluster credentials")
		}
	}
	for _, limit := range []string{"-1", "65", "garbage"} {
		if _, err := newWorkerScaler(limit); err == nil {
			t.Fatal("Invalid autoscaling ceiling accepted")
		}
	}
	a := &capacityAPI{}
	s := &server{api: a}
	if _, err := s.resumeActor(context.Background(), "codex-one"); !workerCapacityError(err) {
		t.Fatal("Disabled scaler changed legacy capacity behavior")
	}
}
