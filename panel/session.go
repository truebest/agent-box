package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const sessionCookieName = "__Host-agent-box-session"
const sessionLifetime = 7 * 24 * time.Hour
const maxSessions = 256

var errSessionCapacity = errors.New("session capacity reached")

type panelSession struct {
	expires time.Time
	ctx     context.Context
	cancel  context.CancelFunc
}
type sessionFile struct {
	Credential string           `json:"credential"`
	Sessions   map[string]int64 `json:"sessions"`
}
type sessionStore struct {
	mu         sync.Mutex
	path       string
	credential string
	sessions   map[string]*panelSession
	lock       *os.File
}

func (s *server) sessionCredential() string {
	mac := hmac.New(sha256.New, s.bridgeKey)
	mac.Write([]byte("panel-sessions-v2:" + s.origin + ":"))
	mac.Write(s.password[:])
	return hex.EncodeToString(mac.Sum(nil))
}

func openSessionStore(directory, credential string) (*sessionStore, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return nil, err
	}
	store := &sessionStore{path: filepath.Join(directory, "sessions.json"), credential: credential, sessions: map[string]*panelSession{}}
	lock, err := os.OpenFile(filepath.Join(directory, "sessions.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lock.Chmod(0600); err != nil {
		lock.Close()
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("session store is already in use")
	}
	store.lock = lock
	opened := false
	defer func() {
		if !opened {
			store.close()
		}
	}()
	file, err := os.Open(store.path)
	if errors.Is(err, os.ErrNotExist) {
		err = store.save(map[string]int64{})
		opened = err == nil
		return store, err
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if err := file.Chmod(0600); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var saved sessionFile
	if decoder.Decode(&saved) != nil || decoder.Decode(new(any)) != io.EOF || saved.Sessions == nil || len(saved.Sessions) > maxSessions || len(saved.Credential) != 64 {
		return nil, errors.New("invalid session store")
	}
	if !hmac.Equal([]byte(saved.Credential), []byte(credential)) {
		err = store.save(map[string]int64{})
		opened = err == nil
		return store, err
	}
	for digest, expires := range saved.Sessions {
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != sha256.Size {
			return nil, errors.New("invalid session store")
		}
		if deadline := time.Unix(expires, 0); deadline.After(time.Now()) {
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			store.sessions[digest] = &panelSession{deadline, ctx, cancel}
		}
	}
	opened = true
	return store, nil
}

func (store *sessionStore) save(sessions map[string]int64) (err error) {
	file, err := os.CreateTemp(filepath.Dir(store.path), ".sessions-")
	if err != nil {
		return err
	}
	defer func() { file.Close(); os.Remove(file.Name()) }()
	if err = json.NewEncoder(file).Encode(sessionFile{store.credential, sessions}); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(file.Name(), store.path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(store.path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (store *sessionStore) records(now time.Time) map[string]int64 {
	result := map[string]int64{}
	for digest, session := range store.sessions {
		if session.expires.After(now) {
			result[digest] = session.expires.Unix()
		} else {
			session.cancel()
			delete(store.sessions, digest)
		}
	}
	return result
}

func (store *sessionStore) close() {
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, session := range store.sessions {
		session.cancel()
	}
	if store.lock != nil {
		store.lock.Close()
		store.lock = nil
	}
}

func sessionDigest(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func (s *server) browserSession(r *http.Request, now time.Time) *panelSession {
	if s.sessions == nil || len(s.bridgeKey) != sha256.Size || s.sessions.credential != s.sessionCredential() {
		return nil
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || len(cookie.Value) != 64 {
		return nil
	}
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	session := s.sessions.sessions[sessionDigest(cookie.Value)]
	if session == nil || !session.expires.After(now) || session.ctx.Err() != nil {
		return nil
	}
	return session
}

func (s *server) hasSession(r *http.Request, now time.Time) bool {
	return s.browserSession(r, now) != nil
}

func (s *server) setSession(w http.ResponseWriter, now time.Time) error {
	if s.sessions == nil || len(s.bridgeKey) != sha256.Size {
		return errors.New("session store unavailable")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	token := hex.EncodeToString(random)
	expires := now.Add(sessionLifetime).Truncate(time.Second)
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	records := s.sessions.records(now)
	if len(records) >= maxSessions {
		return errSessionCapacity
	}
	digest := sessionDigest(token)
	records[digest] = expires.Unix()
	if err := s.sessions.save(records); err != nil {
		return err
	}
	ctx, cancel := context.WithDeadline(context.Background(), expires)
	s.sessions.sessions[digest] = &panelSession{expires, ctx, cancel}
	http.SetCookie(w, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", Expires: expires,
		MaxAge: int(sessionLifetime.Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	return nil
}

func (s *server) revokeSession(r *http.Request) error {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || s.sessions == nil {
		return nil
	}
	store := s.sessions
	store.mu.Lock()
	defer store.mu.Unlock()
	digest := sessionDigest(cookie.Value)
	session := store.sessions[digest]
	if session == nil {
		return nil
	}
	records := store.records(time.Now())
	delete(records, digest)
	if err := store.save(records); err != nil {
		return err
	}
	delete(store.sessions, digest)
	session.cancel()
	return nil
}
