package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
)

func TestOperationHeartbeatsPrecedeCompletionAndPreserveErrors(t *testing.T) {
	release := make(chan struct{})
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		streamOperation(w, r, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			select {
			case <-release:
				http.Error(w, "Snapshot unavailable", http.StatusConflict)
			case <-r.Context().Done():
			}
		}, 5*time.Millisecond)
	}))
	defer upstream.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Post(upstream.URL, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for i := 0; i < 3; i++ {
		line, err := reader.ReadString('\n')
		if err != nil || line != "\n" {
			t.Fatal("Missing heartbeat while the operation is blocked", line, err)
		}
	}
	close(release)
	var result struct {
		Status int
		Body   string
	}
	if err := json.NewDecoder(reader).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Status != 409 || result.Body != "Snapshot unavailable\n" || calls.Load() != 1 {
		t.Fatal("Operation error or delivery count changed", result, calls.Load())
	}
}

func TestOperationDisconnectCancelsWorker(t *testing.T) {
	stopped := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		streamOperation(w, r, func(_ http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
			close(stopped)
		}, 5*time.Millisecond)
	}))
	defer upstream.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "POST", upstream.URL, nil)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	response.Body.Close()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Disconnected operation retained its request context")
	}
}

func TestOperationStreamRetainsAuthorizationOriginAndUIDChecks(t *testing.T) {
	for _, stream := range []bool{false, true} {
		for _, scenario := range []string{"unauthorized", "foreign origin", "stale uid"} {
			t.Run(scenario+"/"+map[bool]string{false: "json", true: "stream"}[stream], func(t *testing.T) {
				s := sessionServer(t)
				api := &fakeAPI{uid: "current", state: pb.ActorState_ACTOR_STATE_SUSPENDED}
				s.api = api
				r := httptest.NewRequest("POST", "/api/agents/test/resume?uid=old", nil)
				if stream {
					r.Header.Set("Accept", "application/x-ndjson")
				}
				want := http.StatusNotFound
				if scenario == "unauthorized" {
					want = http.StatusUnauthorized
				} else {
					r.SetBasicAuth("admin", "password")
				}
				if scenario == "foreign origin" {
					r.Header.Set("Origin", "https://evil.example")
					want = http.StatusForbidden
				}
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				got := w.Code
				if strings.HasPrefix(w.Header().Get("Content-Type"), "application/x-ndjson") {
					var result struct{ Status int }
					if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
						t.Fatal(err)
					}
					got = result.Status
				}
				if got != want || len(api.calls) != 0 {
					t.Fatal("Mutation passed a security check", got, want, api.calls)
				}
			})
		}
	}
}

func TestOperationWorkerPanicReturnsGenericFailure(t *testing.T) {
	w := httptest.NewRecorder()
	streamOperation(w, httptest.NewRequest("POST", "/", nil), func(http.ResponseWriter, *http.Request) {
		panic("private diagnostic")
	}, time.Second)
	var result struct {
		Status int
		Body   string
	}
	if err := json.NewDecoder(w.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Status != 500 || strings.Contains(result.Body, "private diagnostic") {
		t.Fatal(result)
	}
}
