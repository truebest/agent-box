package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type loginAttempts struct {
	start time.Time
	count int
}
type loginLimiter struct {
	mu     sync.Mutex
	byIP   map[string]loginAttempts
	global loginAttempts
}

func (s *server) validCredentials(username, password string) bool {
	hash := sha256.Sum256([]byte(password))
	userHash := sha256.Sum256([]byte(username))
	adminHash := sha256.Sum256([]byte("admin"))
	return subtle.ConstantTimeCompare(hash[:], s.password[:])&subtle.ConstantTimeCompare(userHash[:], adminHash[:]) == 1
}

func (s *server) validBasic(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Mode") != "" {
		return false
	}
	user, password, ok := r.BasicAuth()
	return ok && s.validCredentials(user, password)
}

func (s *server) checkCredentials(r *http.Request, username, password string) (valid, limited bool) {
	limiter := &s.loginLimiter
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := time.Now()
	if now.Sub(limiter.global.start) >= time.Minute {
		limiter.global = loginAttempts{start: now}
	}
	if limiter.byIP == nil {
		limiter.byIP = map[string]loginAttempts{}
	}
	for key, attempts := range limiter.byIP {
		if now.Sub(attempts.start) >= time.Minute {
			delete(limiter.byIP, key)
		}
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	attempts := limiter.byIP[ip]
	if limiter.global.count >= 100 || attempts.count >= 10 {
		return false, true
	}
	if s.validCredentials(username, password) {
		return true, false
	}
	if attempts.start.IsZero() {
		attempts.start = now
	}
	attempts.count++
	limiter.byIP[ip] = attempts
	limiter.global.count++
	return false, false
}

func authError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (s *server) authRoute(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/auth/session" && r.Method == "GET" {
		session := s.browserSession(r, time.Now())
		if session == nil {
			reply(w, map[string]bool{"authenticated": false})
		} else {
			reply(w, map[string]any{"authenticated": true, "expires_at": session.expires})
		}
		return
	}
	if r.URL.Path != "/api/auth/login" && r.URL.Path != "/api/auth/logout" && r.URL.Path != "/api/auth/session" {
		http.NotFound(w, r)
		return
	}
	if r.Method != "POST" || r.URL.Path == "/api/auth/session" {
		w.Header().Set("Allow", "POST")
		if r.URL.Path == "/api/auth/session" {
			w.Header().Set("Allow", "GET")
		}
		authError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if r.Header.Get("Origin") != s.origin || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		authError(w, http.StatusForbidden, "Origin denied")
		return
	}
	if r.URL.Path == "/api/auth/logout" {
		if err := s.revokeSession(r); err != nil {
			authError(w, http.StatusServiceUnavailable, "Sign out is temporarily unavailable. Try again.")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: "", Path: "/", MaxAge: -1,
			Expires: time.Unix(1, 0), Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		authError(w, http.StatusUnsupportedMediaType, "Expected a JSON sign-in request")
		return
	}
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Second))
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&credentials) != nil || decoder.Decode(new(any)) != io.EOF || len(credentials.Username) > 128 || len(credentials.Password) > 4096 {
		authError(w, http.StatusBadRequest, "Invalid sign-in request")
		return
	}
	valid, limited := s.checkCredentials(r, credentials.Username, credentials.Password)
	if limited {
		w.Header().Set("Retry-After", "60")
		authError(w, http.StatusTooManyRequests, "Too many sign-in attempts. Try again in a minute.")
		return
	}
	if !valid {
		authError(w, http.StatusUnauthorized, "Invalid username or password.")
		return
	}
	if err := s.revokeSession(r); err != nil {
		authError(w, http.StatusServiceUnavailable, "Sign in is temporarily unavailable. Try again.")
		return
	}
	if err := s.setSession(w, time.Now()); err != nil {
		authError(w, http.StatusServiceUnavailable, "Sign in is temporarily unavailable. Try again.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
