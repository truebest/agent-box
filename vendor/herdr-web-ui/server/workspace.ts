import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

// gVisor can ignore O_NOFOLLOW; compare the opened inode with the no-follow stat.
export function openWorkspace(path: string, directory = false): number {
  const parts = path.split("/");
  if (parts[0] !== "" || parts[1] !== "workspace" || parts.slice(2).some((part) => part === ".." || part === "." || part === "")) throw new Error("Path must be inside /workspace");
  let fd = openSync("/workspace", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let i = 2; i < parts.length; i++) {
      const name = `/proc/self/fd/${fd}/${parts[i]}`;
      const before = lstatSync(name);
      if (before.isSymbolicLink()) throw new Error("Symlinks are not allowed");
      const next = openSync(name, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | (i < parts.length - 1 || directory ? constants.O_DIRECTORY : 0));
      const after = fstatSync(next);
      if (before.dev !== after.dev || before.ino !== after.ino || (!after.isFile() && !after.isDirectory())) {
        closeSync(next);
        throw new Error("Path changed while opening");
      }
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function workspaceDirectory(path: string): boolean {
  try { closeSync(openWorkspace(path, true)); return true; } catch { return false; }
}

export function writeWorkspaceFile(path: string, data: Uint8Array): void {
  const directory = openWorkspace(dirname(path), true);
  try {
    const fd = openSync(`/proc/self/fd/${directory}/${basename(path)}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, data); } finally { closeSync(fd); }
  } finally { closeSync(directory); }
}
