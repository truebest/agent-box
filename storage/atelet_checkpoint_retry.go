package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/agent-substrate/substrate/internal/proto/ateletpb"
	"github.com/agent-substrate/substrate/internal/proto/ateompb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const preparedCheckpointName = ".atelet-prepared-checkpoint.json"

type preparedCheckpointFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

type preparedCheckpoint struct {
	Version  int                      `json:"version"`
	Request  string                   `json:"request"`
	Response []byte                   `json:"response"`
	Files    []preparedCheckpointFile `json:"files"`
}

type checkpointCaptureClient interface {
	CheckpointWorkload(context.Context, *ateompb.CheckpointWorkloadRequest, ...grpc.CallOption) (*ateompb.CheckpointWorkloadResponse, error)
}

// A successful checkpoint removes the sandbox. Keep its result before the
// external upload so a canceled upload can be retried without checkpointing a
// sandbox that no longer exists. The fingerprint binds all request identities
// and the spec without persisting a request that may contain credentials.
func checkpointWithPreparedResult(ctx context.Context, req *ateletpb.CheckpointRequest, directory string, client checkpointCaptureClient, capture *ateompb.CheckpointWorkloadRequest) (*ateompb.CheckpointWorkloadResponse, error) {
	if req.GetUploadConfig().GetMode() != ateletpb.UploadMode_UPLOAD_MODE_IMMEDIATE {
		return client.CheckpointWorkload(ctx, capture)
	}
	encoded, err := (proto.MarshalOptions{Deterministic: true}).Marshal(req)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(digest[:])
	root, err := os.OpenRoot(directory)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	} else {
		defer root.Close()
		info, statErr := root.Lstat(preparedCheckpointName)
		if statErr == nil {
			if !info.Mode().IsRegular() || info.Size() > 1<<20 {
				return nil, status.Error(codes.FailedPrecondition, "Invalid prepared checkpoint record")
			}
			file, readErr := root.Open(preparedCheckpointName)
			if readErr != nil {
				return nil, readErr
			}
			data, readErr := io.ReadAll(io.LimitReader(file, 1<<20+1))
			if readErr = errors.Join(readErr, file.Close()); readErr != nil {
				return nil, readErr
			}
			if len(data) > 1<<20 {
				return nil, status.Error(codes.FailedPrecondition, "Prepared checkpoint record exceeds limit")
			}
			var prepared preparedCheckpoint
			if json.Unmarshal(data, &prepared) != nil || prepared.Version != 1 || prepared.Request != fingerprint {
				return nil, status.Error(codes.FailedPrecondition, "Prepared checkpoint belongs to another request or is invalid")
			}
			response := new(ateompb.CheckpointWorkloadResponse)
			if proto.Unmarshal(prepared.Response, response) != nil {
				return nil, status.Error(codes.FailedPrecondition, "Invalid prepared checkpoint response")
			}
			files, _, validateErr := checkpointSnapshotFiles(response, shouldHaveSnapshots(req))
			if validateErr != nil || len(files) != len(prepared.Files) {
				return nil, status.Error(codes.FailedPrecondition, "Invalid prepared checkpoint files")
			}
			for i, name := range files {
				meta := prepared.Files[i]
				info, e := root.Lstat(name)
				if e != nil || name != meta.Name || !info.Mode().IsRegular() || info.Size() != meta.Size || info.ModTime().UnixNano() != meta.Modified {
					return nil, status.Error(codes.FailedPrecondition, "Prepared checkpoint file changed; retain it for recovery")
				}
			}
			return response, nil
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return nil, statErr
		}
	}
	response, err := client.CheckpointWorkload(ctx, capture)
	if err != nil {
		return nil, err
	}
	files, _, err := checkpointSnapshotFiles(response, shouldHaveSnapshots(req))
	if err != nil {
		return nil, err
	}
	prepared := preparedCheckpoint{Version: 1, Request: fingerprint}
	prepared.Response, err = proto.Marshal(response)
	if err != nil {
		return nil, err
	}
	for _, name := range files {
		info, e := os.Lstat(filepath.Join(directory, name))
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("prepared checkpoint file is not regular: %s", name)
		}
		prepared.Files = append(prepared.Files, preparedCheckpointFile{Name: name, Size: info.Size(), Modified: info.ModTime().UnixNano()})
	}
	data, err := json.Marshal(prepared)
	if err != nil {
		return nil, err
	}
	if len(data) > 1<<20 {
		return nil, errors.New("prepared checkpoint record exceeds limit")
	}
	f, err := os.CreateTemp(directory, ".atelet-prepared-*.tmp")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(data)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return nil, err
	}
	if err := os.Rename(f.Name(), filepath.Join(directory, preparedCheckpointName)); err != nil {
		return nil, err
	}
	dir, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	if err := errors.Join(dir.Sync(), dir.Close()); err != nil {
		return nil, err
	}
	return response, nil
}
