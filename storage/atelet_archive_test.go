package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/agent-substrate/substrate/internal/objectstoreplugin"
	"github.com/agent-substrate/substrate/internal/objectstoreplugin/objectstoreplugintest"
	"github.com/agent-substrate/substrate/internal/resources"
)

func TestUploadSnapshotSingleArchive(t *testing.T) {
	t.Setenv("ATE_SNAPSHOT_ARCHIVE", "tar.zst")
	store := &orderedObjectStorage{}
	plugin, err := objectstoreplugin.NewNodePlugin(store, "/")
	if err != nil {
		t.Fatal(err)
	}
	plugin.SnapshotArchive = true
	s := &AteomHerder{objectStorePlugin: objectstoreplugintest.NodeClient(plugin), snapshotScratchDir: t.TempDir()}
	dir := t.TempDir()
	rec := sandboxAssetsRecord{SandboxClass: "gvisor", PauseImage: testPauseImage, SnapshotFiles: []string{"a", "b"}}
	for _, f := range rec.SnapshotFiles {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(f), 0600); err != nil {
			t.Fatal(err)
		}
	}
	uri, err := resources.ParseSnapshotURI(pausedSnapshotURI)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.uploadSnapshot(context.Background(), uri, dir, &rec, "ate-demo", "counter"); err != nil {
		t.Fatal(err)
	}
	if len(store.puts) != 1 {
		t.Fatalf("puts: %v", store.puts)
	}
	manifest, err := s.fetchManifest(context.Background(), uri.String())
	if err != nil {
		t.Fatal(err)
	}
	back, err := unmarshalSandboxRecord(manifest)
	if err != nil || !slices.Equal(back.SnapshotFiles, rec.SnapshotFiles) {
		t.Fatalf("manifest: %v %v", back, err)
	}
	dst := t.TempDir()
	if err := s.fetchSnapshotFiles(context.Background(), uri.String(), dst, rec.SnapshotFiles); err != nil {
		t.Fatal(err)
	}
	for _, f := range rec.SnapshotFiles {
		got, err := os.ReadFile(filepath.Join(dst, f))
		if err != nil || string(got) != f {
			t.Fatalf("%s: %q %v", f, got, err)
		}
	}
}
