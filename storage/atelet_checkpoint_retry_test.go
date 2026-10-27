package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/agent-substrate/substrate/internal/objectstoreplugin"
	"github.com/agent-substrate/substrate/internal/objectstoreplugin/objectstoreplugintest"
	"github.com/agent-substrate/substrate/internal/proto/ateletpb"
	"github.com/agent-substrate/substrate/internal/proto/ateompb"
	objectstorev1 "github.com/agent-substrate/substrate/pkg/proto/objectstorepb/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type preparedCaptureFixture struct {
	directory string
	calls     int
}

func (c *preparedCaptureFixture) CheckpointWorkload(context.Context, *ateompb.CheckpointWorkloadRequest, ...grpc.CallOption) (*ateompb.CheckpointWorkloadResponse, error) {
	c.calls++
	if c.calls > 1 {
		return nil, status.Error(codes.Internal, "sandbox was removed by the first checkpoint")
	}
	if err := os.WriteFile(filepath.Join(c.directory, "checkpoint.img"), []byte("retained process and files"), 0600); err != nil {
		return nil, err
	}
	return &ateompb.CheckpointWorkloadResponse{SnapshotFiles: []string{"checkpoint.img"}}, nil
}

type canceledCheckpointUpload struct {
	objectstorev1.NodeProviderClient
	calls int
}

func (c *canceledCheckpointUpload) UploadSnapshot(ctx context.Context, req *objectstorev1.UploadSnapshotRequest, options ...grpc.CallOption) (*objectstorev1.UploadSnapshotResponse, error) {
	c.calls++
	if c.calls == 1 {
		return nil, status.Error(codes.Canceled, "upload deadline expired after capture")
	}
	return c.NodeProviderClient.UploadSnapshot(ctx, req, options...)
}

func TestCheckpointRetryAfterCanceledExternalArchive(t *testing.T) {
	t.Setenv("ATE_SNAPSHOT_ARCHIVE", "tar.zst")
	dir := t.TempDir()
	capture := &preparedCaptureFixture{directory: dir}
	req := validCheckpointRequest()
	store := &orderedObjectStorage{}
	plugin, err := objectstoreplugin.NewNodePlugin(store, "/")
	if err != nil {
		t.Fatal(err)
	}
	plugin.SnapshotArchive = true
	upload := &canceledCheckpointUpload{NodeProviderClient: objectstoreplugintest.NodeClient(plugin)}
	herder := &AteomHerder{objectStorePlugin: upload, snapshotScratchDir: t.TempDir()}
	for attempt := 0; attempt < 2; attempt++ {
		response, err := checkpointWithPreparedResult(context.Background(), req, dir, capture, &ateompb.CheckpointWorkloadRequest{})
		if err != nil {
			t.Fatal(err)
		}
		record := &sandboxAssetsRecord{SandboxClass: "gvisor", PauseImage: testPauseImage, SnapshotFiles: response.GetSnapshotFiles()}
		err = herder.uploadExternalCheckpoint(context.Background(), req, dir, record)
		if attempt == 0 && status.Code(err) != codes.Canceled {
			t.Fatalf("first upload = %v", err)
		}
		if attempt == 1 && err != nil {
			t.Fatal(err)
		}
	}
	if capture.calls != 1 || upload.calls != 2 || len(store.puts) != 1 {
		t.Fatalf("capture=%d upload=%d objects=%d", capture.calls, upload.calls, len(store.puts))
	}
	data, err := os.ReadFile(filepath.Join(dir, preparedCheckpointName))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(req.GetActorName())) || bytes.Contains(data, []byte(req.GetSnapshot().GetObject().GetSnapshotUri())) {
		t.Fatal("request data persisted instead of its fingerprint")
	}
}

func TestPreparedCheckpointRejectsChangedIdentityAndFiles(t *testing.T) {
	for _, change := range []string{"actor", "snapshot", "worker", "fidelity", "file", "symlink", "record"} {
		t.Run(change, func(t *testing.T) {
			dir := t.TempDir()
			capture := &preparedCaptureFixture{directory: dir}
			req := validCheckpointRequest()
			if _, err := checkpointWithPreparedResult(context.Background(), req, dir, capture, &ateompb.CheckpointWorkloadRequest{}); err != nil {
				t.Fatal(err)
			}
			retry := proto.Clone(req).(*ateletpb.CheckpointRequest)
			switch change {
			case "actor":
				retry.ActorUid = "another-actor"
			case "snapshot":
				retry.Snapshot.SnapshotUuid = "another-snapshot"
			case "worker":
				retry.WorkerPodUid = "replacement-worker"
			case "fidelity":
				retry.Snapshot.Fidelity = ateletpb.SnapshotFidelity_SNAPSHOT_FIDELITY_ROOTFS
			case "file":
				if err := os.WriteFile(filepath.Join(dir, "checkpoint.img"), []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(filepath.Join(dir, "checkpoint.img")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("another-file", filepath.Join(dir, "checkpoint.img")); err != nil {
					t.Fatal(err)
				}
			case "record":
				if err := os.WriteFile(filepath.Join(dir, preparedCheckpointName), []byte("partial"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := checkpointWithPreparedResult(context.Background(), retry, dir, capture, &ateompb.CheckpointWorkloadRequest{}); status.Code(err) != codes.FailedPrecondition {
				t.Fatalf("changed %s accepted: %v", change, err)
			}
			if capture.calls != 1 {
				t.Fatal("checkpoint was repeated after capture")
			}
		})
	}
}
