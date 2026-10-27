package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const workerPoolPath = "/apis/ate.dev/v1alpha1/namespaces/" + space + "/workerpools/agents"

type workerScaler struct {
	client *http.Client
	url    string
	token  string
	max    int
	gate   chan struct{}
}

type workerPool struct {
	Metadata struct {
		ResourceVersion string `json:"resourceVersion"`
	} `json:"metadata"`
	Spec struct {
		Replicas int `json:"replicas"`
	} `json:"spec"`
	Status struct {
		ReadyReplicas int `json:"readyReplicas"`
	} `json:"status"`
}

func newWorkerScaler(limit string) (*workerScaler, error) {
	if limit == "" || limit == "0" {
		return nil, nil
	}
	max, err := strconv.Atoi(limit)
	if err != nil || max < 1 || max > 64 {
		return nil, errors.New("WORKER_MAX_REPLICAS must be between 1 and 64, or 0 to disable")
	}
	ca, err := roots("/run/kubernetes/ca.crt")
	if err != nil {
		return nil, err
	}
	return &workerScaler{
		client: &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: ca}}, Timeout: 10 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		url: "https://kubernetes.default.svc", token: "/run/kubernetes/token", max: max, gate: make(chan struct{}, 1),
	}, nil
}

func (s *workerScaler) request(ctx context.Context, method, suffix string, body []byte, value any) (int, error) {
	token, err := os.ReadFile(s.token)
	if err != nil {
		return 0, errors.New("Worker autoscaling credential unavailable; retry Resume")
	}
	req, err := http.NewRequestWithContext(ctx, method, s.url+workerPoolPath+suffix, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	if method == http.MethodPatch {
		req.Header.Set("Content-Type", "application/merge-patch+json")
	}
	response, err := s.client.Do(req)
	if err != nil {
		return 0, errors.New("Worker autoscaling API unavailable; sandbox remains suspended, retry Resume")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict && method == http.MethodPatch {
		return response.StatusCode, nil
	}
	if response.StatusCode != http.StatusOK {
		return response.StatusCode, fmt.Errorf("Worker autoscaling API returned HTTP %d; sandbox remains suspended, retry Resume", response.StatusCode)
	}
	if value != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(value); err != nil {
			return response.StatusCode, errors.New("Invalid WorkerPool response")
		}
	}
	return response.StatusCode, nil
}

func workerCapacityError(err error) bool {
	return status.Code(err) == codes.ResourceExhausted && status.Convert(err).Message() == "no worker has room for the actor"
}

func (s *server) resumeActor(ctx context.Context, name string) (*pb.ResumeActorResponse, error) {
	if s.workerManager != nil {
		return s.workerManager.resume(ctx, name)
	}
	result, err := s.api.ResumeActor(ctx, &pb.ResumeActorRequest{Actor: ref(name)})
	scaler := s.workerScaler
	if !workerCapacityError(err) || scaler == nil {
		return result, err
	}
	select {
	case scaler.gate <- struct{}{}:
		defer func() { <-scaler.gate }()
	case <-ctx.Done():
		return nil, status.FromContextError(ctx.Err()).Err()
	}
	for {
		// Recheck after the previous request: its new Worker may have room for this sandbox too.
		result, err = s.api.ResumeActor(ctx, &pb.ResumeActorRequest{Actor: ref(name)})
		if !workerCapacityError(err) {
			return result, err
		}
		var pool workerPool
		if _, err = scaler.request(ctx, http.MethodGet, "", nil, &pool); err != nil {
			return nil, err
		}
		if pool.Metadata.ResourceVersion == "" || pool.Spec.Replicas < 0 {
			return nil, errors.New("Invalid WorkerPool response")
		}
		active := 0
		for token := ""; ; {
			page, e := s.api.ListWorkers(ctx, &pb.ListWorkersRequest{Options: &pb.ListOptions{PageSize: 100, PageToken: token}})
			if e != nil {
				return nil, e
			}
			for _, worker := range page.GetWorkers() {
				if worker.GetWorkerNamespace() == space && worker.GetWorkerPool() == "agents" && worker.GetLabels()["workload"] == space &&
					worker.GetStatus().GetState() == pb.WorkerState_WORKER_STATE_ACTIVE {
					active++
				}
			}
			token = page.GetNextPageToken()
			if token == "" {
				break
			}
		}
		// Pod readiness precedes Substrate registration; both must finish before adding another Worker.
		if pool.Status.ReadyReplicas >= pool.Spec.Replicas && active >= pool.Spec.Replicas {
			result, err = s.api.ResumeActor(ctx, &pb.ResumeActorRequest{Actor: ref(name)})
			if !workerCapacityError(err) {
				return result, err
			}
			if pool.Spec.Replicas >= scaler.max {
				return nil, status.Errorf(codes.ResourceExhausted, "All %d Workers are full (WORKER_MAX_REPLICAS limit). Sandbox remains suspended; suspend an idle sandbox or raise the limit, then use Resume.", scaler.max)
			}
			patch, _ := json.Marshal(map[string]any{
				"metadata": map[string]string{"resourceVersion": pool.Metadata.ResourceVersion},
				"spec":     map[string]int{"replicas": pool.Spec.Replicas + 1},
			})
			if _, err = scaler.request(ctx, http.MethodPatch, "/scale", patch, nil); err != nil {
				return nil, err
			}
		}
		select {
		case <-ctx.Done():
			return nil, status.FromContextError(ctx.Err()).Err()
		case <-time.After(time.Second):
		}
	}
}
