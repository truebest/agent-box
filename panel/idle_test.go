package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"github.com/gorilla/websocket"
	"google.golang.org/grpc"
)

func TestIdleClock(t *testing.T) {
	s := &server{idleTimeout: 15 * time.Minute}
	start := time.Now()
	if s.observeIdle("one", "r1", true, start) {
		t.Fatal("first sight suspended")
	}
	if s.observeIdle("one", "r1", true, start.Add(15*time.Minute-time.Nanosecond)) {
		t.Fatal("early suspend")
	}
	s.touch("one", start.Add(14*time.Minute))
	if s.observeIdle("one", "r1", true, start.Add(15*time.Minute)) {
		t.Fatal("user input ignored")
	}
	if !s.observeIdle("one", "r1", true, start.Add(29*time.Minute)) {
		t.Fatal("idle deadline missed")
	}
	if s.touch("one", start.Add(30*time.Minute)) {
		t.Fatal("input admitted during checkpoint")
	}
	if s.observeIdle("replacement", "r1", true, start.Add(30*time.Minute)) {
		t.Fatal("name reuse inherited clock")
	}
	for _, busy := range []bool{true, false} {
		q := &server{idleTimeout: 15 * time.Minute}
		q.observeIdle("one", "r1", true, start)
		signature := "r2"
		quiet := true
		if busy {
			signature = "r1"
			quiet = false
		}
		if q.observeIdle("one", signature, quiet, start.Add(16*time.Minute)) {
			t.Fatal("agent activity ignored")
		}
		if q.observeIdle("one", signature, true, start.Add(20*time.Minute)) {
			t.Fatal("did not wait after activity")
		}
	}
	d, e := idleTimeout("")
	if e != nil || d != 15*time.Minute {
		t.Fatal("wrong production default")
	}
	if _, e = idleTimeout("-1m"); e == nil {
		t.Fatal("negative policy accepted")
	}
	if _, e = idleTimeout("bad"); e == nil {
		t.Fatal("invalid policy accepted")
	}
}

func TestUnknownRuntimeStateBlocksSuspend(t *testing.T) {
	for _, response := range []struct {
		code int
		body string
	}{
		{404, "not found"}, {500, "failed"}, {200, "bad"}, {200, `{"quiet":true}`},
	} {
		router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/runtime/") {
				t.Errorf("Legacy fallback: %s", r.URL.Path)
			}
			w.WriteHeader(response.code)
			w.Write([]byte(response.body))
		}))
		s := &server{transport: &http.Transport{DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(router.URL, "http://"))
		}}}
		if _, quiet, e := s.probeIdle(context.Background(), "test-agent", "uid"); e == nil || quiet {
			t.Fatal("Unknown idle state accepted")
		}
		if response.code != 200 && s.runtimeGate(context.Background(), "test-agent", true) == nil {
			t.Fatal("Unsupported freeze accepted")
		}
		router.Close()
	}
}

func TestIdleRefinesLateAgentProcessesThroughAuthenticatedUIDBridge(t *testing.T) {
	for _, result := range []struct {
		code  int
		body  string
		quiet bool
	}{
		{200, `{"quiet":true,"signature":"managed-agents"}`, true},
		{200, `{"quiet":false,"signature":"background-task"}`, false},
		{200, `{"quiet":true}`, false},
		{200, `{"quiet":true,"signature":"busy","control_busy":true}`, false},
		{503, `{"error":"ownership unavailable"}`, false},
	} {
		s := &server{api: &consoleAPI{actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}}}}
		router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == "GET" && r.URL.Path == "/runtime/idle" {
				reply(w, map[string]any{"quiet": false, "signature": `[[{"pane_id":"w1:p2","agent":"codex","agent_status":"done"}],[[621,"12"]]]`})
				return
			}
			if r.Method != "CONNECT" || r.Host != "test-agent:7317" || r.Header.Get("ate-target-actor") != "pvm-agents/test-agent" {
				t.Error("Idle ownership probe used an unexpected destination")
			}
			connection, buffer, e := w.(http.Hijacker).Hijack()
			if e != nil {
				t.Error(e)
				return
			}
			defer connection.Close()
			buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
			buffer.Flush()
			request, e := http.ReadRequest(bufio.NewReader(connection))
			if e != nil {
				t.Error(e)
				return
			}
			if request.Method != "GET" || request.URL.Path != "/api/idle" || request.Header.Get("Authorization") != "Bearer "+s.bridgeToken("uid") {
				t.Error("Idle probe lost its UID credential or read conversation data")
			}
			fmt.Fprintf(connection, "HTTP/1.1 %d Test\r\nContent-Length: %d\r\n\r\n%s", result.code, len(result.body), result.body)
		}))
		s.transport = &http.Transport{DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, router.Listener.Addr().String())
		}}
		_, quiet, _ := s.probeIdle(context.Background(), "test-agent", "uid")
		if quiet != result.quiet {
			t.Fatalf("Incorrect quiet result for %s", result.body)
		}
		router.Close()
	}
}

type idleAPI struct {
	pb.ControlClient
	actor   *pb.Actor
	stopped int
	fail    bool
}

func (a *idleAPI) GetActor(context.Context, *pb.GetActorRequest, ...grpc.CallOption) (*pb.Actor, error) {
	return a.actor, nil
}
func (a *idleAPI) GetActorTemplate(context.Context, *pb.GetActorTemplateRequest, ...grpc.CallOption) (*pb.ActorTemplate, error) {
	return &pb.ActorTemplate{SnapshotConfig: &pb.SnapshotConfig{PreferredFidelity: pb.SnapshotFidelity_SNAPSHOT_FIDELITY_MEMORY, StorageLocation: "s3://test/snapshots/"}}, nil
}
func (a *idleAPI) SuspendActor(context.Context, *pb.SuspendActorRequest, ...grpc.CallOption) (*pb.SuspendActorResponse, error) {
	a.stopped++
	if a.fail {
		return nil, errors.New("storage unavailable")
	}
	return &pb.SuspendActorResponse{Actor: &pb.Actor{Metadata: a.actor.Metadata, Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_SUSPENDED, Snapshots: []*pb.Snapshot{{Fidelity: pb.SnapshotFidelity_SNAPSHOT_FIDELITY_MEMORY, DurableSnapshot: &pb.SnapshotStorage{Status: pb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_COMPLETED}}}}}}, nil
}

func TestIdleSuspendRechecksUIDAndRequiresDurableSnapshot(t *testing.T) {
	for _, failure := range []bool{false, true} {
		actor := &pb.Actor{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}
		api := &idleAPI{actor: actor, fail: failure}
		router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/runtime/idle":
				reply(w, map[string]any{"quiet": true, "signature": "idle"})
			case "/runtime/freeze", "/runtime/thaw":
				reply(w, map[string]bool{"ok": true})
			default:
				t.Errorf("Unexpected runtime endpoint: %s", r.URL.Path)
				http.NotFound(w, r)
			}
		}))
		s := &server{api: api, idleTimeout: 15 * time.Minute, transport: &http.Transport{DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(router.URL, "http://"))
		}}}
		if e := s.suspendIdle(context.Background(), actor); e != nil {
			t.Fatal(e)
		}
		if api.stopped != 0 {
			t.Fatal("no initial grace period")
		}
		s.activity["uid"].last = time.Now().Add(-16 * time.Minute)
		e := s.suspendIdle(context.Background(), actor)
		if (e != nil) != failure || api.stopped != 1 {
			t.Fatal("snapshot result ignored", e)
		}
		if s.activity["uid"].suspending {
			t.Fatal("failure blocked further use")
		}
		stale := &pb.Actor{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "old"}}
		if e := s.suspendIdle(context.Background(), stale); e != nil || api.stopped != 1 {
			t.Fatal("stale UID suspended replacement")
		}
		router.Close()
	}
}

func TestOnlyUserSocketFramesRefreshClock(t *testing.T) {
	for _, x := range []struct {
		legacy bool
		kind   int
		data   string
		want   bool
	}{
		{false, websocket.TextMessage, `{"type":"input","data":"hi"}`, true},
		{false, websocket.TextMessage, `{"type":"keys"}`, true},
		{false, websocket.TextMessage, `{"type":"submit"}`, true},
		{false, websocket.TextMessage, `{"type":"ack"}`, false},
		{false, websocket.TextMessage, `{"type":"resize"}`, false},
		{false, websocket.TextMessage, `{"type":"attach"}`, false},
		{false, websocket.TextMessage, `{"type":"ping"}`, false},
		{true, websocket.BinaryMessage, "0hello", true},
		{true, websocket.BinaryMessage, `1{"columns":80}`, false},
		{true, websocket.BinaryMessage, `{"AuthToken":""}`, false},
	} {
		if inputMessage(x.legacy, x.kind, []byte(x.data)) != x.want {
			t.Fatal(x.data)
		}
	}
}

func TestSocketForwardsOnceAndIgnoresPolling(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private" || r.Header.Get("Cookie") != "" {
			t.Error("credential boundary changed")
		}
		c, e := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer c.Close()
		for {
			kind, data, e := c.ReadMessage()
			if e != nil {
				return
			}
			if c.WriteMessage(kind, data) != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	s := &server{api: &fakeAPI{uid: "uid"}, origin: "https://panel.test", idleTimeout: 15 * time.Minute}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.socket(w, r, "test-agent", "uid", "ws"+strings.TrimPrefix(upstream.URL, "http"), http.Header{"Authorization": []string{"Bearer private"}}, websocket.Dialer{}, false)
	}))
	defer proxy.Close()
	c, _, e := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(proxy.URL, "http"), http.Header{"Origin": []string{s.origin}, "Cookie": []string{"private=browser"}})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	for _, kind := range []string{"ping", "ack", "resize", "submit"} {
		data, _ := json.Marshal(map[string]string{"type": kind, "data": "unsent-test"})
		if e = c.WriteMessage(websocket.TextMessage, data); e != nil {
			t.Fatal(e)
		}
		_, echo, e := c.ReadMessage()
		if e != nil || string(echo) != string(data) {
			t.Fatal("message changed or duplicated", e)
		}
		s.mu.Lock()
		entry := s.activity["uid"]
		s.mu.Unlock()
		if (entry != nil) != (kind == "submit") {
			t.Fatal("keepalive counted as activity")
		}
	}
	s.mu.Lock()
	s.activity["uid"].suspending = true
	s.mu.Unlock()
	s.closeIdleSockets("uid")
	c.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, e = c.ReadMessage(); e == nil {
		t.Fatal("socket survived checkpoint admission")
	}

}

func TestPolicyTemplatePrefixIsAnExactBoundary(t *testing.T) {
	old := templatePrefix
	templatePrefix = "verify-idle-"
	defer func() { templatePrefix = old }()
	for _, name := range []string{"codex", "pi", "other-codex", "sandbox-v1", "sandbox-v1-abcdefabcdef"} {
		if consoleKind(&pb.Actor{ActorTemplate: ref(name)}) != "" {
			t.Fatal("candidate policy matched a user template", name)
		}
	}
	if consoleKind(&pb.Actor{ActorTemplate: ref("verify-idle-pi")}) != "pi" {
		t.Fatal("test template did not match")
	}
	t.Setenv("SANDBOX_TEMPLATE", "verify-idle-sandbox-v1")
	if consoleKind(&pb.Actor{ActorTemplate: ref("verify-idle-sandbox-v1")}) != "sandbox" {
		t.Fatal("Candidate excluded its own sandbox template")
	}
}

func TestSuspendDoesNotReadChatLogs(t *testing.T) {
	for _, manual := range []bool{false, true} {
		actor := &pb.Actor{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}
		api := &idleAPI{actor: actor}
		var frozen atomic.Bool
		router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/runtime/idle":
				reply(w, map[string]any{"quiet": true, "signature": "idle"})
			case "/runtime/freeze":
				frozen.Store(true)
				reply(w, map[string]bool{"frozen": true})
			default:
				t.Errorf("Suspend read chat data or accessed another endpoint: %s", r.URL.Path)
				w.WriteHeader(http.StatusInternalServerError)
			}
		}))
		defer router.Close()
		s := &server{api: api, password: sha256.Sum256([]byte("password")), idleTimeout: time.Minute, transport: &http.Transport{DialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(router.URL, "http://"))
		}}}
		if manual {
			if w := consoleRequest(s, "POST", "/api/agents/test-agent/suspend", "", "password"); w.Code != http.StatusOK {
				t.Fatal("Manual suspend failed", w.Code, w.Body.String())
			}
		} else {
			s.observeIdle("uid", "idle", true, time.Now().Add(-2*time.Minute))
			if e := s.suspendIdle(context.Background(), actor); e != nil {
				t.Fatal(e)
			}
		}
		if !frozen.Load() || api.stopped != 1 || s.activity["uid"].suspending {
			t.Fatal("Suspend did not preserve its admission gate or snapshot flow")
		}
	}
}
