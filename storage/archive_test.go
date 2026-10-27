package objectstoreplugin

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/agent-substrate/substrate/internal/resources"
	"github.com/agent-substrate/substrate/pkg/objectstorage"
	objectstorev1 "github.com/agent-substrate/substrate/pkg/proto/objectstorepb/v1"
	"github.com/klauspost/compress/zstd"
)

type measuredArchiveStore struct {
	objectstorage.ObjectStorage
	read   int64
	closed int
}

type measuredArchiveReader struct {
	io.ReadCloser
	store *measuredArchiveStore
}

func (s *measuredArchiveStore) GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, error) {
	r, err := s.ObjectStorage.GetObject(ctx, bucket, key)
	if err != nil {
		return nil, err
	}
	return &measuredArchiveReader{ReadCloser: r, store: s}, nil
}

func (r *measuredArchiveReader) Read(b []byte) (int, error) {
	n, err := r.ReadCloser.Read(b)
	r.store.read += int64(n)
	return n, err
}

func (r *measuredArchiveReader) Close() error {
	r.store.closed++
	return r.ReadCloser.Close()
}

func TestArchiveManifestDoesNotDownloadPayload(t *testing.T) {
	store := newMemObjects()
	measured := &measuredArchiveStore{ObjectStorage: store}
	base := t.TempDir()
	src, dst := filepath.Join(base, "src"), filepath.Join(base, "dst")
	for _, d := range []string{src, dst} {
		if err := os.Mkdir(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	p, err := NewNodePlugin(measured, base)
	if err != nil {
		t.Fatal(err)
	}
	p.SnapshotArchive = true
	manifest := []byte(`{"snapshot_files":["memory"]}`)
	payload := make([]byte, 8<<20)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, manifestFile), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "memory"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.UploadSnapshot(context.Background(), &objectstorev1.UploadSnapshotRequest{SnapshotUri: testURI, LocalPath: src, Files: []string{manifestFile, "memory"}}); err != nil {
		t.Fatal(err)
	}
	key := store.keys()[0]
	archive := store.m[key]
	if _, err := p.FetchSnapshot(context.Background(), &objectstorev1.FetchSnapshotRequest{SnapshotUri: testURI, WritePath: dst, Files: []string{manifestFile}}); err != nil {
		t.Fatal(err)
	}
	if measured.read >= int64(len(archive))/8 {
		t.Fatalf("manifest read %d of %d compressed bytes", measured.read, len(archive))
	}
	if measured.closed != 1 {
		t.Fatalf("metadata stream not closed: %d", measured.closed)
	}
	got, err := os.ReadFile(filepath.Join(dst, manifestFile))
	if err != nil || !bytes.Equal(got, manifest) {
		t.Fatalf("manifest: %q %v", got, err)
	}
	// Metadata discovery does not validate the unread payload. Restore must
	// still consume it once, check its CRC and leave existing files on failure.
	archive[len(archive)-1] ^= 1
	if err := os.WriteFile(filepath.Join(dst, "memory"), []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	before := measured.read
	if _, err := p.FetchSnapshot(context.Background(), &objectstorev1.FetchSnapshotRequest{SnapshotUri: testURI, WritePath: dst, Files: []string{"memory"}}); err == nil {
		t.Fatal("corrupt payload accepted")
	}
	if measured.read-before < int64(len(archive)) {
		t.Fatal("payload restore did not validate the entire archive")
	}
	got, err = os.ReadFile(filepath.Join(dst, "memory"))
	if err != nil || string(got) != "old" {
		t.Fatal("corrupt restore replaced existing state")
	}
}

func TestArchiveManifestFallsBackForOlderEntryOrder(t *testing.T) {
	store := newMemObjects()
	base := t.TempDir()
	p, _ := NewNodePlugin(store, base)
	p.SnapshotArchive = true
	if err := os.WriteFile(filepath.Join(base, manifestFile), []byte("old-order"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "memory"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := p.UploadSnapshot(context.Background(), &objectstorev1.UploadSnapshotRequest{SnapshotUri: testURI, LocalPath: base, Files: []string{"memory", manifestFile}}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.FetchSnapshot(context.Background(), &objectstorev1.FetchSnapshotRequest{SnapshotUri: testURI, WritePath: base, Files: []string{manifestFile}}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(base, manifestFile))
	if string(got) != "old-order" {
		t.Fatalf("manifest: %q", got)
	}
}

func TestArchiveRoundTripAndCleanup(t *testing.T) {
	ctx := context.Background()
	store := newMemObjects()
	base := t.TempDir()
	p, err := NewNodePlugin(store, base)
	if err != nil {
		t.Fatal(err)
	}
	p.SnapshotArchive = true
	src, dst := filepath.Join(base, "src"), filepath.Join(base, "dst")
	for _, d := range []string{src, dst} {
		if err := os.MkdirAll(filepath.Join(d, "fs"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	files := []string{manifestFile, "memory", "fs/data"}
	for _, name := range files {
		if err := os.WriteFile(filepath.Join(src, name), bytes.Repeat([]byte(name), 300), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f, err := os.OpenFile(filepath.Join(src, "memory"), os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if _, err := p.UploadSnapshot(ctx, &objectstorev1.UploadSnapshotRequest{SnapshotUri: testURI, LocalPath: src, Files: files}); err != nil {
		t.Fatal(err)
	}
	keys := store.keys()
	if len(keys) != 1 || keys[0] != testBucket+"/"+testPrefix+"/"+snapshotArchiveName {
		t.Fatalf("objects: %v", keys)
	}
	if len(store.m[keys[0]]) > 1<<20 {
		t.Fatal("archive is not compressed")
	}
	for _, selected := range [][]string{{manifestFile}, {"memory", "fs/data"}} {
		if _, err := p.FetchSnapshot(ctx, &objectstorev1.FetchSnapshotRequest{SnapshotUri: testURI, WritePath: dst, Files: selected}); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range files {
		want, _ := os.ReadFile(filepath.Join(src, name))
		got, err := os.ReadFile(filepath.Join(dst, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s differs: %v", name, err)
		}
	}
	info, _ := os.Stat(filepath.Join(dst, "memory"))
	if info.Sys().(*syscall.Stat_t).Blocks*512 > 1<<20 {
		t.Fatal("restored memory lost its holes")
	}
	// A failed retry must leave the last complete object intact.
	original := bytes.Clone(store.m[keys[0]])
	if _, err := p.UploadSnapshot(ctx, &objectstorev1.UploadSnapshotRequest{SnapshotUri: testURI, LocalPath: src, Files: append(files, "missing")}); err == nil {
		t.Fatal("missing source accepted")
	}
	if !bytes.Equal(original, store.m[keys[0]]) {
		t.Fatal("failed upload replaced complete archive")
	}
	control := NewControlPlugin(store)
	tag, _ := resources.NewTagSnapshotURI("gs://bucket/root", "team-a", "tag1")
	if _, err := control.CopySnapshot(ctx, &objectstorev1.CopySnapshotRequest{SrcUri: testURI, DstUri: tag.String()}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.FetchSnapshot(ctx, &objectstorev1.FetchSnapshotRequest{SnapshotUri: tag.String(), WritePath: dst, Files: files}); err != nil {
		t.Fatal(err)
	}
	for _, uri := range []string{testURI, tag.String()} {
		if _, err := control.CleanupSnapshot(ctx, &objectstorev1.CleanupSnapshotRequest{SnapshotUri: uri}); err != nil {
			t.Fatal(err)
		}
	}
	if len(store.keys()) != 0 {
		t.Fatal("archives remain after cleanup")
	}
}

func TestArchiveRejectsUnsafeOrCorruptInput(t *testing.T) {
	for _, test := range []struct {
		name    string
		headers []*tar.Header
		corrupt bool
	}{
		{"traversal", []*tar.Header{{Name: "../escape", Mode: 0600}}, false},
		{"absolute", []*tar.Header{{Name: "/escape", Mode: 0600}}, false},
		{"symlink", []*tar.Header{{Name: "memory", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}}, false},
		{"duplicate", []*tar.Header{{Name: manifestFile}, {Name: manifestFile}}, false},
		{"missing", []*tar.Header{{Name: manifestFile}}, false},
		{"checksum", []*tar.Header{{Name: manifestFile}, {Name: "memory", Size: 3}}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var b bytes.Buffer
			z, _ := zstd.NewWriter(&b, zstd.WithEncoderCRC(true))
			tw := tar.NewWriter(z)
			for _, h := range test.headers {
				if err := tw.WriteHeader(h); err != nil {
					t.Fatal(err)
				}
				if h.Size > 0 {
					_, _ = tw.Write(bytes.Repeat([]byte("x"), int(h.Size)))
				}
			}
			_ = tw.Close()
			_ = z.Close()
			data := b.Bytes()
			if test.corrupt {
				data[len(data)-1] ^= 1
			}
			dir := t.TempDir()
			_ = os.WriteFile(filepath.Join(dir, "memory"), []byte("old"), 0600)
			r, _ := os.OpenRoot(dir)
			defer r.Close()
			if err := readArchive(bytes.NewReader(data), r, []string{manifestFile, "memory"}); err == nil {
				t.Fatal("invalid archive accepted")
			}
			got, _ := os.ReadFile(filepath.Join(dir, "memory"))
			if string(got) != "old" {
				t.Fatal("failed restore replaced existing state")
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 1 {
				t.Fatal("failed restore left staging files")
			}
		})
	}
}

func TestArchiveRejectsEscapingSymlink(t *testing.T) {
	src, dst, outside := t.TempDir(), t.TempDir(), t.TempDir()
	_ = os.Mkdir(filepath.Join(src, "fs"), 0700)
	_ = os.WriteFile(filepath.Join(src, manifestFile), []byte("manifest"), 0600)
	_ = os.WriteFile(filepath.Join(src, "fs/data"), []byte("data"), 0600)
	_ = os.WriteFile(filepath.Join(outside, "data"), []byte("outside"), 0600)
	_ = os.Symlink(outside, filepath.Join(dst, "fs"))
	r, _ := os.OpenRoot(src)
	defer r.Close()
	var b bytes.Buffer
	if err := writeArchive(&b, r, []string{manifestFile, "fs/data"}); err != nil {
		t.Fatal(err)
	}
	d, _ := os.OpenRoot(dst)
	defer d.Close()
	if err := readArchive(&b, d, []string{manifestFile, "fs/data"}); err == nil {
		t.Fatal("escaping symlink accepted")
	}
	got, _ := os.ReadFile(filepath.Join(outside, "data"))
	if string(got) != "outside" {
		t.Fatal("outside file overwritten")
	}
	_ = os.Remove(filepath.Join(src, "fs/data"))
	_ = os.Remove(filepath.Join(src, "fs"))
	_ = os.Symlink(outside, filepath.Join(src, "fs"))
	if err := writeArchive(io.Discard, r, []string{manifestFile, "fs/data"}); err == nil {
		t.Fatal("escaping source symlink accepted")
	}
}

func TestArchiveReadsLegacySnapshot(t *testing.T) {
	store := newMemObjects()
	base := t.TempDir()
	dir := filepath.Join(base, "state")
	_ = os.Mkdir(dir, 0700)
	_ = os.WriteFile(filepath.Join(dir, manifestFile), []byte("legacy"), 0600)
	p, _ := NewNodePlugin(store, base)
	req := &objectstorev1.UploadSnapshotRequest{SnapshotUri: testURI, LocalPath: dir, Files: []string{manifestFile}}
	if _, err := p.UploadSnapshot(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	p.SnapshotArchive = true
	if _, err := p.FetchSnapshot(context.Background(), &objectstorev1.FetchSnapshotRequest{SnapshotUri: testURI, WritePath: dir, Files: req.Files}); err != nil {
		t.Fatal(err)
	}
	uri, _ := resources.ParseSnapshotURI(testURI)
	r, _ := os.OpenRoot(dir)
	defer r.Close()
	if found, err := p.fetchArchive(context.Background(), uri, r, req.Files); found || err != nil {
		t.Fatalf("absent archive: %v %v", found, err)
	}
	if err := p.uploadArchive(context.Background(), uri, r, []string{"memory"}); err == nil {
		t.Fatal("manifest-free upload accepted")
	}
}
