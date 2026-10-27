package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

//go:embed console/dist
var consoleWeb embed.FS

//go:embed console/install.py
var consoleInstaller string

type consoleAgent struct {
	Host    string `json:"host"`
	Name    string `json:"name"`
	UID     string `json:"uid"`
	Kind    string `json:"kind"`
	Sandbox string `json:"sandbox"`
	Runner  string `json:"runner"`
	Worker  string `json:"worker"`
	Error   string `json:"error,omitempty"`
}

type consoleWorker struct {
	Host      string            `json:"host"`
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	State     string            `json:"state"`
	Agents    int32             `json:"agents"`
	Capacity  map[string]string `json:"capacity"`
	Allocated map[string]string `json:"allocated"`
}

type consoleHost struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func resourceValues(resources *pb.WorkerResources) map[string]string {
	result := map[string]string{"cpu": "0", "memory": "0"}
	for _, limit := range resources.GetResources().GetLimits() {
		result[limit.GetName()] = limit.GetQuantity()
	}
	return result
}

var versionedSandboxTemplate = regexp.MustCompile(`^sandbox-v1-[a-f0-9]{12}$`)

func consoleKind(actor *pb.Actor) string {
	if name := actor.GetActorTemplate().GetName(); strings.HasPrefix(name, templatePrefix) && strings.HasPrefix(strings.TrimPrefix(name, templatePrefix), "profile-") {
		return "sandbox"
	}
	if name := actor.GetActorTemplate().GetName(); name == sandboxTemplate() && strings.HasPrefix(name, templatePrefix) || templatePrefix == "" && (name == "sandbox-v1" || versionedSandboxTemplate.MatchString(name)) {
		return "sandbox"
	}
	if !strings.HasPrefix(actor.GetActorTemplate().GetName(), templatePrefix) {
		return ""
	}
	kind := strings.TrimPrefix(actor.GetActorTemplate().GetName(), templatePrefix)
	if kinds[kind] {
		return kind
	}
	return ""
}

func (s *server) actorKinds(ctx context.Context) (func(*pb.Actor) string, error) {
	if s.workerManager == nil {
		return consoleKind, nil
	}
	_, catalog, err := s.workerManager.read(ctx)
	if err != nil {
		return nil, err
	}
	return func(actor *pb.Actor) string {
		if _, ok := catalog.Bindings[actor.GetActorTemplate().GetName()]; !ok {
			return ""
		}
		if kind := consoleKind(actor); kind != "" {
			return kind
		}
		return "sandbox"
	}, nil
}

func (s *server) consoleList(w http.ResponseWriter, r *http.Request) {
	workers := []consoleWorker{}
	agents := []consoleAgent{}
	hosts := []consoleHost{}
	if !s.consoleEnabled {
		reply(w, map[string]any{"enabled": false, "hosts": hosts, "workers": workers, "agents": agents})
		return
	}
	host := os.Getenv("PANEL_HOST")
	if host == "" {
		host = "agent-box-host"
	}
	hosts = append(hosts, consoleHost{ID: host, Name: host})
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	kind, err := s.actorKinds(ctx)
	if err != nil {
		s.fail(w, err)
		return
	}
	for token := ""; ; {
		page, e := s.api.ListWorkers(ctx, &pb.ListWorkersRequest{Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
		if e != nil {
			s.fail(w, e)
			return
		}
		for _, worker := range page.GetWorkers() {
			if worker.GetWorkerNamespace() != space || (worker.GetWorkerPool() != "agents" || worker.GetLabels()["workload"] != space) && worker.GetLabels()[managedLabel] != "true" {
				continue
			}
			state := worker.GetStatus()
			workers = append(workers, consoleWorker{Host: host, ID: worker.GetMetadata().GetName(), Name: worker.GetWorkerPod(),
				State: strings.TrimPrefix(state.GetState().String(), "WORKER_STATE_"), Agents: state.GetAllocated().GetActors(),
				Capacity: resourceValues(state.GetCapacity()), Allocated: resourceValues(state.GetAllocated())})
		}
		token = page.GetNextPageToken()
		if token == "" {
			break
		}
	}
	for token := ""; ; {
		page, e := s.api.ListActors(ctx, &pb.ListActorsRequest{Atespace: space, Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
		if e != nil {
			s.fail(w, e)
			return
		}
		for _, actor := range page.GetActors() {
			if kind(actor) == "" {
				continue
			}
			state := actor.GetStatus()
			agents = append(agents, consoleAgent{Host: host, Name: actor.GetMetadata().GetName(), UID: actor.GetMetadata().GetUid(), Kind: kind(actor),
				Sandbox: strings.TrimPrefix(state.GetState().String(), "ACTOR_STATE_"), Runner: "stopped", Worker: state.GetWorkerAssignment().GetWorker().GetName()})
		}
		token = page.GetNextPageToken()
		if token == "" {
			break
		}
	}
	var wg sync.WaitGroup
	limit := make(chan struct{}, 4)
	for i := range agents {
		if agents[i].Sandbox != "RUNNING" {
			continue
		}
		wg.Add(1)
		go func(agent *consoleAgent) {
			defer wg.Done()
			select {
			case limit <- struct{}{}:
				defer func() { <-limit }()
			case <-ctx.Done():
				agent.Runner = "error"
				return
			}
			probe, done := context.WithTimeout(ctx, 5*time.Second)
			defer done()
			response, e := s.workload(probe, agent.Name, "GET", "/session", nil)
			if e != nil {
				agent.Runner, agent.Error = "error", "Session unavailable"
				return
			}
			defer response.Body.Close()
			var session struct {
				Kind   string `json:"kind"`
				Runner *struct {
					Status string `json:"agent_status"`
				} `json:"runner"`
			}
			if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&session) != nil {
				agent.Runner, agent.Error = "error", "Session unavailable"
			} else if session.Runner != nil {
				if kinds[session.Kind] {
					agent.Kind = session.Kind
				}
				switch session.Runner.Status {
				case "working":
					agent.Runner = "busy"
				case "blocked":
					agent.Runner = "waiting for input"
				case "idle":
					agent.Runner = "running"
				case "done":
					agent.Runner = "done"
				default:
					agent.Runner = "unknown"
				}
			} else if session.Kind == "none" {
				agent.Kind, agent.Runner = "none", "no primary agent"
			}
		}(&agents[i])
	}
	wg.Wait()
	reply(w, map[string]any{"enabled": true, "hosts": hosts, "workers": workers, "agents": agents})
}

func (s *server) consoleActor(ctx context.Context, name, uid string) (*pb.Actor, error) {
	actor, e := s.actor(ctx, name)
	if e != nil {
		return nil, e
	}
	kind, e := s.actorKinds(ctx)
	if e != nil {
		return nil, e
	}
	if uid == "" || actor.GetMetadata().GetUid() != uid || kind(actor) == "" {
		return nil, status.Error(codes.NotFound, "Sandbox UID no longer exists")
	}
	return actor, nil
}

func (s *server) bridgeToken(uid string) string {
	hash := hmac.New(sha256.New, s.bridgeKey)
	hash.Write([]byte("pvm-console-bridge:" + uid))
	return hex.EncodeToString(hash.Sum(nil))
}

func (s *server) ensureBridge(ctx context.Context, name, uid string) error {
	digest, e := os.ReadFile("/opt/console/bridge.sha256")
	if e != nil {
		return errors.New("Console package unavailable")
	}
	file, e := os.Open("/opt/console/bridge.tar.gz")
	if e != nil {
		return errors.New("Console package unavailable")
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil {
		return e
	}
	start := func() (bool, error) {
		if _, e := s.consoleActor(ctx, name, uid); e != nil {
			return false, e
		}
		body, _ := json.Marshal(map[string]any{"argv": []string{"python3", "-c", consoleInstaller, strings.TrimSpace(string(digest)), s.bridgeToken(uid), strconv.FormatInt(info.Size(), 10)}, "timeout": 60})
		response, e := s.workload(ctx, name, "POST", "/exec", body)
		if e != nil {
			return false, errors.New("Bridge installation connection failed")
		}
		defer response.Body.Close()
		var result struct {
			ExitCode int    `json:"exit_code"`
			Output   string `json:"output"`
		}
		if response.StatusCode != 200 {
			return false, fmt.Errorf("Bridge service command rejected (HTTP %d)", response.StatusCode)
		}
		if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil {
			return false, errors.New("Invalid bridge command response")
		}
		if result.ExitCode != 0 {
			return false, fmt.Errorf("Bridge installation exited with code %d; inspect herdr-web-ui/bridge.log", result.ExitCode)
		}
		var state struct {
			Ready           bool `json:"ready"`
			InstallRequired bool `json:"install_required"`
		}
		if json.Unmarshal([]byte(result.Output), &state) != nil || !state.Ready && !state.InstallRequired {
			return false, errors.New("Invalid bridge installation response")
		}
		return state.Ready, nil
	}
	ready, e := start()
	if e != nil {
		return e
	}
	if ready {
		return s.waitBridge(ctx, name, uid)
	}
	const chunk = int64(32 << 20)
	for offset, part := int64(0), 0; offset < info.Size(); offset, part = offset+chunk, part+1 {
		length := min(chunk, info.Size()-offset)
		path := fmt.Sprintf("/files?path=/workspace/.agent-state/herdr-web-ui/%s.%d.part", strings.TrimSpace(string(digest)), part)
		request, _ := http.NewRequestWithContext(ctx, "PUT", "https://atenet-router.ate-system.svc"+path, io.NewSectionReader(file, offset, length))
		request.ContentLength = length
		request.Header.Set("ate-target-actor", space+"/"+name)
		response, e := (&http.Client{Transport: routedTransport{s}}).Do(request)
		if e != nil {
			return errors.New("Bridge package upload failed")
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			return errors.New("Bridge package upload rejected")
		}
	}
	ready, e = start()
	if e == nil && !ready {
		e = errors.New("Bridge did not become ready")
	}
	if e != nil {
		return e
	}
	return s.waitBridge(ctx, name, uid)
}

type consoleBridgeTransport struct {
	*http.Transport
	server *server
}

func (t *consoleBridgeTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	release, err := t.server.admitRoute(request.Context(), "", false)
	if err != nil {
		return nil, err
	}
	defer release()
	response, e := t.Transport.RoundTrip(request)
	// A stale route can reach another sandbox; retry only reads, with the same UID credential.
	if e == nil && response.StatusCode == 401 && request.Method == "GET" && request.Header.Get("Upgrade") == "" && (request.Body == nil || request.Body == http.NoBody) {
		response.Body.Close()
		return t.Transport.RoundTrip(request)
	}
	return response, e
}

func (s *server) bridgeTransport(name, uid string) *consoleBridgeTransport {
	return &consoleBridgeTransport{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return s.dialBridge(ctx, name, uid) }, DisableKeepAlives: true, ResponseHeaderTimeout: 80 * time.Second}, server: s}
}

// Sandbox readiness can precede CONNECT routing after a move to another worker.
func (s *server) waitBridge(ctx context.Context, name, uid string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	transport := s.bridgeTransport(name, uid)
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for {
		request, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:7317/api/health", nil)
		request.Header.Set("Authorization", "Bearer "+s.bridgeToken(uid))
		response, e := client.Do(request)
		if e == nil {
			var health struct {
				OK bool `json:"ok"`
			}
			valid := response.StatusCode == 200 && json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&health) == nil && health.OK
			response.Body.Close()
			if valid {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return errors.New("Console route did not become ready; reconnect to retry")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

type consoleConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *consoleConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func (s *server) dialBridge(ctx context.Context, name, uid string) (net.Conn, error) {
	actor, e := s.consoleActor(ctx, name, uid)
	if e != nil || actor.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
		return nil, errors.New("Sandbox is no longer running")
	}
	dialer := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 15 * time.Second}, Config: s.transport.TLSClientConfig}
	dial := s.transport.DialTLSContext
	if dial == nil {
		dial = dialer.DialContext
	}
	conn, e := dial(ctx, "tcp", "atenet-router.ate-system.svc:8444")
	if e != nil {
		return nil, e
	}
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	request := &http.Request{Method: "CONNECT", URL: &url.URL{Host: name + ":7317"}, Host: name + ":7317", Header: http.Header{"Ate-Target-Actor": {space + "/" + name}}}
	if e = request.Write(conn); e == nil {
		reader := bufio.NewReader(conn)
		var response *http.Response
		response, e = http.ReadResponse(reader, request)
		if e == nil && response.StatusCode == 200 {
			conn.SetDeadline(time.Time{})
			return &consoleConn{Conn: conn, reader: reader}, nil
		}
	}
	conn.Close()
	return nil, errors.New("Console CONNECT tunnel failed")
}

func (s *server) consoleRoute(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/console" && r.Method == "GET" {
		s.consoleList(w, r)
		return
	}
	if !s.consoleEnabled {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/api/console/ui/" && (r.Method == "GET" || r.Method == "HEAD") {
		files, _ := fs.Sub(consoleWeb, "console/dist")
		r.URL.Path = "/"
		http.FileServer(http.FS(files)).ServeHTTP(w, r)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/console/agents/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/console/agents/") || len(parts) < 3 || !validName.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	name, uid, operation := parts[0], parts[1], parts[2]
	switch operation {
	case "connect", "resume", "session", "ui", "bridge":
	default:
		http.NotFound(w, r)
		return
	}
	actor, e := s.consoleActor(r.Context(), name, uid)
	if e != nil {
		s.fail(w, e)
		return
	}
	if (r.Method == "POST" || r.Method == "PUT" || r.Method == "DELETE" || operation == "ui") && !s.userAccess(w, r, actor) {
		return
	}
	if r.Method == "POST" && len(parts) == 3 && (operation == "connect" || operation == "resume") {
		ctx, cancel := context.WithTimeout(r.Context(), sandboxOperationTimeout)
		defer cancel()
		unlock := s.lock(name)
		defer unlock()
		actor, e = s.consoleActor(ctx, name, uid)
		if e == nil && operation == "resume" {
			actor, e = s.resume(ctx, name)
		}
		if e == nil && actor.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
			e = status.Error(codes.FailedPrecondition, "Resume the sandbox first")
		}
		if e == nil {
			e = s.ensureBridge(ctx, name, uid)
		}
		if e != nil {
			s.fail(w, e)
			return
		}
		reply(w, map[string]bool{"ready": true})
		return
	}
	if actor.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
		http.Error(w, "Resume the sandbox first", 409)
		return
	}
	if operation == "session" && len(parts) == 3 && r.Method == "GET" {
		if r.Header.Get("Upgrade") != "" {
			http.Error(w, "Session does not support upgrades", http.StatusBadRequest)
			return
		}
		s.proxy(w, r, name, uid, "/session")
		return
	}
	if operation == "ui" && len(parts) == 4 && parts[3] == "" && (r.Method == "GET" || r.Method == "HEAD") {
		w.Header().Set("Content-Security-Policy", strings.Replace(w.Header().Get("Content-Security-Policy"), "img-src 'self' data:", "img-src 'self' data: blob:", 1))
		files, _ := fs.Sub(consoleWeb, "console/dist")
		r.URL.Path = "/"
		http.FileServer(http.FS(files)).ServeHTTP(w, r)
		return
	}
	if operation != "bridge" || len(parts) < 4 || strings.Contains(r.URL.Path, "//") {
		http.NotFound(w, r)
		return
	}
	upstreamPath := "/" + strings.Join(parts[3:], "/")
	if upstreamPath != "/ws" && !strings.HasPrefix(upstreamPath, "/api/") {
		http.NotFound(w, r)
		return
	}
	if upstreamPath == "/ws" && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		dialer := websocket.Dialer{NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return s.dialBridge(ctx, name, uid)
		}}
		headers := http.Header{"Authorization": []string{"Bearer " + s.bridgeToken(uid)}, "Origin": []string{"http://127.0.0.1:7317"}}
		s.socket(w, r, name, uid, "ws://127.0.0.1:7317/ws?"+r.URL.RawQuery, headers, dialer, false)
		return
	}
	s.proxyBridge(w, r, name, uid, upstreamPath)
}

func (s *server) prepareBridgeLaunch(r *http.Request, name, uid, path string) error {
	if r.Method != http.MethodPost {
		return nil
	}
	if strings.HasPrefix(path, "/api/machines/local/") {
		path = "/api/" + strings.TrimPrefix(path, "/api/machines/local/")
	}
	switch path {
	case "/api/workspace/create", "/api/tab/create", "/api/worktree/create", "/api/worktree/open":
	default:
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	r.Body.Close()
	if err != nil || len(raw) > 1<<20 {
		return status.Error(codes.InvalidArgument, "Invalid console launch request")
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var payload struct {
		Agent *struct {
			Kind string `json:"kind"`
		} `json:"agent"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return status.Error(codes.InvalidArgument, "Invalid console launch request")
	}
	if payload.Agent == nil || (payload.Agent.Kind != "codex" && payload.Agent.Kind != "pi") {
		return nil
	}
	unlock := s.lock(name)
	defer unlock()
	if err = s.checkActorUID(r.Context(), name, uid); err != nil {
		return err
	}
	return s.inject(r.Context(), name, payload.Agent.Kind)
}

func (s *server) proxyBridge(w http.ResponseWriter, r *http.Request, name, uid, upstreamPath string) {
	if err := s.prepareBridgeLaunch(r, name, uid, upstreamPath); err != nil {
		s.fail(w, err)
		return
	}
	transport := s.bridgeTransport(name, uid)
	defer transport.CloseIdleConnections()
	proxy := &httputil.ReverseProxy{Transport: transport, FlushInterval: -1, Director: func(out *http.Request) {
		out.URL.Scheme, out.URL.Host, out.Host = "http", "127.0.0.1:7317", "127.0.0.1:7317"
		out.URL.Path, out.URL.RawPath = upstreamPath, ""
		out.Header.Del("Cookie")
		for key := range out.Header {
			lower := strings.ToLower(key)
			if strings.HasPrefix(lower, "x-forwarded-") || strings.HasPrefix(lower, "tailscale-") || strings.HasPrefix(lower, "ate-") {
				out.Header.Del(key)
			}
		}
		out.Header.Set("Authorization", "Bearer "+s.bridgeToken(uid))
		out.Header.Set("Origin", "http://127.0.0.1:7317")
	}, ModifyResponse: func(response *http.Response) error {
		response.Header.Del("Set-Cookie")
		response.Header.Set("Cache-Control", "no-store")
		return nil
	}, ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) { http.Error(w, "Console connection failed", 502) }}
	proxy.ServeHTTP(w, r)
}
