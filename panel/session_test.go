package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"github.com/gorilla/websocket"
)

func sessionServer(t *testing.T) *server {
	t.Helper()
	key := sha256.Sum256([]byte("private-session-key"))
	s := &server{password: sha256.Sum256([]byte("password")), bridgeKey: key[:], origin: "https://panel.test"}
	var err error
	s.sessions, err = openSessionStore(t.TempDir(), s.sessionCredential())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.sessions.close)
	return s
}

func loginRequest(s *server, path, body, origin string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", s.origin+path, strings.NewReader(body))
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Sec-Fetch-Mode", "cors")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestFormLoginSessionSurvivesPanelRestart(t *testing.T) {
	s := sessionServer(t)
	w := loginRequest(s, "/api/auth/login", `{"username":"admin","password":"password"}`, s.origin, nil)
	if w.Code != 204 || len(w.Result().Cookies()) != 1 {
		t.Fatal("Login failed", w.Code)
	}
	cookie := w.Result().Cookies()[0]
	if cookie.Name != sessionCookieName || len(cookie.Value) != 64 || cookie.Path != "/" || cookie.Domain != "" || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != int(sessionLifetime.Seconds()) {
		t.Fatal("Cookie security attributes changed")
	}
	second := httptest.NewRecorder()
	if err := s.setSession(second, time.Now()); err != nil {
		t.Fatal(err)
	}
	if second.Result().Cookies()[0].Value == cookie.Value {
		t.Fatal("Login reused a session identifier")
	}
	data, err := os.ReadFile(s.sessions.path)
	if err != nil || bytes.Contains(data, []byte(cookie.Value)) || bytes.Contains(data, []byte("password")) {
		t.Fatal("Session store contains credentials or bearer tokens")
	}
	info, _ := os.Stat(s.sessions.path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("Session file is not private")
	}
	directory := filepath.Dir(s.sessions.path)
	s.sessions.close()
	s.sessions, err = openSessionStore(directory, s.sessionCredential())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.sessions.close)
	for _, path := range []string{"/api/console/ui/", "/api/console/agents/test/uid/bridge/api/session", "/api/console/agents/test/uid/bridge/ws"} {
		r := httptest.NewRequest("GET", s.origin+path, nil)
		r.AddCookie(cookie)
		if strings.HasSuffix(path, "/ws") {
			r.Header.Set("Upgrade", "websocket")
			r.Header.Set("Origin", s.origin)
		}
		w := httptest.NewRecorder()
		if !s.authorize(w, r) || w.Header().Get("WWW-Authenticate") != "" || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("Cookie login or restart failed", path)
		}
	}
}

func TestInvalidBrowserSessionsAreRejected(t *testing.T) {
	for _, name := range []string{"expired", "tampered", "malformed", "legacy", "password changed", "key changed", "missing key", "another origin"} {
		t.Run(name, func(t *testing.T) {
			s := sessionServer(t)
			w := httptest.NewRecorder()
			issued := time.Now()
			if name == "expired" {
				issued = issued.Add(-sessionLifetime - time.Second)
			}
			if err := s.setSession(w, issued); err != nil {
				t.Fatal(err)
			}
			cookie := w.Result().Cookies()[0]
			switch name {
			case "tampered":
				cookie.Value = strings.Repeat("0", 64)
			case "malformed":
				cookie.Value = "invalid"
			case "legacy":
				cookie.Value = "1999999999." + strings.Repeat("a", 64)
			case "password changed":
				s.password = sha256.Sum256([]byte("replacement"))
			case "key changed":
				s.bridgeKey = make([]byte, sha256.Size)
			case "missing key":
				s.bridgeKey = nil
			case "another origin":
				s.origin = "https://other.test"
			}
			r := httptest.NewRequest("GET", s.origin+"/api/console/ui/", nil)
			r.AddCookie(cookie)
			w = httptest.NewRecorder()
			if s.authorize(w, r) || w.Code != 401 || w.Header().Get("WWW-Authenticate") != "" {
				t.Fatal("Invalid session authenticated", name, w.Code)
			}
		})
	}
}

func TestLogoutRevokesOnlyItsSessionAndPersists(t *testing.T) {
	s := sessionServer(t)
	login := func() *http.Cookie {
		w := loginRequest(s, "/api/auth/login", `{"username":"admin","password":"password"}`, s.origin, nil)
		if w.Code != 204 {
			t.Fatal(w.Code)
		}
		return w.Result().Cookies()[0]
	}
	first, second := login(), login()
	r := httptest.NewRequest("GET", s.origin+"/api/auth/session", nil)
	r.AddCookie(first)
	active := s.browserSession(r, time.Now())
	w := loginRequest(s, "/api/auth/logout", "", s.origin, first)
	if w.Code != 204 || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("Logout did not clear cookie")
	}
	if active.ctx.Err() == nil || s.hasSession(r, time.Now()) {
		t.Fatal("Logout left a live session")
	}
	r2 := httptest.NewRequest("GET", s.origin+"/api/auth/session", nil)
	r2.AddCookie(second)
	if !s.hasSession(r2, time.Now()) {
		t.Fatal("Logout revoked another browser's session")
	}
	directory := filepath.Dir(s.sessions.path)
	s.sessions.close()
	var err error
	s.sessions, err = openSessionStore(directory, s.sessionCredential())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.sessions.close)
	if s.hasSession(r, time.Now()) || !s.hasSession(r2, time.Now()) {
		t.Fatal("Restart lost durable logout state")
	}
}

func TestCookieSessionsKeepOriginChecksAndBasicCLICompatibility(t *testing.T) {
	s := sessionServer(t)
	w := httptest.NewRecorder()
	if err := s.setSession(w, time.Now()); err != nil {
		t.Fatal(err)
	}
	cookie := w.Result().Cookies()[0]
	for _, tc := range []struct {
		method, origin, upgrade string
		want                    int
	}{
		{"POST", s.origin, "", 200}, {"POST", "", "", 403}, {"POST", "https://evil.test", "", 403},
		{"GET", "", "websocket", 403}, {"GET", "https://evil.test", "websocket", 403},
	} {
		r := httptest.NewRequest(tc.method, s.origin+"/api/console", nil)
		r.AddCookie(cookie)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Upgrade", tc.upgrade)
		w := httptest.NewRecorder()
		s.authorize(w, r)
		if w.Code != tc.want {
			t.Fatal("Origin bypass", tc, w.Code)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		r := httptest.NewRequest(method, s.origin+"/api/console", nil)
		r.SetBasicAuth("admin", "password")
		w := httptest.NewRecorder()
		if !s.authorize(w, r) || w.Header().Get("Set-Cookie") != "" {
			t.Fatal("CLI Basic authentication changed")
		}
		r.Header.Set("Sec-Fetch-Mode", "cors")
		w = httptest.NewRecorder()
		if s.authorize(w, r) || w.Code != 401 || w.Header().Get("WWW-Authenticate") != "" {
			t.Fatal("Browser reused cached Basic credentials")
		}
	}
}

func TestLoginValidationAndSharedThrottling(t *testing.T) {
	s := sessionServer(t)
	for _, tc := range []struct {
		body, origin string
		want         int
	}{
		{`{"username":"missing","password":"password"}`, s.origin, 401},
		{`{"username":"admin","password":"wrong"}`, s.origin, 401},
		{`{"username":"admin","password":"password"}`, "", 403},
		{`{"username":"admin","password":"password"}`, "https://evil.test", 403},
		{`{"username":"admin","password":"password","extra":true}`, s.origin, 400},
		{`{"username":"admin","password":"password"}{}`, s.origin, 400},
		{`{"password":"` + strings.Repeat("a", 9000) + `"}`, s.origin, 400},
	} {
		w := loginRequest(s, "/api/auth/login", tc.body, tc.origin, nil)
		if w.Code != tc.want || w.Header().Get("WWW-Authenticate") != "" || len(w.Result().Cookies()) != 0 {
			t.Fatal("Unexpected login response", w.Code, tc.want)
		}
		if tc.want == 401 && w.Body.String() != "{\"error\":\"Invalid username or password.\"}\n" {
			t.Fatal("Credential failure disclosed details")
		}
	}
	for i := 0; i < 8; i++ {
		r := httptest.NewRequest("GET", s.origin+"/api/missing", nil)
		r.SetBasicAuth("admin", "wrong")
		s.authorize(httptest.NewRecorder(), r)
	}
	w := loginRequest(s, "/api/auth/login", `{"username":"admin","password":"password"}`, s.origin, nil)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("Basic requests bypassed login throttle", w.Code)
	}
}

func TestSessionStoreFailsClosedAndRejectsConcurrentWriters(t *testing.T) {
	s := sessionServer(t)
	directory := filepath.Dir(s.sessions.path)
	if extra, err := openSessionStore(directory, s.sessionCredential()); err == nil {
		extra.close()
		t.Fatal("Two writers opened one store")
	}
	s.sessions.close()
	if err := os.WriteFile(filepath.Join(directory, "sessions.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if extra, err := openSessionStore(directory, s.sessionCredential()); err == nil {
		extra.close()
		t.Fatal("Corrupt session store accepted")
	}
}

func TestPasswordRotationInvalidatesStoredSessions(t *testing.T) {
	s := sessionServer(t)
	w := httptest.NewRecorder()
	if err := s.setSession(w, time.Now()); err != nil {
		t.Fatal(err)
	}
	cookie := w.Result().Cookies()[0]
	directory := filepath.Dir(s.sessions.path)
	s.sessions.close()
	s.password = sha256.Sum256([]byte("new password"))
	var err error
	s.sessions, err = openSessionStore(directory, s.sessionCredential())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.sessions.close)
	r := httptest.NewRequest("GET", s.origin+"/api/auth/session", nil)
	r.AddCookie(cookie)
	if s.hasSession(r, time.Now()) {
		t.Fatal("Password rotation retained prior sessions")
	}
	var saved sessionFile
	data, _ := os.ReadFile(s.sessions.path)
	json.Unmarshal(data, &saved)
	if len(saved.Sessions) != 0 {
		t.Fatal("Old session hashes survived password rotation")
	}
}

func TestSessionRevocationAndExpiryCloseBrowserStreams(t *testing.T) {
	for _, expires := range []bool{false, true} {
		t.Run(map[bool]string{false: "logout", true: "expiry"}[expires], func(t *testing.T) {
			s := sessionServer(t)
			s.consoleEnabled = true
			s.api = &consoleAPI{actors: []*pb.Actor{{Metadata: &pb.ResourceMetadata{Name: "test-agent", Uid: "uid"}, ActorTemplate: ref("codex"), Status: &pb.ActorStatus{State: pb.ActorState_ACTOR_STATE_RUNNING}}}}
			bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/ws" {
					w.Header().Set("Content-Type", "text/event-stream")
					io.WriteString(w, "data: ready\n\n")
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				connection, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer connection.Close()
				for {
					kind, message, err := connection.ReadMessage()
					if err != nil {
						return
					}
					if connection.WriteMessage(kind, message) != nil {
						return
					}
				}
			}))
			defer bridge.Close()
			router := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, buffer, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer connection.Close()
				upstream, err := net.Dial("tcp", bridge.Listener.Addr().String())
				if err != nil {
					return
				}
				defer upstream.Close()
				buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
				buffer.Flush()
				go func() { io.Copy(upstream, buffer); upstream.Close() }()
				io.Copy(connection, upstream)
			}))
			defer router.Close()
			config := router.Client().Transport.(*http.Transport).TLSClientConfig
			s.transport = &http.Transport{TLSClientConfig: config, DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&tls.Dialer{Config: config}).DialContext(ctx, network, router.Listener.Addr().String())
			}}
			panel := httptest.NewServer(s)
			defer panel.Close()
			issued := time.Now()
			if expires {
				issued = issued.Add(-sessionLifetime + 3*time.Second)
			}
			w := httptest.NewRecorder()
			if err := s.setSession(w, issued); err != nil {
				t.Fatal(err)
			}
			cookie := w.Result().Cookies()[0]
			path := "/api/console/agents/test-agent/uid/bridge"
			connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(panel.URL, "http")+path+"/ws", http.Header{"Cookie": []string{cookie.String()}, "Origin": []string{s.origin}})
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			connection.SetReadDeadline(time.Now().Add(6 * time.Second))
			if err := connection.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
				t.Fatal(err)
			}
			if _, _, err := connection.ReadMessage(); err != nil {
				t.Fatal(err)
			}
			request, _ := http.NewRequest("GET", panel.URL+path+"/api/events", nil)
			request.AddCookie(cookie)
			response, err := (&http.Client{Timeout: 6 * time.Second}).Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			reader := bufio.NewReader(response.Body)
			if line, err := reader.ReadString('\n'); err != nil || line != "data: ready\n" {
				t.Fatal("Stream did not connect", err)
			}
			if !expires {
				if result := loginRequest(s, "/api/auth/logout", "", s.origin, cookie); result.Code != 204 {
					t.Fatal(result.Code)
				}
			}
			if _, _, err := connection.ReadMessage(); err == nil {
				t.Fatal("Revoked session retained its WebSocket")
			}
			if _, err := io.ReadAll(reader); err == nil {
				t.Fatal("Revoked session retained its HTTP stream")
			}
		})
	}
}
