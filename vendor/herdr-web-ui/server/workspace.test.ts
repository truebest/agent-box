import { expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { openWorkspace, writeWorkspaceFile } from "./workspace.ts";

test("browser file access stays in workspace and rejects every symlink", () => {
  mkdirSync("/workspace", { recursive: true });
  const root = mkdtempSync("/workspace/console-test-");
  try {
    writeFileSync(root + "/file", "ok");
    symlinkSync("/etc/passwd", root + "/outside");
    symlinkSync(root + "/file", root + "/inside");
    symlinkSync("/etc", root + "/directory");
    const fd = openWorkspace(root + "/file");
    expect(fstatSync(fd).size).toBe(2);
    closeSync(fd);
    writeWorkspaceFile(root + "/upload", new Uint8Array([1, 2]));
    for (const path of [root + "/inside", root + "/outside", root + "/directory/upload", "/tmp/console-escape"]) {
      expect(() => writeWorkspaceFile(path, new Uint8Array([3]))).toThrow();
    }
    for (const path of ["/etc/passwd", root + "/../file", root + "/outside", root + "/inside", root + "/directory/passwd", root + "/missing", root + "/file/child"]) {
      expect(() => openWorkspace(path)).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
