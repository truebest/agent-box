package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type createAPI struct {
	pb.ControlClient
	mu      sync.Mutex
	actor   *pb.Actor
	creates int
}

func (api *createAPI) CreateActor(_ context.Context, req *pb.CreateActorRequest, _ ...grpc.CallOption) (*pb.Actor, error) {
	api.mu.Lock()
	defer api.mu.Unlock()
	api.creates++
	if api.actor != nil {
		return nil, status.Error(codes.AlreadyExists, "Sandbox name is already in use")
	}
	api.actor = req.Actor
	api.actor.Metadata.Uid = "new-sandbox-uid"
	api.actor.Status = &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}
	return api.actor, nil
}
func (api *createAPI) CreateActorEgressPolicy(context.Context, *pb.CreateActorEgressPolicyRequest, ...grpc.CallOption) (*pb.EgressPolicy, error) {
	return &pb.EgressPolicy{}, nil
}
func (api *createAPI) ResumeActor(context.Context, *pb.ResumeActorRequest, ...grpc.CallOption) (*pb.ResumeActorResponse, error) {
	return &pb.ResumeActorResponse{Actor: api.actor}, nil
}

func createServer(t *testing.T, session func(), accept bool) (*server, *createAPI, *int) {
	t.Helper()
	prompts := 0
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth", "/runtime/thaw":
			reply(w, map[string]bool{"ready": true})
		case "/session":
			var input createRequest
			json.NewDecoder(r.Body).Decode(&input)
			if session != nil {
				session()
			}
			reply(w, map[string]any{"ready": input.Kind != "none", "server": true, "kind": input.Kind})
		case "/prompt":
			prompts++
			w.WriteHeader(http.StatusAccepted)
			reply(w, map[string]bool{"accepted": accept})
		default:
			t.Error("Unexpected runtime call", r.URL.Path)
		}
	}))
	t.Cleanup(backend.Close)
	transport := backend.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig.ServerName = backend.Certificate().DNSNames[0]
	transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Listener.Addr().String())
	}
	t.Cleanup(transport.CloseIdleConnections)
	auth := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(auth, []byte(`{"tokens":{"access_token":"test-only"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	api := &createAPI{}
	return &server{api: api, transport: transport, authFile: auth, password: sha256.Sum256([]byte("password")), locks: map[string]*sync.Mutex{}}, api, &prompts
}

func createHTTP(s *server, body string, stream bool) *httptest.ResponseRecorder {
	url := "/api/agents"
	if stream {
		url += "?stream=1"
	}
	r := httptest.NewRequest("POST", url, strings.NewReader(body))
	r.SetBasicAuth("admin", "password")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestEmptySandboxCreationNeedsNoProviderCredentials(t *testing.T) {
	s, api, prompts := createServer(t, nil, true)
	s.authFile = filepath.Join(t.TempDir(), "no-provider-credentials")
	w := createHTTP(s, `{"name":"empty-workspace","kind":"none"}`, false)
	if w.Code != http.StatusOK || api.creates != 1 || *prompts != 0 {
		t.Fatalf("empty workspace required provider credentials: HTTP %d %s", w.Code, w.Body.String())
	}
}

func TestCreateStreamsRealStagesAndNeverReplaysPrompt(t *testing.T) {
	s, api, prompts := createServer(t, nil, true)
	body := `{"name":"test-create","kind":"codex","prompt":"private initial task"}`
	w := createHTTP(s, body, true)
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Type"), "ndjson") || strings.Contains(w.Body.String(), "private initial task") {
		t.Fatal("Unsafe progress response", w.Code)
	}
	var done []string
	for _, line := range strings.Split(strings.TrimSpace(w.Body.String()), "\n") {
		var event createEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		if event.Status == "done" {
			done = append(done, event.Stage)
		}
		if event.Type == "complete" && (event.UID != "new-sandbox-uid" || event.PromptDelivery != "accepted") {
			t.Fatal("Completion lacks identity or acceptance")
		}
	}
	if strings.Join(done, ",") != "sandbox,agent,prompt" || *prompts != 1 || api.actor.ActorTemplate.Name != sandboxTemplate() {
		t.Fatal("Incorrect creation sequence")
	}
	createHTTP(s, body, true)
	if *prompts != 1 {
		t.Fatal("Duplicate create resubmitted input")
	}
}

func TestEmptyCreateAndGeneratedNameKeepLegacyActorReply(t *testing.T) {
	s, api, prompts := createServer(t, nil, true)
	w := createHTTP(s, `{"kind":"none"}`, false)
	var actor struct{ Metadata struct{ Name, UID string } }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &actor) != nil || !strings.HasPrefix(actor.Metadata.Name, "sandbox-") || !validName.MatchString(actor.Metadata.Name) || actor.Metadata.UID == "" || *prompts != 0 {
		t.Fatal("Empty create failed", w.Code)
	}
	if consoleKind(api.actor) != "sandbox" {
		t.Fatal("Empty sandbox is hidden from Superterminal and idle controller")
	}
}

func TestCreateValidationRunsBeforeAllocation(t *testing.T) {
	s, api, _ := createServer(t, nil, true)
	for _, body := range []string{`{"kind":"none","prompt":"hello"}`, `{"kind":"none","model":"custom"}`, `{"kind":"other"}`, `{"kind":"pi","cwd":"/workspace/../etc"}`, `{"kind":"codex","model":"bad\nmodel"}`, `{"kind":"codex","prompt":"\u0000"}`, `{"kind":"codex"} {}`} {
		if w := createHTTP(s, body, true); w.Code != 400 {
			t.Fatal("Invalid creation accepted", body, w.Code)
		}
	}
	if api.creates != 0 {
		t.Fatal("Validation allocated a sandbox")
	}
}

func TestUnconfirmedInitialPromptIsNotRetried(t *testing.T) {
	s, _, prompts := createServer(t, nil, false)
	w := createHTTP(s, `{"name":"test-create","kind":"pi","prompt":"private task"}`, true)
	if *prompts != 1 || !strings.Contains(w.Body.String(), `"prompt_delivery":"uncertain"`) || !strings.Contains(w.Body.String(), `"type":"error"`) || !strings.Contains(w.Body.String(), `"uid":"new-sandbox-uid"`) {
		t.Fatal("Uncertain delivery lost its resource or was retried")
	}
}

func TestAdmittedCreateFinishesAfterBrowserDisconnect(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	s, _, prompts := createServer(t, func() { close(entered); <-release }, true)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/agents?stream=1", strings.NewReader(`{"name":"test-create","kind":"codex","prompt":"hello"}`)).WithContext(ctx)
	r.SetBasicAuth("admin", "password")
	done := make(chan struct{})
	go func() { s.ServeHTTP(httptest.NewRecorder(), r); close(done) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		cancel()
		close(release)
		t.Fatal("Creation did not reach the runtime")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Browser stream did not close")
	}
	close(release)
	// Taking the same lock waits for the detached creation to finish.
	unlock := s.lock("test-create")
	unlock()
	if *prompts != 1 {
		t.Fatal("Disconnected browser canceled or repeated the initial task")
	}
}

func TestDevinCreateUsesItsOwnAuthenticationAndModelDefault(t *testing.T) {
	s, _, prompts := createServer(t, nil, true)
	s.authFile = filepath.Join(t.TempDir(), "no-codex-credentials")
	w := createHTTP(s, `{"name":"devin-native","kind":"devin"}`, false)
	if w.Code != 200 || *prompts != 0 {
		t.Fatalf("Devin creation inherited native auth or failed: %d %s", w.Code, w.Body.String())
	}
	data := createRequest{Kind: "devin"}
	if err := data.validate(); err != nil || data.Model != "" || data.Cwd != "/workspace" {
		t.Fatal("Devin model default changed", data, err)
	}
}

func TestDevinSetupKeepsSandboxAndDoesNotSendInitialPrompt(t *testing.T) {
	for _, prompt := range []bool{false, true} {
		t.Run(fmt.Sprint(prompt), func(t *testing.T) {
			api := &createAPI{}
			unexpected := 0
			backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/runtime/thaw":
					reply(w, map[string]bool{"ready": true})
				case "/session":
					reply(w, map[string]any{"server": true, "kind": "devin", "started": true, "ready": false, "error": "Complete Devin CLI sign-in in Superterminal"})
				default:
					unexpected++
					w.WriteHeader(500)
				}
			}))
			defer backend.Close()
			transport := backend.Client().Transport.(*http.Transport).Clone()
			transport.TLSClientConfig.ServerName = backend.Certificate().DNSNames[0]
			transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Listener.Addr().String())
			}
			defer transport.CloseIdleConnections()
			s := &server{api: api, transport: transport, authFile: "missing", password: sha256.Sum256([]byte("password")), locks: map[string]*sync.Mutex{}}
			body := `{"name":"devin-setup","kind":"devin"}`
			if prompt {
				body = `{"name":"devin-setup","kind":"devin","prompt":"do not send to login"}`
			}
			w := createHTTP(s, body, true)
			if unexpected != 0 || api.creates != 1 || api.actor.GetMetadata().GetUid() != "new-sandbox-uid" {
				t.Fatal("Setup replayed or used another auth provider")
			}
			if prompt && (!strings.Contains(w.Body.String(), "not_sent") || !strings.Contains(w.Body.String(), "Complete Devin CLI sign-in") || strings.Contains(w.Body.String(), "do not send to login")) {
				t.Fatal("Initial prompt was not safely rejected", w.Body.String())
			}
			if !prompt && !strings.Contains(w.Body.String(), `"type":"complete"`) {
				t.Fatal("Setup menu was treated as failed creation", w.Body.String())
			}
			if _, err := s.resume(context.Background(), "devin-setup"); err != nil || unexpected != 0 {
				t.Fatal("Restoring Devin used another provider's authentication", err)
			}
			if err := s.inject(context.Background(), "devin-setup"); err != nil || unexpected != 0 {
				t.Fatal("Background or prompt auth refresh used another provider", err)
			}
		})
	}
}

func TestConsoleLaunchPreparesOAuthBeforeCreatingSecondaryAgents(t *testing.T) {
	for _, path := range []string{"/api/workspace/create", "/api/tab/create", "/api/worktree/create", "/api/worktree/open", "/api/machines/local/workspace/create", "/api/machines/local/tab/create", "/api/machines/local/worktree/create", "/api/machines/local/worktree/open"} {
		for _, kind := range []string{"codex", "pi"} {
			t.Run(path+"/"+kind, func(t *testing.T) {
				var calls atomic.Int32
				backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != "POST" || r.URL.Path != "/auth" {
						t.Errorf("Unexpected prelaunch request: %s %s", r.Method, r.URL.Path)
					}
					calls.Add(1)
					reply(w, map[string]bool{"ready": true})
				}))
				defer backend.Close()
				transport := backend.Client().Transport.(*http.Transport).Clone()
				transport.TLSClientConfig.ServerName = backend.Certificate().DNSNames[0]
				transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Listener.Addr().String())
				}
				defer transport.CloseIdleConnections()
				auth := filepath.Join(t.TempDir(), "auth.json")
				if err := os.WriteFile(auth, []byte(`{"tokens":{"access_token":"test-only"}}`), 0600); err != nil {
					t.Fatal(err)
				}
				s := &server{api: &fakeAPI{uid: "expected-uid", state: pb.ActorState_ACTOR_STATE_RUNNING}, transport: transport, authFile: auth, locks: map[string]*sync.Mutex{}}
				body := fmt.Sprintf(`{"cwd":"/workspace","agent":{"kind":%q},"label":"keep this payload"}`, kind)
				request := httptest.NewRequest("POST", path, strings.NewReader(body))
				if err := s.prepareBridgeLaunch(request, "test-agent", "expected-uid", path); err != nil || calls.Load() != 1 {
					t.Fatal("Native OAuth not delivered before launch", err, calls.Load())
				}
				retained, _ := io.ReadAll(request.Body)
				if string(retained) != body {
					t.Fatal("Console launch payload changed")
				}
				s.authFile = "missing"
				request = httptest.NewRequest("POST", path, strings.NewReader(`{"agent":{"kind":"devin"}}`))
				if err := s.prepareBridgeLaunch(request, "test-agent", "expected-uid", path); err != nil || calls.Load() != 1 {
					t.Fatal("Devin-only launch requires Codex OAuth", err)
				}
			})
		}
	}
}
