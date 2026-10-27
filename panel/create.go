package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
)

func sandboxTemplate() string {
	if name := os.Getenv("SANDBOX_TEMPLATE"); name != "" {
		return name
	}
	return "sandbox-v1"
}

type createRequest struct {
	ProfileID string `json:"profile_id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Model     string `json:"model"`
	Cwd       string `json:"cwd"`
	Prompt    string `json:"prompt"`
}

func (data *createRequest) validate() error {
	if data.Kind != "none" && !kinds[data.Kind] || data.Name != "" && !validName.MatchString(data.Name) {
		return errors.New("Invalid sandbox name or agent")
	}
	if data.Kind == "none" {
		if data.Model != "" || data.Cwd != "" || data.Prompt != "" {
			return errors.New("Agent settings require an agent")
		}
		return nil
	}
	if data.Model == "" && data.Kind != "devin" {
		data.Model = "gpt-6.1-sol"
	}
	if data.Cwd == "" {
		data.Cwd = "/workspace"
	}
	if len(data.Model) > 128 || strings.ContainsFunc(data.Model, func(c rune) bool { return unicode.IsSpace(c) || unicode.IsControl(c) }) ||
		len(data.Cwd) > 4096 || strings.ContainsRune(data.Cwd, 0) || path.Clean(data.Cwd) != data.Cwd || (data.Cwd != "/workspace" && !strings.HasPrefix(data.Cwd, "/workspace/")) {
		return errors.New("Invalid model or directory; use a directory inside /workspace")
	}
	if data.Prompt != "" && (!utf8.ValidString(data.Prompt) || strings.TrimSpace(data.Prompt) == "" || len(data.Prompt) > 65536 || strings.ContainsFunc(data.Prompt, func(c rune) bool { return c < 32 && c != '\n' && c != '\t' })) {
		return errors.New("Initial prompt must contain 1–65536 bytes of text")
	}
	return nil
}

type createEvent struct {
	Type           string          `json:"type"`
	Stage          string          `json:"stage,omitempty"`
	Status         string          `json:"status,omitempty"`
	Name           string          `json:"name"`
	UID            string          `json:"uid,omitempty"`
	Actor          json.RawMessage `json:"actor,omitempty"`
	Error          string          `json:"error,omitempty"`
	PromptDelivery string          `json:"prompt_delivery,omitempty"`
	resource       *pb.Actor
	err            error
}

func generatedSandboxName() (string, error) {
	var random [4]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return "sandbox-" + hex.EncodeToString(random[:]), nil
}

func (s *server) create(ctx context.Context, data createRequest, emit func(createEvent)) {
	event := createEvent{Type: "stage", Stage: "sandbox", Status: "running", Name: data.Name}
	if data.Prompt != "" {
		event.PromptDelivery = "not_sent"
	}
	var actor *pb.Actor
	var err error
	defer func() {
		event.resource = actor
		if actor != nil {
			event.UID = actor.GetMetadata().GetUid()
			event.Actor, _ = protojson.Marshal(actor)
		}
		if err != nil {
			event.Type, event.Status, event.Error, event.err = "error", "failed", err.Error(), err
		} else {
			event.Type, event.Stage, event.Status = "complete", "", ""
		}
		emit(event)
	}()
	if s.workerManager == nil && data.ProfileID != "" {
		err = status.Error(codes.FailedPrecondition, "Worker profiles are not enabled")
		return
	}
	generated := data.Name == ""
	for attempt := 0; attempt < 5; attempt++ {
		if generated {
			data.Name, err = generatedSandboxName()
			if err != nil {
				return
			}
		}
		event.Name = data.Name
		unlock := s.lock(data.Name)
		// Runtime routing takes the route gate before the placement lock.
		gate := s.routeLock(data.Name)
		gate.Lock()
		templateName := sandboxTemplate()
		if m := s.workerManager; m != nil {
			m.placement.RLock()
			templateName, err = m.template(ctx, data.ProfileID)
			if err != nil {
				m.placement.RUnlock()
				gate.Unlock()
				unlock()
				return
			}
		}
		actor, err = s.api.CreateActor(ctx, &pb.CreateActorRequest{Actor: &pb.Actor{
			Metadata: &pb.ResourceMetadata{Atespace: space, Name: data.Name}, ActorTemplate: ref(templateName),
		}})
		if s.workerManager != nil {
			s.workerManager.placement.RUnlock()
		}
		gate.Unlock()
		if generated && status.Code(err) == codes.AlreadyExists {
			unlock()
			continue
		}
		defer unlock()
		break
	}
	if err != nil {
		return
	}
	event.UID = actor.GetMetadata().GetUid()
	emit(event)
	policy := &pb.EgressPolicy{Metadata: &pb.ResourceMetadata{Atespace: space, Name: "default"}, Rules: []*pb.EgressRule{
		{TlsPassthrough: &pb.TlsPassthroughRule{Hostnames: []string{"*"}, Ports: &pb.Ports{Numbers: []int32{443}}}},
		{Http: &pb.HttpRule{Hostnames: []string{"*"}, Ports: &pb.Ports{Numbers: []int32{80}}}},
	}}
	if _, err = s.api.CreateActorEgressPolicy(ctx, &pb.CreateActorEgressPolicyRequest{Actor: ref(data.Name), EgressPolicy: policy}); err != nil {
		return
	}
	resumed, resumeError := s.resumeAgent(ctx, data.Name, data.Kind)
	if resumed != nil {
		actor = resumed
	}
	if err = resumeError; err != nil {
		return
	}
	if data.Kind != "none" {
		event.Status = "done"
		emit(event)
		event.Stage, event.Status = "agent", "running"
		emit(event)
	}
	body, _ := json.Marshal(map[string]string{"kind": data.Kind, "model": data.Model, "cwd": data.Cwd})
	if err = s.checkSession(ctx, data.Name, "POST", body, data.Prompt != ""); err != nil {
		return
	}
	event.Status = "done"
	emit(event)
	if data.Prompt != "" {
		event.Stage, event.Status, event.PromptDelivery = "prompt", "running", "uncertain"
		emit(event)
		body, _ = json.Marshal(map[string]string{"prompt": data.Prompt})
		var response *http.Response
		response, err = s.workload(ctx, data.Name, "POST", "/prompt", body)
		if err != nil {
			err = errors.New("Prompt delivery is uncertain. Check the conversation in Superterminal before sending again")
			return
		}
		defer response.Body.Close()
		var result struct {
			Accepted bool `json:"accepted"`
		}
		if response.StatusCode != http.StatusAccepted || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result) != nil || !result.Accepted {
			err = errors.New("Prompt acceptance was not confirmed. Check Superterminal before sending again")
			return
		}
		event.Status, event.PromptDelivery = "done", "accepted"
		emit(event)
	}
}

func (s *server) createRoute(w http.ResponseWriter, r *http.Request) {
	var data createRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&data) != nil || decoder.Decode(new(any)) != io.EOF {
		http.Error(w, "Invalid create request", http.StatusBadRequest)
		return
	}
	if err := data.validate(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), sandboxOperationTimeout)
	// The bounded worker finishes an admitted create even after its browser disconnects.
	events := make(chan createEvent, 16)
	go func() {
		defer cancel()
		defer close(events)
		s.create(ctx, data, func(event createEvent) { events <- event })
	}()
	stream := r.URL.Query().Get("stream") == "1"
	if stream {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store, no-transform")
	}
	ticker := time.NewTicker(operationHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if stream && streamHeartbeat(w) != nil {
				return
			}
		case event, open := <-events:
			if !open {
				return
			}
			if stream {
				if json.NewEncoder(w).Encode(event) != nil || http.NewResponseController(w).Flush() != nil {
					return
				}
			} else if event.Type == "error" {
				s.fail(w, event.err)
				return
			} else if event.Type == "complete" {
				replyProto(w, event.resource)
				return
			}
		}
	}
}
