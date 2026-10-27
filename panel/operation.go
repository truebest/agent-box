package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

const operationHeartbeat = 15 * time.Second

func operationRequest(r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) >= 3 && parts[0] == "api" && parts[1] == "agents" {
		if r.Method == "DELETE" && len(parts) == 3 {
			return true
		}
		return r.Method == "POST" && len(parts) == 4 && (parts[3] == "resume" || parts[3] == "suspend" || parts[3] == "revert")
	}
	return r.Method == "POST" && len(parts) == 6 && parts[0] == "api" && parts[1] == "console" && parts[2] == "agents" && (parts[5] == "connect" || parts[5] == "resume")
}

type operationResponse struct {
	status int
	header http.Header
	bytes.Buffer
}

func (w *operationResponse) Header() http.Header { return w.header }
func (w *operationResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *operationResponse) Write(data []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.Buffer.Write(data)
}

func streamHeartbeat(w http.ResponseWriter) error {
	if _, err := io.WriteString(w, "\n"); err != nil {
		return err
	}
	return http.NewResponseController(w).Flush()
}

func streamOperation(w http.ResponseWriter, r *http.Request, handler http.HandlerFunc, interval time.Duration) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	if streamHeartbeat(w) != nil {
		return
	}
	done := make(chan *operationResponse, 1)
	go func() {
		response := &operationResponse{header: make(http.Header)}
		defer func() {
			if recover() != nil {
				response.status = http.StatusInternalServerError
				response.Reset()
				response.WriteString("Operation failed. Check sandbox state before retrying.")
			}
			if response.status == 0 {
				response.status = http.StatusOK
			}
			done <- response
		}()
		handler(response, r)
	}()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if streamHeartbeat(w) != nil {
				return
			}
		case response := <-done:
			json.NewEncoder(w).Encode(struct {
				Status int    `json:"status"`
				Body   string `json:"body"`
			}{response.status, response.String()})
			return
		}
	}
}
