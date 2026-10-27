package objectstoreplugin

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/agent-substrate/substrate/internal/resources"
	"github.com/agent-substrate/substrate/pkg/objectstorage"
	"github.com/klauspost/compress/zstd"
)

const snapshotArchiveName = "snapshot.tar.zst"

var errManifestNotFirst = errors.New("archive manifest is not the first entry")

func (p *NodePlugin) uploadArchive(ctx context.Context, uri resources.SnapshotURI, root *os.Root, files []string) error {
	if !slices.Contains(files, manifestFile) {
		return fmt.Errorf("archive upload requires the manifest and all snapshot files in one call")
	}
	address, _ := uri.ObjectURI(snapshotArchiveName)
	u, err := url.Parse(address)
	if err != nil {
		return err
	}
	r, w := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := writeArchive(w, root, files)
		_ = w.CloseWithError(err)
		done <- err
	}()
	err = p.gcsClient.PutObject(ctx, u.Host, strings.TrimPrefix(u.Path, "/"), r)
	_ = r.CloseWithError(err)
	return errors.Join(err, <-done)
}

func writeArchive(out io.Writer, root *os.Root, files []string) error {
	z, err := zstd.NewWriter(out, zstd.WithEncoderConcurrency(2), zstd.WithEncoderCRC(true))
	if err != nil {
		return err
	}
	defer z.Close()
	t := tar.NewWriter(z)
	for _, name := range files {
		f, err := root.Open(name)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		if err == nil && !info.Mode().IsRegular() {
			err = fmt.Errorf("snapshot file %q is not regular", name)
		}
		if err == nil {
			err = t.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: info.Size(), Typeflag: tar.TypeReg})
		}
		if err == nil {
			_, err = io.Copy(t, f)
		}
		err = errors.Join(err, f.Close())
		if err != nil {
			return err
		}
	}
	if err := t.Close(); err != nil {
		return err
	}
	return z.Close()
}

func (p *NodePlugin) fetchArchive(ctx context.Context, uri resources.SnapshotURI, root *os.Root, files []string) (bool, error) {
	address, _ := uri.ObjectURI(snapshotArchiveName)
	r, err := objectstorage.Open(ctx, p.gcsClient, address)
	if err != nil {
		if errors.Is(err, objectstorage.ErrObjectNotFound) {
			return false, nil
		}
		return true, err
	}
	defer r.Close()
	if len(files) == 1 && files[0] == manifestFile {
		// This is metadata discovery, not snapshot validation. Close the stream
		// after the leading manifest instead of downloading all guest memory.
		// The subsequent payload restore still validates the complete tar/zstd
		// stream and its checksum before publishing any snapshot files.
		err := readArchiveManifest(r, root)
		if !errors.Is(err, errManifestNotFirst) {
			return true, err
		}
		// Older writers may put the manifest later. Preserve compatibility by
		// reopening and using the original complete validation path for them.
		_ = r.Close()
		r, err = objectstorage.Open(ctx, p.gcsClient, address)
		if err != nil {
			return true, err
		}
		defer r.Close()
	}
	return true, readArchive(r, root, files)
}

func readArchiveManifest(in io.Reader, root *os.Root) error {
	z, err := zstd.NewReader(in, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(128<<20))
	if err != nil {
		return err
	}
	defer z.Close()
	t := tar.NewReader(z)
	h, err := t.Next()
	if err != nil {
		return err
	}
	if h.Name != manifestFile {
		return errManifestNotFirst
	}
	if h.Size > 4<<20 {
		return errManifestNotFirst // Keep unusually large old manifests readable.
	}
	if h.Typeflag != tar.TypeReg || h.Size < 0 {
		return fmt.Errorf("invalid or oversized archive manifest")
	}
	tmp := manifestFile + ".restore-" + rand.Text()
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, readErr := io.CopyN(f, t, h.Size)
	if err := errors.Join(readErr, f.Close()); err != nil {
		return err
	}
	return root.Rename(tmp, manifestFile)
}

func readArchive(in io.Reader, root *os.Root, files []string) error {
	z, err := zstd.NewReader(in, zstd.WithDecoderConcurrency(2), zstd.WithDecoderMaxMemory(128<<20))
	if err != nil {
		return err
	}
	defer z.Close()
	wanted := make(map[string]bool, len(files))
	for _, name := range files {
		wanted[name] = true
	}
	staged := make(map[string]string, len(files))
	defer func() {
		for _, tmp := range staged {
			_ = root.Remove(tmp)
		}
	}()
	seen := map[string]bool{}
	t := tar.NewReader(z)
	for {
		h, err := t.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if err := resources.ValidateSnapshotFileNames([]string{h.Name}); err != nil {
			return err
		}
		if h.Typeflag != tar.TypeReg || seen[h.Name] {
			return fmt.Errorf("invalid or duplicate archive entry %q", h.Name)
		}
		seen[h.Name] = true
		if !wanted[h.Name] {
			continue
		}
		if err := root.MkdirAll(filepath.Dir(h.Name), 0o700); err != nil {
			return err
		}
		tmp := h.Name + ".restore-" + rand.Text()
		f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		staged[h.Name] = tmp
		_, copyErr := io.Copy(sparseArchiveWriter{f}, t)
		if copyErr == nil {
			copyErr = f.Truncate(h.Size)
		}
		if err := errors.Join(copyErr, f.Close()); err != nil {
			return err
		}
	}
	// tar EOF precedes the zstd checksum; drain it before publishing any files.
	if _, err := io.Copy(io.Discard, z); err != nil {
		return err
	}
	if !seen[manifestFile] {
		return fmt.Errorf("archive lacks manifest")
	}
	for _, name := range files {
		if !seen[name] {
			return fmt.Errorf("%w: archive lacks %q", objectstorage.ErrObjectNotFound, name)
		}
	}
	for _, name := range files {
		if err := root.Rename(staged[name], name); err != nil {
			return err
		}
		delete(staged, name)
	}
	return nil
}

type sparseArchiveWriter struct{ file *os.File }

func (w sparseArchiveWriter) Write(p []byte) (int, error) {
	if len(bytes.Trim(p, "\x00")) == 0 {
		_, err := w.file.Seek(int64(len(p)), io.SeekCurrent)
		if err != nil {
			return 0, err
		}
		return len(p), nil
	}
	return w.file.Write(p)
}
