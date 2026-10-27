package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
)

func TestConsoleBridgeTokenSurvivesPanelPasswordChange(t *testing.T) {
	key := sha256.Sum256([]byte("existing-password"))
	s := &server{password: key, bridgeKey: key[:]}
	token := s.bridgeToken("sandbox-uid")
	s.password = sha256.Sum256([]byte("replacement-password"))
	if s.bridgeToken("sandbox-uid") != token {
		t.Fatal("Login password rotation broke existing bridge and snapshot credentials")
	}
	if s.bridgeToken("another-sandbox-uid") == token {
		t.Fatal("Bridge credential escaped its sandbox UID")
	}
	s.bridgeKey = []byte("another-bridge-key")
	if s.bridgeToken("sandbox-uid") == token {
		t.Fatal("Bridge credential did not use its independent key")
	}
}

func TestConsoleProxyUsesFixedPortAndPrivateCredential(t *testing.T) {
	password := sha256.Sum256([]byte("password"))
	s := &server{api: &consoleAPI{actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}}}, consoleEnabled: true, password: password}
	var attempts atomic.Int32
	router := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != "test-agent:7317" || r.Header.Get("ate-target-actor") != "pvm-agents/test-agent" {
			t.Errorf("untrusted tunnel destination: %s %s %v", r.Method, r.Host, r.Header)
		}
		conn, buffer, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		defer conn.Close()
		buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		buffer.Flush()
		inner, e := http.ReadRequest(bufio.NewReader(conn))
		if e != nil {
			t.Error(e)
			return
		}
		if inner.URL.Path != "/api/session" || inner.Host != "127.0.0.1:7317" || inner.Header.Get("Authorization") != "Bearer "+s.bridgeToken("uid") || inner.Header.Get("Cookie") != "" || inner.Header.Get("ate-target-actor") != "" || inner.Header.Get("X-Forwarded-Host") != "" || inner.Header.Get("Origin") != "http://127.0.0.1:7317" {
			t.Errorf("bridge credentials or routing leaked: path %s host %s", inner.URL.Path, inner.Host)
		}
		for key := range accessTestHeaders {
			if inner.Header.Get(key) != "" || r.Header.Get(key) != "" {
				t.Error("Access identity or credentials reached the bridge:", key)
			}
		}
		if attempts.Add(1) == 1 {
			fmt.Fprint(conn, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
		} else {
			fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: unwanted=yes\r\n\r\nok")
		}
	}))
	defer router.Close()
	config := router.Client().Transport.(*http.Transport).TLSClientConfig
	s.transport = &http.Transport{TLSClientConfig: config, DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "atenet-router.ate-system.svc:8444" {
			t.Errorf("router: %s", address)
		}
		return (&tls.Dialer{Config: config}).DialContext(ctx, network, router.Listener.Addr().String())
	}}
	r := httptest.NewRequest("GET", "/api/console/agents/test-agent/uid/bridge/api/session?host=evil&port=22", nil)
	r.SetBasicAuth("admin", "password")
	r.Header.Set("Cookie", "panel=private")
	r.Header.Set("ate-target-actor", "other/agent")
	r.Header.Set("X-Forwarded-Host", "evil")
	for key, value := range accessTestHeaders {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != "ok" || w.Header().Get("Set-Cookie") != "" || attempts.Load() != 2 {
		t.Fatalf("proxy: %d %s", w.Code, w.Body.String())
	}
}

func TestConsoleWaitsForAuthenticatedBridgeRoute(t *testing.T) {
	s := &server{api: &consoleAPI{actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}}}}
	var calls atomic.Int32
	router := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Host != "test-agent:7317" {
			t.Error("Unexpected bridge destination")
		}
		conn, buffer, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		defer conn.Close()
		buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		buffer.Flush()
		request, e := http.ReadRequest(bufio.NewReader(conn))
		if e != nil {
			t.Error(e)
			return
		}
		if request.URL.Path != "/api/health" || request.Header.Get("Authorization") != "Bearer "+s.bridgeToken("uid") {
			t.Error("Missing UID-bound health check")
		}
		if calls.Add(1) == 1 {
			fmt.Fprint(conn, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
		} else {
			fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}")
		}
	}))
	defer router.Close()
	config := router.Client().Transport.(*http.Transport).TLSClientConfig
	s.transport = &http.Transport{TLSClientConfig: config, DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&tls.Dialer{Config: config}).DialContext(ctx, network, router.Listener.Addr().String())
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if e := s.waitBridge(ctx, "test-agent", "uid"); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 2 {
		t.Fatalf("Expected stale route followed by authenticated bridge, got %d requests", calls.Load())
	}
}

type consoleAPI struct {
	pb.ControlClient
	actors  []*pb.Actor
	workers []*pb.Worker
	calls   int
}

func (a *consoleAPI) GetActor(context.Context, *pb.GetActorRequest, ...grpc.CallOption) (*pb.Actor, error) {
	a.calls++
	return a.actors[0], nil
}
func (a *consoleAPI) ListActors(context.Context, *pb.ListActorsRequest, ...grpc.CallOption) (*pb.ListActorsResponse, error) {
	return &pb.ListActorsResponse{Actors: a.actors}, nil
}
func (a *consoleAPI) ListWorkers(context.Context, *pb.ListWorkersRequest, ...grpc.CallOption) (*pb.ListWorkersResponse, error) {
	return &pb.ListWorkersResponse{Workers: a.workers}, nil
}

func consoleRequest(s *server, method, path, origin, password string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("Origin", origin)
	r.SetBasicAuth("admin", password)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestSavedHistoryRoutesAreRemoved(t *testing.T) {
	api := &consoleAPI{}
	s := &server{api: api, consoleEnabled: true, origin: "https://panel.test", password: sha256.Sum256([]byte("password"))}
	path := "/api/console/agents/test-agent/uid/history?pane=chat&page=0"
	for _, method := range []string{"GET", "HEAD", "POST"} {
		if w := consoleRequest(s, method, path, s.origin, "password"); w.Code != http.StatusNotFound {
			t.Fatal("Removed saved-chat endpoint is still exposed", method, w.Code)
		}
	}
	if w := consoleRequest(s, "GET", path, "", ""); w.Code != http.StatusUnauthorized {
		t.Fatal("Authentication no longer protects removed endpoints")
	}
	if w := consoleRequest(s, "GET", path, "https://evil.test", "password"); w.Code != http.StatusForbidden {
		t.Fatal("Origin validation changed")
	}
	if api.calls != 0 {
		t.Fatal("Removed history route contacted a sandbox")
	}
}

func TestConsoleAuthorizationAndUID(t *testing.T) {
	a := &consoleAPI{actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "new-uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_SUSPENDED}}}}
	s := &server{api: a, consoleEnabled: true, origin: "https://panel.test", password: sha256.Sum256([]byte("password"))}
	for _, tc := range []struct {
		method, path, origin, password string
		want                           int
	}{
		{"GET", "/api/console", "", "", 401},
		{"GET", "/api/console/ui/", "", "", 401},
		{"GET", "/console-assets/assets/test.js", "", "", 401},
		{"GET", "/api/console/agents/test-agent/new-uid/ui/", "", "", 401},
		{"POST", "/api/console/agents/test-agent/new-uid/connect", "https://evil.test", "password", 403},
		{"GET", "/api/console/agents/test-agent/old-uid/bridge/ws", "", "password", 404},
		{"POST", "/api/console/agents/test-agent/old-uid/resume", "", "password", 404},
		{"GET", "/api/console/agents/test-agent/new-uid/ui/", "", "password", 409},
	} {
		w := consoleRequest(s, tc.method, tc.path, tc.origin, tc.password)
		if w.Code != tc.want {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
	if s.bridgeToken("old-uid") == s.bridgeToken("new-uid") {
		t.Fatal("bridge credentials must be bound to UID")
	}
	for _, origin := range []string{"", "https://evil.test"} {
		r := httptest.NewRequest("GET", "/api/console/agents/test-agent/new-uid/bridge/ws", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("Upgrade", "websocket")
		r.SetBasicAuth("admin", "password")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("WebSocket Origin check bypassed")
		}
	}
}

func TestConsoleNavigationShellNeedsNoAgent(t *testing.T) {
	s := &server{consoleEnabled: true, password: sha256.Sum256([]byte("password"))}
	for _, method := range []string{"GET", "HEAD"} {
		w := consoleRequest(s, method, "/api/console/ui/", "", "password")
		if w.Code != 200 {
			t.Fatalf("navigation shell: %d %s", w.Code, w.Body.String())
		}
	}
	s.consoleEnabled = false
	if w := consoleRequest(s, "GET", "/api/console/ui/", "", "password"); w.Code != 404 {
		t.Fatal("disabled navigation shell exposed")
	}
}

func TestConsoleListsOnlyOurWorkersAndKeepsSuspended(t *testing.T) {
	t.Setenv("PANEL_HOST", "test-host")
	ours := &pb.Worker{Metadata: &pb.ResourceMetadata{Name: "ours"}, WorkerNamespace: space, WorkerPool: "agents", Labels: map[string]string{"workload": space}, Status: &pb.WorkerStatus{State: pb.WorkerState_WORKER_STATE_ACTIVE}}
	other := &pb.Worker{Metadata: &pb.ResourceMetadata{Name: "other"}, WorkerNamespace: "other", WorkerPool: "agents", Labels: map[string]string{"workload": space}}
	a := &consoleAPI{workers: []*pb.Worker{ours, other}, actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_SUSPENDED}}}}
	s := &server{api: a, consoleEnabled: true, password: sha256.Sum256([]byte("password"))}
	w := consoleRequest(s, "GET", "/api/console", "", "password")
	var result struct {
		Hosts   []consoleHost
		Workers []consoleWorker
		Agents  []consoleAgent
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Workers) != 1 || len(result.Agents) != 1 || result.Agents[0].Sandbox != "SUSPENDED" || result.Agents[0].Runner != "stopped" {
		t.Fatalf("pool: %s", w.Body.String())
	}
	if len(result.Hosts) != 1 || result.Hosts[0].ID != "test-host" || result.Hosts[0].Name != "test-host" || result.Workers[0].Host != "test-host" || result.Agents[0].Host != "test-host" {
		t.Fatalf("host ownership: %s", w.Body.String())
	}
	t.Setenv("PANEL_HOST", "")
	w = consoleRequest(s, "GET", "/api/console", "", "password")
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Hosts[0].ID != "agent-box-host" || result.Workers[0].Host != "agent-box-host" || result.Agents[0].Host != "agent-box-host" {
		t.Fatalf("default host: %s", w.Body.String())
	}
	s.consoleEnabled = false
	w = consoleRequest(s, "GET", "/api/console", "", "password")
	if !strings.Contains(w.Body.String(), `"enabled":false`) || !strings.Contains(w.Body.String(), `"hosts":[]`) {
		t.Fatal("compatibility gate bypassed")
	}
	w = consoleRequest(s, "GET", "/api/console/agents/test-agent/uid/ui/", "", "password")
	if w.Code != 404 {
		t.Fatal("disabled console exposed")
	}
}

func TestConsoleDistinguishesReadyAndDone(t *testing.T) {
	var activity string
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/session" {
			t.Errorf("unexpected status probe: %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"runner": map[string]string{"agent_status": activity}})
	}))
	defer backend.Close()
	config := backend.Client().Transport.(*http.Transport).TLSClientConfig
	s := &server{
		api:            &consoleAPI{actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}}},
		consoleEnabled: true, password: sha256.Sum256([]byte("password")),
		transport: &http.Transport{TLSClientConfig: config, DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&tls.Dialer{Config: config}).DialContext(ctx, network, backend.Listener.Addr().String())
		}},
	}
	defer s.transport.CloseIdleConnections()
	for _, check := range []struct{ activity, runner string }{
		{"working", "busy"}, {"blocked", "waiting for input"}, {"idle", "running"}, {"done", "done"}, {"unexpected", "unknown"},
	} {
		t.Run(check.activity, func(t *testing.T) {
			activity = check.activity
			w := consoleRequest(s, "GET", "/api/console", "", "password")
			var result struct{ Agents []consoleAgent }
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Agents) != 1 || result.Agents[0].Runner != check.runner {
				t.Fatalf("activity %s: HTTP %d %s", activity, w.Code, w.Body.String())
			}
		})
	}
}
