package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"

	"github.com/gorilla/websocket"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

//go:embed web/dist
var web embed.FS

const space = "pvm-agents"

var validName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,48}[a-z0-9]$`)
var kinds = map[string]bool{"codex": true, "pi": true, "devin": true}
var templatePrefix = os.Getenv("AGENT_TEMPLATE_PREFIX")

type server struct {
	api            pb.ControlClient
	transport      *http.Transport
	password       [32]byte
	bridgeKey      []byte
	origin         string
	authFile       string
	mu             sync.Mutex
	locks          map[string]*sync.Mutex
	routes         map[string]*sync.RWMutex
	consoleEnabled bool
	idleTimeout    time.Duration
	activity       map[string]*idleRecord
	sockets        map[string]map[*websocket.Conn]context.CancelFunc
	workerScaler   *workerScaler
	workerManager  *workerManager
	sessions       *sessionStore
	loginLimiter   loginLimiter
}

type fileToken string

func (f fileToken) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	b, e := os.ReadFile(string(f))
	if e != nil {
		return nil, e
	}
	return map[string]string{"authorization": "Bearer " + strings.TrimSpace(string(b))}, nil
}
func (fileToken) RequireTransportSecurity() bool { return true }

func roots(path string) (*x509.CertPool, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(b) {
		return nil, errors.New("invalid trust bundle")
	}
	return pool, nil
}

func (s *server) authorize(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if (origin != "" && origin != s.origin) || (strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && origin != s.origin) {
		http.Error(w, "Origin denied", 403)
		return false
	}
	now := time.Now()
	session := s.hasSession(r, now)
	if !session {
		user, password, ok := r.BasicAuth()
		if !ok || r.Header.Get("Sec-Fetch-Mode") != "" {
			authError(w, http.StatusUnauthorized, "Authentication required")
			return false
		}
		valid, limited := s.checkCredentials(r, user, password)
		if limited {
			w.Header().Set("Retry-After", "60")
			authError(w, http.StatusTooManyRequests, "Too many sign-in attempts. Try again in a minute.")
			return false
		}
		if !valid {
			authError(w, http.StatusUnauthorized, "Authentication required")
			return false
		}
	}
	// Browser mutations must carry Origin; CLI Basic-auth requests have no browser fetch metadata.
	if r.Method != "GET" && r.Method != "HEAD" && origin == "" && (session || r.Header.Get("Sec-Fetch-Mode") != "") {
		http.Error(w, "Origin required", 403)
		return false
	}
	return true
}

func reply(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(value)
}
func replyProto(w http.ResponseWriter, value proto.Message) {
	b, e := protojson.Marshal(value)
	if e != nil {
		http.Error(w, "Encoding failed", 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 1048577))
	d.DisallowUnknownFields()
	return d.Decode(v)
}
func ref(name string) *pb.ObjectRef { return &pb.ObjectRef{Atespace: space, Name: name} }
func (s *server) lock(name string) func() {
	s.mu.Lock()
	if s.locks == nil {
		s.locks = map[string]*sync.Mutex{}
	}
	m := s.locks[name]
	if m == nil {
		m = &sync.Mutex{}
		s.locks[name] = m
	}
	s.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func (s *server) routeLock(name string) *sync.RWMutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.routes == nil {
		s.routes = map[string]*sync.RWMutex{}
	}
	if s.routes[name] == nil {
		s.routes[name] = &sync.RWMutex{}
	}
	return s.routes[name]
}

func (s *server) actor(ctx context.Context, name string) (*pb.Actor, error) {
	return s.api.GetActor(ctx, &pb.GetActorRequest{Actor: ref(name)})
}

func (s *server) checkActorUID(ctx context.Context, name, uid string) error {
	if uid == "" {
		return nil
	}
	actor, e := s.actor(ctx, name)
	if e != nil {
		return e
	}
	if actor.GetMetadata().GetUid() != uid {
		return status.Error(codes.NotFound, "Sandbox UID no longer exists")
	}
	return nil
}

func (s *server) workload(ctx context.Context, name, method, path string, body []byte) (*http.Response, error) {
	release, e := s.admitRoute(ctx, name, method == "POST" && (path == "/runtime/freeze" || path == "/runtime/thaw"))
	if e != nil {
		return nil, e
	}
	defer release()
	request, e := http.NewRequestWithContext(ctx, method, "https://atenet-router.ate-system.svc"+path, bytes.NewReader(body))
	if e != nil {
		return nil, e
	}
	request.Header.Set("ate-target-actor", space+"/"+name)
	request.Header.Set("Content-Type", "application/json")
	return (&http.Client{Transport: s.transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(request)
}

type routedTransport struct{ server *server }

type actorTransport struct {
	server    *server
	name, uid string
}

func (t actorTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	// Response headers establish the route; body streaming does not block replacement.
	gate := t.server.routeLock(t.name)
	gate.RLock()
	defer gate.RUnlock()
	if e := t.server.checkActorUID(request.Context(), t.name, t.uid); e != nil {
		return nil, e
	}
	return (routedTransport{t.server}).RoundTrip(request)
}

func (t routedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	release, err := t.server.admitRoute(request.Context(), "", false)
	if err != nil {
		return nil, err
	}
	defer release()
	return t.server.transport.RoundTrip(request)
}

func (s *server) inject(ctx context.Context, name string, hint ...string) error {
	kind := ""
	if len(hint) != 0 {
		kind = hint[0]
	}
	// A restored sandbox retains its agent settings inside its private HOME.
	// Inspect them before reading or delivering another provider's credentials.
	needsCodex := kind != "devin"
	if kind == "" || kind == "devin" {
		response, err := s.workload(ctx, name, "GET", "/session", nil)
		if err != nil {
			return errors.New("Cannot determine the restored agent; open Terminal before retrying")
		}
		defer response.Body.Close()
		var session struct {
			Kind   string `json:"kind"`
			Agents []struct {
				Agent string `json:"agent"`
			} `json:"agents"`
		}
		if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&session) != nil {
			return errors.New("Cannot determine the restored agent; open Terminal before retrying")
		}
		if kind == "" {
			kind = session.Kind
		}
		needsCodex = kind != "devin"
		for _, runner := range session.Agents {
			if runner.Agent == "codex" || runner.Agent == "pi" {
				needsCodex = true
			}
		}
	}
	if !needsCodex {
		return nil
	}
	raw, e := os.ReadFile(s.authFile)
	if e != nil {
		return errors.New("central OAuth source unavailable")
	}
	var auth map[string]any
	if json.Unmarshal(raw, &auth) != nil {
		return errors.New("invalid central OAuth source")
	}
	tokens, ok := auth["tokens"].(map[string]any)
	if !ok {
		return errors.New("ChatGPT OAuth required")
	}
	raw, e = json.Marshal(map[string]any{"auth_mode": "chatgpt", "last_refresh": auth["last_refresh"], "tokens": map[string]any{
		"access_token": tokens["access_token"], "account_id": tokens["account_id"], "refresh_token": "",
	}})
	if e != nil {
		return e
	}
	response, e := s.workload(ctx, name, "POST", "/auth", raw)
	if e != nil {
		return errors.New("OAuth delivery failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("OAuth delivery rejected")
	}
	return nil
}

func (s *server) resume(ctx context.Context, name string) (*pb.Actor, error) {
	return s.resumeAgent(ctx, name, "")
}

func (s *server) resumeAgent(ctx context.Context, name, kind string) (*pb.Actor, error) {
	result, e := s.resumeActor(ctx, name)
	if e != nil {
		return nil, e
	}
	if e = s.inject(ctx, name, kind); e != nil {
		return nil, e
	}
	if e = s.runtimeGate(ctx, name, false); e != nil {
		return nil, e
	}
	return result.GetActor(), nil
}

func (s *server) checkSession(ctx context.Context, name, method string, body []byte, requireReady bool) error {
	response, e := s.workload(ctx, name, method, "/session", body)
	if e != nil {
		return errors.New("Session connection failed; inspect the native runner in Terminal")
	}
	defer response.Body.Close()
	var session struct {
		Ready   bool   `json:"ready"`
		Started bool   `json:"started"`
		Kind    string `json:"kind"`
		Server  bool   `json:"server"`
		Error   string `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1048576)).Decode(&session) != nil {
		return errors.New("Invalid session response")
	}
	if response.StatusCode != 200 || !(session.Ready || !requireReady && (session.Kind == "none" && session.Server || session.Kind == "devin" && session.Server && session.Started)) {
		if session.Error == "" {
			session.Error = "Runner is unavailable. Open Terminal and inspect Herdr before restarting it."
		}
		return status.Error(codes.FailedPrecondition, session.Error)
	}
	return nil
}

func (s *server) remove(ctx context.Context, name string) error {
	gate := s.routeLock(name)
	gate.Lock()
	defer gate.Unlock()
	actor, e := s.actor(ctx, name)
	if status.Code(e) == codes.NotFound {
		return nil
	}
	if e != nil {
		return e
	}
	state := actor.GetStatus().GetState()
	if state != pb.ActorState_ACTOR_STATE_SUSPENDED && state != pb.ActorState_ACTOR_STATE_CRASHED && state != pb.ActorState_ACTOR_STATE_DELETING {
		if _, e = s.api.SuspendActor(ctx, &pb.SuspendActorRequest{Actor: ref(name)}); e != nil {
			return e
		}
	}
	if _, e = s.api.DeleteActor(ctx, &pb.DeleteActorRequest{Actor: ref(name)}); e != nil {
		return e
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		_, e = s.actor(ctx, name)
		if status.Code(e) == codes.NotFound {
			return nil
		}
		if e != nil {
			return e
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func hasDurableSnapshot(actor *pb.Actor) bool {
	for _, snapshot := range actor.GetStatus().GetSnapshots() {
		if snapshot.GetDurableSnapshot().GetStatus() == pb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_COMPLETED {
			return true
		}
	}
	return false
}

func (s *server) proxy(w http.ResponseWriter, r *http.Request, name, uid, path string) {
	actor, e := s.actor(r.Context(), name)
	if e != nil {
		s.fail(w, e)
		return
	}
	if uid == "" || actor.GetMetadata().GetUid() != uid {
		s.fail(w, status.Error(codes.NotFound, "Sandbox UID no longer exists"))
		return
	}
	if actor.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
		http.Error(w, "Resume the sandbox first", 409)
		return
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		headers := http.Header{"Ate-Target-Actor": []string{space + "/" + name}}
		dialer := websocket.Dialer{NetDialTLSContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&tls.Dialer{Config: s.transport.TLSClientConfig}).DialContext(ctx, network, address)
		}}
		s.socket(w, r, name, actor.GetMetadata().GetUid(), "wss://atenet-router.ate-system.svc"+path+"?"+r.URL.RawQuery, headers, dialer, true)
		return
	}
	if r.Method == "PUT" {
		body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<20))
		if e != nil {
			http.Error(w, "Invalid upload body or upload exceeds 64 MiB", http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
	}
	target, _ := url.Parse("https://atenet-router.ate-system.svc")
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = actorTransport{s, name, uid}
	proxy.FlushInterval = -1
	original := proxy.Director
	proxy.Director = func(out *http.Request) {
		original(out)
		out.URL.Path = path
		out.URL.RawPath = ""
		out.Host = target.Host
		out.Header.Del("Authorization")
		out.Header.Del("Cookie")
		out.Header.Del("ate-target-actor")
		out.Header.Set("ate-target-actor", space+"/"+name)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) { http.Error(w, "Sandbox connection failed", 502) }
	proxy.ServeHTTP(w, r)
}

func (s *server) fail(w http.ResponseWriter, e error) {
	code := http.StatusBadGateway
	switch status.Code(e) {
	case codes.NotFound:
		code = 404
	case codes.AlreadyExists, codes.Aborted:
		code = 409
	case codes.InvalidArgument:
		code = 400
	case codes.FailedPrecondition, codes.ResourceExhausted:
		code = 409
	case codes.DeadlineExceeded:
		code = 504
	}
	// Runtime endpoints never return credentials; gRPC messages contain resource state only.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": e.Error()})
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
	if strings.HasPrefix(r.URL.Path, "/api/auth/") {
		s.authRoute(w, r)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") && !strings.HasPrefix(r.URL.Path, "/console-assets/") {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Security-Policy", strings.Replace(w.Header().Get("Content-Security-Policy"), "script-src 'self' 'unsafe-inline'", "script-src 'self'", 1))
		files, _ := fs.Sub(web, "web/dist")
		http.FileServer(http.FS(files)).ServeHTTP(w, r)
		return
	}
	if !s.authorize(w, r) {
		return
	}
	for key := range r.Header {
		if strings.HasPrefix(strings.ToLower(key), "cf-access-") {
			r.Header.Del(key)
		}
	}
	if session := s.browserSession(r, time.Now()); session != nil {
		ctx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(session.ctx, cancel)
		defer stop()
		defer cancel()
		r = r.WithContext(ctx)
		if session.ctx.Err() != nil {
			authError(w, http.StatusUnauthorized, "Authentication required")
			return
		}
	} else if !s.validBasic(r) {
		authError(w, http.StatusUnauthorized, "Authentication required")
		return
	}
	if r.Header.Get("Accept") == "application/x-ndjson" && operationRequest(r) {
		streamOperation(w, r, s.apiRoute, operationHeartbeat)
		return
	}
	s.apiRoute(w, r)
}

func (s *server) apiRoute(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/worker") {
		s.workerRoutes(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/console") {
		s.consoleRoute(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/console-assets/") {
		if !s.consoleEnabled {
			http.NotFound(w, r)
			return
		}
		files, _ := fs.Sub(consoleWeb, "console/dist")
		http.StripPrefix("/console-assets", http.FileServer(http.FS(files))).ServeHTTP(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), sandboxOperationTimeout)
	defer cancel()
	if r.URL.Path == "/api/agents" {
		switch r.Method {
		case "GET":
			var all []*pb.Actor
			token := ""
			for {
				result, e := s.api.ListActors(ctx, &pb.ListActorsRequest{Atespace: space, Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
				if e != nil {
					s.fail(w, e)
					return
				}
				all = append(all, result.GetActors()...)
				token = result.GetNextPageToken()
				if token == "" {
					break
				}
			}
			replyProto(w, &pb.ListActorsResponse{Actors: all})
		case "POST":
			s.createRoute(w, r)
		default:
			http.Error(w, "Method not allowed", 405)
		}
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/agents/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/agents/") || len(parts) == 0 || !validName.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	name := parts[0]
	if (len(parts) == 1 && r.Method == "GET") || (len(parts) >= 2 && (r.Method == "POST" || r.Method == "DELETE" || parts[1] == "files" || parts[1] == "terminal")) {
		current, e := s.actor(ctx, name)
		if e != nil {
			s.fail(w, e)
			return
		}
		if !s.userAccess(w, r, current) {
			return
		}
	}
	if len(parts) == 1 && r.Method == "GET" {
		actor, e := s.actor(ctx, name)
		if e != nil {
			s.fail(w, e)
			return
		}
		replyProto(w, actor)
		return
	}
	if len(parts) == 1 && r.Method == "DELETE" {
		unlock := s.lock(name)
		defer unlock()
		if e := s.checkActorUID(ctx, name, r.URL.Query().Get("uid")); e != nil {
			s.fail(w, e)
			return
		}
		if e := s.remove(ctx, name); e != nil {
			s.fail(w, e)
			return
		}
		reply(w, map[string]bool{"deleted": true})
		return
	}
	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}
	operation := parts[1]
	uid := r.URL.Query().Get("uid")
	if operation == "session" && r.Method == "GET" && len(parts) == 2 {
		if r.Header.Get("Upgrade") != "" {
			http.Error(w, "Session does not support upgrades", http.StatusBadRequest)
			return
		}
		s.proxy(w, r, name, uid, "/session")
		return
	}
	if operation == "terminal" || operation == "files" {
		if operation == "files" && len(parts) != 2 {
			http.NotFound(w, r)
			return
		}
		s.proxy(w, r, name, uid, "/"+strings.Join(parts[1:], "/"))
		return
	}
	if r.Method != "POST" || len(parts) != 2 {
		http.Error(w, "Method not allowed", 405)
		return
	}
	unlock := s.lock(name)
	defer unlock()
	if e := s.checkActorUID(ctx, name, r.URL.Query().Get("uid")); e != nil {
		s.fail(w, e)
		return
	}
	if (operation == "prompt" || operation == "exec") && uid == "" {
		s.fail(w, status.Error(codes.NotFound, "Sandbox UID is required"))
		return
	}
	switch operation {
	case "prompt":
		current, e := s.actor(ctx, name)
		if e != nil {
			s.fail(w, e)
			return
		}
		if current.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
			s.fail(w, status.Error(codes.FailedPrecondition, "Resume the sandbox first"))
			return
		}
		if e := s.inject(ctx, name); e != nil {
			s.fail(w, e)
			return
		}
		s.proxy(w, r, name, uid, "/prompt")
	case "revert":
		current, e := s.actor(ctx, name)
		if e != nil {
			s.fail(w, e)
			return
		}
		if !hasDurableSnapshot(current) {
			s.fail(w, status.Error(codes.FailedPrecondition, "No completed snapshot is available. Restoring would start an empty workspace."))
			return
		}
		if _, e := s.api.RevertActor(ctx, &pb.RevertActorRequest{Actor: ref(name)}); e != nil {
			s.fail(w, e)
			return
		}
		actor, e := s.resume(ctx, name)
		if e == nil {
			e = s.checkSession(ctx, name, "GET", nil, false)
		}
		if e != nil {
			s.fail(w, e)
			return
		}
		replyProto(w, actor)
	case "resume":
		actor, e := s.resume(ctx, name)
		if e == nil {
			e = s.checkSession(ctx, name, "GET", nil, false)
		}
		if e != nil {
			s.fail(w, e)
			return
		}
		replyProto(w, actor)
	case "suspend":
		current, e := s.actor(ctx, name)
		if e == nil {
			uid := current.GetMetadata().GetUid()
			s.mu.Lock()
			if s.activity == nil {
				s.activity = map[string]*idleRecord{}
			}
			if s.activity[uid] == nil {
				s.activity[uid] = &idleRecord{}
			}
			s.activity[uid].suspending = true
			s.mu.Unlock()
			defer func() {
				s.mu.Lock()
				if entry := s.activity[uid]; entry != nil {
					entry.suspending = false
					entry.last = time.Now()
				}
				s.mu.Unlock()
			}()
		}
		frozen := false
		if e == nil && current.GetStatus().GetState() == pb.ActorState_ACTOR_STATE_RUNNING {
			e = s.runtimeGate(ctx, name, true)
			frozen = e == nil
		}
		completed := false
		defer func() {
			if frozen && !completed {
				thaw, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				s.runtimeGate(thaw, name, false)
			}
		}()
		if e != nil {
			s.fail(w, e)
			return
		}
		latest, e := s.actor(ctx, name)
		if e == nil && latest.GetMetadata().GetUid() != current.GetMetadata().GetUid() {
			e = status.Error(codes.Aborted, "Sandbox changed before suspend")
		}
		if e != nil {
			s.fail(w, e)
			return
		}
		s.closeIdleSockets(current.GetMetadata().GetUid())
		result, e := s.api.SuspendActor(ctx, &pb.SuspendActorRequest{Actor: ref(name)})
		if e != nil {
			s.fail(w, e)
			return
		}
		completed = true
		replyProto(w, result.GetActor())
	case "exec":
		if _, e := s.resume(ctx, name); e != nil {
			s.fail(w, e)
			return
		}
		raw, e := io.ReadAll(io.LimitReader(r.Body, 1048577))
		if e != nil || len(raw) > 1048576 {
			http.Error(w, "Invalid body", 400)
			return
		}
		response, e := s.workload(ctx, name, "POST", "/exec", raw)
		if e != nil {
			s.fail(w, errors.New("Command connection failed"))
			return
		}
		defer response.Body.Close()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.StatusCode)
		io.Copy(w, response.Body)
	default:
		http.NotFound(w, r)
	}
}

func main() {
	password, e := os.ReadFile("/run/panel/password")
	if e != nil {
		log.Fatal(e)
	}
	bridgeKey, e := os.ReadFile("/run/panel/bridge-key")
	if e != nil || len(bridgeKey) != sha256.Size {
		log.Fatal("Console bridge key unavailable or invalid")
	}
	pool, e := roots("/run/servicedns/trust.pem")
	if e != nil {
		log.Fatal(e)
	}
	connection, e := grpc.NewClient("api.ate-system.svc:443", grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "api.ate-system.svc"})), grpc.WithPerRPCCredentials(fileToken("/run/ate-token/token")))
	if e != nil {
		log.Fatal(e)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
		cert, e := tls.LoadX509KeyPair("/run/identity/credential.pem", "/run/identity/credential.pem")
		return &cert, e
	}}, ForceAttemptHTTP2: false, ResponseHeaderTimeout: 5 * time.Minute}
	origin := os.Getenv("PANEL_ORIGIN")
	if origin == "" {
		origin = "https://192.0.2.10:8443"
	}
	s := &server{api: pb.NewControlClient(connection), transport: transport, password: sha256.Sum256(bytes.TrimSpace(password)), bridgeKey: bridgeKey, origin: origin, authFile: "/run/auth/auth.json", locks: map[string]*sync.Mutex{}}
	sessionDirectory := os.Getenv("PANEL_SESSION_DIR")
	if sessionDirectory == "" {
		sessionDirectory = "/var/lib/agent-box-auth/sessions"
	}
	s.sessions, e = openSessionStore(sessionDirectory, s.sessionCredential())
	if e != nil {
		log.Fatal("Panel session storage unavailable")
	}
	defer s.sessions.close()
	s.consoleEnabled = os.Getenv("CONSOLE_ENABLED") == "true"
	if os.Getenv("WORKER_PROFILES") == "true" {
		s.workerManager, e = newWorkerManager(s.api)
		if e == nil {
			go s.workerManager.run(context.Background())
		}
	} else {
		s.workerScaler, e = newWorkerScaler(os.Getenv("WORKER_MAX_REPLICAS"))
	}
	if e != nil {
		log.Fatal(e)
	}
	s.idleTimeout, e = idleTimeout(os.Getenv("AGENT_IDLE_TIMEOUT"))
	if e != nil {
		log.Fatal(e)
	}
	go s.runIdle(context.Background())
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			actors, e := s.api.ListActors(ctx, &pb.ListActorsRequest{Atespace: space})
			cancel()
			if e != nil {
				continue
			}
			for _, actor := range actors.GetActors() {
				name := actor.GetMetadata().GetName()
				unlock := s.lock(name)
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				current, e := s.actor(ctx, name)
				if e == nil && current.GetStatus().GetState() == pb.ActorState_ACTOR_STATE_RUNNING {
					_ = s.inject(ctx, name)
				}
				cancel()
				unlock()
			}
		}
	}()
	listener := &http.Server{Addr: ":8443", Handler: s, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16384, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	fmt.Println("agent-box-host panel listening on HTTPS :8443")
	log.Fatal(listener.ListenAndServeTLS("/run/panel/tls.crt", "/run/panel/tls.key"))
}
