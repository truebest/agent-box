package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"github.com/gorilla/websocket"
)

type idleRecord struct {
	last       time.Time
	signature  string
	suspending bool
}

func (s *server) touch(uid string, now time.Time) bool {
	if uid == "" {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activity == nil {
		s.activity = map[string]*idleRecord{}
	}
	entry := s.activity[uid]
	if entry == nil {
		entry = &idleRecord{}
		s.activity[uid] = entry
	}
	if entry.suspending {
		return false
	}
	entry.last = now
	return true
}

func (s *server) observeIdle(uid, signature string, quiet bool, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activity == nil {
		s.activity = map[string]*idleRecord{}
	}
	entry := s.activity[uid]
	if entry == nil {
		entry = &idleRecord{last: now}
		s.activity[uid] = entry
	}
	if !quiet || entry.signature != signature {
		entry.last = now
	}
	entry.signature = signature
	if s.idleTimeout <= 0 || entry.suspending || now.Sub(entry.last) < s.idleTimeout {
		return false
	}
	entry.suspending = true
	return true
}

func (s *server) runtimeGate(ctx context.Context, name string, frozen bool) error {
	operation := "thaw"
	if frozen {
		operation = "freeze"
	}
	response, e := s.workload(ctx, name, "POST", "/runtime/"+operation, []byte(`{}`))
	if e != nil {
		return e
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("Cannot change runtime suspend gate")
	}
	return nil
}

func (s *server) probeIdle(ctx context.Context, name, uid string) (string, bool, error) {
	response, e := s.workload(ctx, name, "GET", "/runtime/idle", nil)
	if e != nil {
		return "", false, e
	}
	defer response.Body.Close()
	var state struct {
		Quiet       bool   `json:"quiet"`
		Signature   string `json:"signature"`
		ControlBusy bool   `json:"control_busy"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&state) != nil || state.Signature == "" {
		return "", false, errors.New("Herdr idle state is unknown")
	}
	if !state.Quiet && !state.ControlBusy {
		var signature []json.RawMessage
		var unknown []json.RawMessage
		if json.Unmarshal([]byte(state.Signature), &signature) != nil || len(signature) != 2 || json.Unmarshal(signature[1], &unknown) != nil {
			return "", false, errors.New("Herdr idle state is unknown")
		}
		if len(unknown) > 0 {
			client := &http.Client{Transport: s.bridgeTransport(name, uid), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			read := func() (*http.Response, error) {
				request, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:7317/api/idle", nil)
				request.Header.Set("Authorization", "Bearer "+s.bridgeToken(uid))
				return client.Do(request)
			}
			bridge, err := read()
			if err != nil || bridge.StatusCode == http.StatusNotFound {
				if bridge != nil {
					bridge.Body.Close()
				}
				if err = s.ensureBridge(ctx, name, uid); err != nil {
					return "", false, err
				}
				bridge, err = read()
			}
			if err != nil {
				return "", false, err
			}
			defer bridge.Body.Close()
			state.Quiet, state.Signature, state.ControlBusy = false, "", false
			if bridge.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(bridge.Body, 1<<20)).Decode(&state) != nil || state.Signature == "" {
				return "", false, errors.New("Agent process ownership is unavailable")
			}
		}
	}
	return state.Signature, state.Quiet && !state.ControlBusy, nil
}

func (s *server) suspendIdle(ctx context.Context, actor *pb.Actor) error {
	name, uid := actor.GetMetadata().GetName(), actor.GetMetadata().GetUid()
	unlock := s.lock(name)
	defer unlock()
	current, e := s.actor(ctx, name)
	if e != nil {
		return e
	}
	kind, e := s.actorKinds(ctx)
	if e != nil {
		return e
	}
	if current.GetMetadata().GetUid() != uid || current.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING || kind(current) == "" {
		return nil
	}
	template, e := s.api.GetActorTemplate(ctx, &pb.GetActorTemplateRequest{ActorTemplate: current.GetActorTemplate()})
	if e != nil {
		return e
	}
	config := template.GetSnapshotConfig()
	if config.GetPreferredFidelity() != pb.SnapshotFidelity_SNAPSHOT_FIDELITY_MEMORY || !strings.HasPrefix(config.GetStorageLocation(), "s3://") {
		return errors.New("Idle suspend requires external MEMORY snapshots")
	}
	signature, quiet, e := s.probeIdle(ctx, name, uid)
	if e != nil {
		s.observeIdle(uid, "", false, time.Now())
		return e
	}
	if !s.observeIdle(uid, signature, quiet, time.Now()) {
		return nil
	}
	defer func() {
		s.mu.Lock()
		if entry := s.activity[uid]; entry != nil {
			entry.suspending = false
			entry.last = time.Now()
		}
		s.mu.Unlock()
	}()
	if e := s.runtimeGate(ctx, name, true); e != nil {
		return e
	}
	completed := false
	defer func() {
		if !completed {
			thaw, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			s.runtimeGate(thaw, name, false)
		}
	}()
	latest, quiet, e := s.probeIdle(ctx, name, uid)
	if e != nil || !quiet || latest != signature {
		s.observeIdle(uid, latest, false, time.Now())
		return e
	}
	checked, e := s.actor(ctx, name)
	if e != nil {
		return e
	}
	if checked.GetMetadata().GetUid() != uid || checked.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
		return errors.New("Sandbox changed before suspend")
	}
	s.closeIdleSockets(uid)
	result, e := s.api.SuspendActor(ctx, &pb.SuspendActorRequest{Actor: ref(name)})
	if e != nil {
		return e
	}
	stopped := result.GetActor()
	if stopped.GetMetadata().GetUid() != uid || stopped.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_SUSPENDED || !hasMemorySnapshot(stopped) {
		return errors.New("Idle suspend has no confirmed durable snapshot")
	}
	completed = true
	log.Printf("Idle sandbox %s (%s) suspended with a completed MEMORY snapshot", name, uid)
	return nil
}

func hasMemorySnapshot(actor *pb.Actor) bool {
	for _, snapshot := range actor.GetStatus().GetSnapshots() {
		if snapshot.GetFidelity() == pb.SnapshotFidelity_SNAPSHOT_FIDELITY_MEMORY && snapshot.GetDurableSnapshot().GetStatus() == pb.SnapshotStorageStatus_SNAPSHOT_STORAGE_STATUS_COMPLETED {
			return true
		}
	}
	return false
}

func (s *server) closeIdleSockets(uid string) {
	s.mu.Lock()
	connections := map[*websocket.Conn]context.CancelFunc{}
	for connection, cancel := range s.sockets[uid] {
		connections[connection] = cancel
	}
	s.mu.Unlock()
	for connection, cancel := range connections {
		cancel()
		connection.Close()
	}
}

func (s *server) idleSweep(ctx context.Context) {
	kind, err := s.actorKinds(ctx)
	if err != nil {
		log.Printf("Idle policy catalog unavailable: %v", err)
		return
	}
	seen := map[string]bool{}
	for token := ""; ; {
		page, e := s.api.ListActors(ctx, &pb.ListActorsRequest{Atespace: space, Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
		if e != nil {
			log.Printf("Idle policy inventory unavailable: %v", e)
			return
		}
		for _, actor := range page.GetActors() {
			if kind(actor) == "" || actor.GetStatus().GetState() != pb.ActorState_ACTOR_STATE_RUNNING {
				continue
			}
			uid := actor.GetMetadata().GetUid()
			if uid == "" {
				continue
			}
			seen[uid] = true
			probe, cancel := context.WithTimeout(ctx, 5*time.Minute)
			e = s.suspendIdle(probe, actor)
			cancel()
			if e != nil {
				log.Printf("Idle policy skipped %s: %v", actor.GetMetadata().GetName(), e)
			}
		}
		token = page.GetNextPageToken()
		if token == "" {
			break
		}
	}
	s.mu.Lock()
	for uid := range s.activity {
		if !seen[uid] {
			delete(s.activity, uid)
		}
	}
	s.mu.Unlock()
}

func (s *server) runIdle(ctx context.Context) {
	if s.idleTimeout <= 0 {
		return
	}
	log.Printf("Automatic MEMORY snapshot after %s without user or agent activity", s.idleTimeout)
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		s.idleSweep(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *server) userAccess(w http.ResponseWriter, r *http.Request, actor *pb.Actor) bool {
	if s.touch(actor.GetMetadata().GetUid(), time.Now()) {
		return true
	}
	http.Error(w, "Sandbox is being suspended; resume it before sending input", http.StatusConflict)
	return false
}

func idleTimeout(value string) (time.Duration, error) {
	if value == "" {
		return 15 * time.Minute, nil
	}
	d, e := time.ParseDuration(value)
	if e != nil || d < 0 {
		return 0, fmt.Errorf("Invalid AGENT_IDLE_TIMEOUT")
	}
	return d, nil
}
