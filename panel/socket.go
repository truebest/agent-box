package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

func inputMessage(legacy bool, kind int, data []byte) bool {
	if legacy {
		return kind == websocket.BinaryMessage && len(data) > 1 && data[0] == '0'
	}
	if kind != websocket.TextMessage {
		return false
	}
	var message struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &message) != nil {
		return false
	}
	return message.Type == "input" || message.Type == "keys" || message.Type == "submit"
}

func (s *server) socket(w http.ResponseWriter, r *http.Request, name, uid, target string, headers http.Header, dialer websocket.Dialer, legacy bool) {
	dialer.Subprotocols = websocket.Subprotocols(r)
	dialer.HandshakeTimeout = 15 * time.Second
	gate := s.routeLock(name)
	gate.RLock()
	if e := s.checkActorUID(r.Context(), name, uid); e != nil {
		gate.RUnlock()
		s.fail(w, e)
		return
	}
	release, e := s.admitRoute(r.Context(), "", false)
	if e != nil {
		gate.RUnlock()
		s.fail(w, e)
		return
	}
	upstream, response, e := dialer.DialContext(r.Context(), target, headers)
	release()
	gate.RUnlock()
	if e != nil {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		http.Error(w, "Sandbox WebSocket unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.Close()
	protocols := []string{}
	if upstream.Subprotocol() != "" {
		protocols = append(protocols, upstream.Subprotocol())
	}
	upgrader := websocket.Upgrader{Subprotocols: protocols, CheckOrigin: func(request *http.Request) bool { return request.Header.Get("Origin") == s.origin }}
	downstream, e := upgrader.Upgrade(w, r, nil)
	if e != nil {
		return
	}
	defer downstream.Close()
	stop := context.AfterFunc(r.Context(), func() {
		downstream.Close()
		upstream.Close()
	})
	defer stop()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.mu.Lock()
	if entry := s.activity[uid]; entry != nil && entry.suspending {
		s.mu.Unlock()
		return
	}
	if s.sockets == nil {
		s.sockets = map[string]map[*websocket.Conn]context.CancelFunc{}
	}
	if s.sockets[uid] == nil {
		s.sockets[uid] = map[*websocket.Conn]context.CancelFunc{}
	}
	s.sockets[uid][downstream] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.sockets[uid], downstream)
		if len(s.sockets[uid]) == 0 {
			delete(s.sockets, uid)
		}
		s.mu.Unlock()
	}()
	downstream.SetReadLimit(2 << 20)
	go func() {
		defer downstream.Close()
		for {
			kind, data, e := upstream.ReadMessage()
			if e != nil {
				return
			}
			if downstream.WriteMessage(kind, data) != nil {
				return
			}
		}
	}()
	for {
		kind, data, e := downstream.ReadMessage()
		if e != nil {
			return
		}
		if inputMessage(legacy, kind, data) {
			unlock := s.lock(name)
			allowed := ctx.Err() == nil && s.touch(uid, time.Now())
			if allowed {
				e = upstream.WriteMessage(kind, data)
			}
			unlock()
			if !allowed || e != nil {
				return
			}
		} else if upstream.WriteMessage(kind, data) != nil {
			return
		}
	}
}
