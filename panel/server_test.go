package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"github.com/gorilla/websocket"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var accessTestHeaders = map[string]string{
	"Cf-Access-Jwt-Assertion":            "private-access-jwt",
	"Cf-Access-Authenticated-User-Email": "private-user@example.test",
	"Cf-Access-Client-Id":                "private-client-id",
	"Cf-Access-Client-Secret":            "private-client-secret",
}

func TestAuthorization(t *testing.T) {
	s := &server{password: sha256.Sum256([]byte("test-password")), origin: "https://192.0.2.10:8443"}
	for _, tc := range []struct {
		origin, upgrade, password string
		want                      int
	}{
		{"", "", "", 401}, {"https://evil.example", "", "test-password", 403},
		{"", "websocket", "test-password", 403}, {s.origin, "websocket", "test-password", 200}, {"", "", "test-password", 200},
	} {
		r := httptest.NewRequest("GET", "https://192.0.2.10:8443/", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Upgrade", tc.upgrade)
		r.SetBasicAuth("admin", tc.password)
		w := httptest.NewRecorder()
		s.authorize(w, r)
		if w.Code != tc.want {
			t.Fatalf("origin %q: got %d want %d", tc.origin, w.Code, tc.want)
		}
	}
}

func TestLoginAssetsArePublicAndAPIsStayAuthenticated(t *testing.T) {
	s := &server{password: sha256.Sum256([]byte("test-password")), origin: "https://192.0.2.10:8443"}
	assets, err := fs.Glob(web, "web/dist/assets/*.js")
	if err != nil || len(assets) == 0 {
		t.Fatal("frontend assets were not built")
	}
	asset := strings.TrimPrefix(assets[0], "web/dist")
	for _, tc := range []struct {
		path, password, contentType string
		want                        int
	}{
		{"/", "", "text/html", 200},
		{asset, "", "javascript", 200},
		{"/logo.png", "", "image/png", 200},
		{"/api/missing", "", "application/json", 401},
		{"/api/console/ui/", "", "application/json", 401},
		{"/", "test-password", "text/html", 200},
		{asset, "test-password", "javascript", 200},
		{"/assets/missing.js", "test-password", "text/plain", 404},
		{"/api/missing", "test-password", "text/plain", 404},
	} {
		r := httptest.NewRequest("GET", tc.path, nil)
		r.SetBasicAuth("admin", tc.password)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.want || !strings.Contains(w.Header().Get("Content-Type"), tc.contentType) {
			t.Fatalf("%s: got %d %s", tc.path, w.Code, w.Header().Get("Content-Type"))
		}
	}
}

type fakeAPI struct {
	pb.ControlClient
	calls        []string
	gone         bool
	state        pb.ActorState
	uid          string
	snapshots    []*pb.Snapshot
	suspendError error
	deleteError  error
}

func (f *fakeAPI) GetActor(context.Context, *pb.GetActorRequest, ...grpc.CallOption) (*pb.Actor, error) {
	if f.gone {
		return nil, status.Error(codes.NotFound, "gone")
	}
	return &pb.Actor{Metadata: &pb.ResourceMetadata{Uid: f.uid}, Status: &pb.ActorStatus{State: f.state, Snapshots: f.snapshots}}, nil
}
func (f *fakeAPI) SuspendActor(context.Context, *pb.SuspendActorRequest, ...grpc.CallOption) (*pb.SuspendActorResponse, error) {
	f.calls = append(f.calls, "suspend")
	return &pb.SuspendActorResponse{}, f.suspendError
}
func (f *fakeAPI) DeleteActor(context.Context, *pb.DeleteActorRequest, ...grpc.CallOption) (*pb.Actor, error) {
	f.calls = append(f.calls, "delete")
	if f.deleteError != nil {
		return nil, f.deleteError
	}
	f.gone = true
	return &pb.Actor{}, nil
}
func TestManagementOperationsRejectReusedSandboxNames(t *testing.T) {
	for _, operation := range []string{"delete", "resume", "suspend", "revert"} {
		t.Run(operation, func(t *testing.T) {
			api := &fakeAPI{uid: "replacement-uid", state: pb.ActorState_ACTOR_STATE_SUSPENDED}
			s := &server{api: api, password: sha256.Sum256([]byte("test-password"))}
			method, path := "POST", "/api/agents/test-agent/"+operation+"?uid=selected-uid"
			if operation == "delete" {
				method, path = "DELETE", "/api/agents/test-agent?uid=selected-uid"
			}
			r := httptest.NewRequest(method, path, nil)
			r.SetBasicAuth("admin", "test-password")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 404 || len(api.calls) != 0 || api.gone {
				t.Fatalf("replacement mutated: HTTP %d calls %v", w.Code, api.calls)
			}
		})
	}
}

func TestRuntimeRequestsRequireMatchingSandboxUID(t *testing.T) {
	for _, operation := range []struct{ method, path string }{
		{"GET", "files?path=/workspace"}, {"PUT", "files?path=/workspace/saved.txt"},
		{"POST", "files?path=/workspace/new"}, {"DELETE", "files?path=/workspace/saved.txt"},
		{"GET", "terminal/ws?"}, {"POST", "prompt?"}, {"GET", "session?"},
	} {
		for _, uid := range []string{"", "selected-uid", "replacement-uid"} {
			t.Run(operation.method+"/"+operation.path+"/"+uid, func(t *testing.T) {
				api := &fakeAPI{uid: "replacement-uid", state: pb.ActorState_ACTOR_STATE_RUNNING}
				calls := 0
				backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.URL.Path == "/session" {
						reply(w, map[string]string{"kind": "devin"})
					} else {
						reply(w, map[string]bool{"ok": true})
					}
				}))
				defer backend.Close()
				transport := backend.Client().Transport.(*http.Transport)
				transport.TLSClientConfig.ServerName = "example.com"
				transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, network, backend.Listener.Addr().String())
				}
				s := &server{api: api, transport: transport, password: sha256.Sum256([]byte("test-password"))}
				r := httptest.NewRequest(operation.method, "/api/agents/test-agent/"+operation.path+"&uid="+uid, strings.NewReader(`{}`))
				r.SetBasicAuth("admin", "test-password")
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if uid != "replacement-uid" {
					if w.Code != 404 || calls != 0 || len(api.calls) != 0 {
						t.Fatalf("stale request reached sandbox: HTTP %d, forwarded %d, mutations %v", w.Code, calls, api.calls)
					}
				} else {
					want := 1
					if operation.path == "prompt?" {
						want = 2
					}
					if w.Code != 200 || calls != want {
						t.Fatalf("current sandbox unreachable: HTTP %d %s, forwarded %d", w.Code, w.Body.String(), calls)
					}
				}
			})
		}
	}
}

func TestRuntimeConnectionBlocksSandboxReplacement(t *testing.T) {
	for _, websocketRequest := range []bool{false, true} {
		t.Run(fmt.Sprint(websocketRequest), func(t *testing.T) {
			entered, proceed, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				<-proceed
				if websocketRequest {
					conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
					if err == nil {
						conn.Close()
					}
				} else {
					reply(w, map[string]bool{"ok": true})
				}
			}))
			defer backend.Close()
			s := &server{api: &fakeAPI{uid: "selected", state: pb.ActorState_ACTOR_STATE_RUNNING}, password: sha256.Sum256([]byte("test-password"))}
			s.transport = &http.Transport{DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, backend.Listener.Addr().String())
			}}
			go func() {
				defer close(finished)
				r := httptest.NewRequest("GET", "/api/agents/test-agent/files?uid=selected", nil)
				r.SetBasicAuth("admin", "test-password")
				w := httptest.NewRecorder()
				if websocketRequest {
					s.socket(w, r, "test-agent", "selected", "ws"+strings.TrimPrefix(backend.URL, "http"), nil, websocket.Dialer{}, true)
				} else {
					s.ServeHTTP(w, r)
				}
			}()
			select {
			case <-entered:
			case <-time.After(3 * time.Second):
				close(proceed)
				t.Fatal("runtime connection did not start")
			}
			s.mu.Lock()
			lock := s.routes["test-agent"]
			s.mu.Unlock()
			if lock == nil {
				t.Error("runtime connection did not coordinate with replacement")
			} else if lock.TryLock() {
				lock.Unlock()
				t.Error("sandbox can be replaced while runtime routing is pending")
			}
			close(proceed)
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("runtime request did not finish")
			}
			if lock != nil {
				if !lock.TryLock() {
					t.Fatal("runtime request retained the sandbox lock")
				}
				lock.Unlock()
			}
		})
	}
}

func TestRuntimeRoutingDoesNotWaitForCommandsOrHoldStreamingBodies(t *testing.T) {
	proceed := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "2")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-proceed
		io.WriteString(w, "ok")
	}))
	defer backend.Close()
	defer close(proceed)
	s := &server{api: &fakeAPI{uid: "selected"}, transport: &http.Transport{DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, backend.Listener.Addr().String())
	}}}
	unlock := s.lock("test-agent")
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", "https://runtime.example/files", nil)
	response, err := (actorTransport{s, "test-agent", "selected"}).RoundTrip(r)
	if err != nil {
		t.Fatal("runtime read blocked behind a running command:", err)
	}
	defer response.Body.Close()
	gate := s.routeLock("test-agent")
	if !gate.TryLock() {
		t.Fatal("runtime routing held the replacement lock while streaming a response body")
	}
	gate.Unlock()
}

func TestSessionRejectsWebSocketUpgrade(t *testing.T) {
	s := &server{api: &fakeAPI{uid: "uid", state: pb.ActorState_ACTOR_STATE_RUNNING}, password: sha256.Sum256([]byte("test-password"))}
	r := httptest.NewRequest("GET", "/api/agents/test-agent/session?uid=uid", nil)
	r.SetBasicAuth("admin", "test-password")
	r.Header.Set("Upgrade", "websocket")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("session upgrade accepted: HTTP %d", w.Code)
	}
}

func TestDeleteAcceptsMatchingUIDAndLegacyRequests(t *testing.T) {
	for _, query := range []string{"", "?uid=current-uid"} {
		api := &fakeAPI{uid: "current-uid", state: pb.ActorState_ACTOR_STATE_SUSPENDED}
		s := &server{api: api, password: sha256.Sum256([]byte("test-password"))}
		r := httptest.NewRequest("DELETE", "/api/agents/test-agent"+query, nil)
		r.SetBasicAuth("admin", "test-password")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 200 || !api.gone || strings.Join(api.calls, ",") != "delete" {
			t.Fatalf("valid deletion rejected: HTTP %d calls %v", w.Code, api.calls)
		}
	}
}
func TestDeleteRequiresSuccessfulSuspend(t *testing.T) {
	for _, fail := range []bool{false, true} {
		api := &fakeAPI{state: pb.ActorState_ACTOR_STATE_RUNNING}
		if fail {
			api.suspendError = status.Error(codes.Unavailable, "storage unavailable")
		}
		s := &server{api: api, locks: map[string]*sync.Mutex{}}
		err := s.remove(context.Background(), "test-agent")
		if fail {
			if err == nil || strings.Join(api.calls, ",") != "suspend" {
				t.Fatal("deleted after failed suspend")
			}
		} else if err != nil || strings.Join(api.calls, ",") != "suspend,delete" {
			t.Fatalf("delete sequence: %v %v", api.calls, err)
		}
	}
}

func TestDeleteStoppedActors(t *testing.T) {
	for _, state := range []pb.ActorState{pb.ActorState_ACTOR_STATE_SUSPENDED, pb.ActorState_ACTOR_STATE_CRASHED, pb.ActorState_ACTOR_STATE_DELETING} {
		t.Run(state.String(), func(t *testing.T) {
			api := &fakeAPI{state: state}
			s := &server{api: api}
			if err := s.remove(context.Background(), "test-agent"); err != nil {
				t.Fatal(err)
			}
			if strings.Join(api.calls, ",") != "delete" {
				t.Fatalf("unexpected lifecycle calls: %v", api.calls)
			}
		})
	}
}

func TestDeleteFailureCanBeRetried(t *testing.T) {
	api := &fakeAPI{state: pb.ActorState_ACTOR_STATE_CRASHED, deleteError: status.Error(codes.Unavailable, "storage unavailable")}
	s := &server{api: api}
	if s.remove(context.Background(), "test-agent") == nil || api.gone {
		t.Fatal("failed deletion reported success")
	}
	api.state, api.deleteError = pb.ActorState_ACTOR_STATE_DELETING, nil
	if err := s.remove(context.Background(), "test-agent"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(api.calls, ",") != "delete,delete" {
		t.Fatalf("unexpected lifecycle calls on retry: %v", api.calls)
	}
}

func TestRestoreWithoutSnapshotDoesNotDiscardData(t *testing.T) {
	api := &fakeAPI{state: pb.ActorState_ACTOR_STATE_CRASHED}
	s := &server{api: api, password: sha256.Sum256([]byte("test-password")), locks: map[string]*sync.Mutex{}}
	r := httptest.NewRequest("POST", "/api/agents/test-agent/revert", nil)
	r.SetBasicAuth("admin", "test-password")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "No completed snapshot") || len(api.calls) != 0 {
		t.Fatalf("unsafe restore: status %d, calls %v", w.Code, api.calls)
	}
}

func TestHasDurableSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name      string
		snapshots []*pb.Snapshot
		want      bool
	}{
		{"none", nil, false},
		{"local only", []*pb.Snapshot{{Locality: "node"}}, false},
		{"pending upload", []*pb.Snapshot{{DurableSnapshot: &pb.SnapshotStorage{Status: pb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_PENDING}}}, false},
		{"completed upload", []*pb.Snapshot{{DurableSnapshot: &pb.SnapshotStorage{Status: pb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_COMPLETED}}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasDurableSnapshot(&pb.Actor{Status: &pb.ActorStatus{Snapshots: tc.snapshots}}); got != tc.want {
				t.Fatalf("hasDurableSnapshot = %v, want %v", got, tc.want)
			}
		})
	}
}

func (f *fakeAPI) ResumeActor(context.Context, *pb.ResumeActorRequest, ...grpc.CallOption) (*pb.ResumeActorResponse, error) {
	f.calls = append(f.calls, "resume")
	return &pb.ResumeActorResponse{Actor: &pb.Actor{Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}}, nil
}

func TestSessionAndPrompt(t *testing.T) {
	for _, primaryKind := range []string{"codex", "devin"} {
		t.Run(primaryKind, func(t *testing.T) {
			var calls []string
			upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls = append(calls, r.Method+" "+r.URL.Path)
				if r.Header.Get("ate-target-actor") != "pvm-agents/test-agent" || r.Header.Get("Authorization") != "" {
					t.Error("routing or credential isolation failed")
				}
				for key := range accessTestHeaders {
					if r.Header.Get(key) != "" {
						t.Error("Access identity or credentials reached the runtime:", key)
					}
				}
				switch r.URL.Path {
				case "/auth":
					var auth map[string]any
					json.NewDecoder(r.Body).Decode(&auth)
					tokens := auth["tokens"].(map[string]any)
					if tokens["refresh_token"] != "" || auth["unexpected"] != nil {
						t.Error("central secrets escaped")
					}
					reply(w, map[string]bool{"updated": true})
				case "/session":
					reply(w, map[string]any{"ready": true, "kind": primaryKind, "agents": []map[string]string{{"agent": "codex"}}})
				case "/prompt":
					var body struct {
						Prompt string `json:"prompt"`
					}
					json.NewDecoder(r.Body).Decode(&body)
					if body.Prompt != "a \"quote\"; $(literal)" {
						t.Error("prompt changed")
					}
					w.WriteHeader(202)
					reply(w, map[string]bool{"accepted": true})
				}
			}))
			defer upstream.Close()
			transport := upstream.Client().Transport.(*http.Transport)
			transport.TLSClientConfig.ServerName = "example.com"
			transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
			}
			auth := filepath.Join(t.TempDir(), "auth.json")
			os.WriteFile(auth, []byte(`{"tokens":{"access_token":"access","refresh_token":"central-only","account_id":"account"},"unexpected":"discard"}`), 0600)
			s := &server{api: &fakeAPI{uid: "current-uid", state: pb.ActorState_ACTOR_STATE_RUNNING}, transport: transport, authFile: auth,
				password: sha256.Sum256([]byte("test-password")), locks: map[string]*sync.Mutex{}}
			for _, tc := range []struct {
				method, path, body string
				want               int
			}{
				{"GET", "/api/agents/test-agent/session?uid=current-uid", "", 200},
				{"POST", "/api/agents/test-agent/prompt?uid=current-uid", `{"prompt":"a \"quote\"; $(literal)"}`, 202},
				{"POST", "/api/agents/test-agent/session", `{}`, 404},
				{"POST", "/api/agents", `{"name":"test-agent","kind":"python"}`, 400},
				{"POST", "/api/agents", `{"name":"test-agent","kind":"pi","cwd":"/etc"}`, 400},
			} {
				r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
				r.SetBasicAuth("admin", "test-password")
				for key, value := range accessTestHeaders {
					r.Header.Set(key, value)
				}
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if w.Code != tc.want {
					t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
				}
			}
			if strings.Join(calls, ",") != "GET /session,GET /session,POST /auth,POST /prompt" {
				t.Fatalf("unexpected calls: %v", calls)
			}
		})
	}
}
