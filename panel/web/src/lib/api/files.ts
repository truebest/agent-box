import { request } from './http'
import { agentRuntimePath } from './sandbox'
import type { SandboxFileDownloadResult, SandboxFilesListData } from './types'

const fileURL = (name: string, uid: string, path: string) => `${agentRuntimePath(name, uid, 'files')}&${new URLSearchParams({ path })}`

export async function listSandboxFiles(name: string, uid: string, path = '/workspace'): Promise<SandboxFilesListData> {
  const data: { entries: { name: string; directory: boolean; size?: number }[] } = await (await request(fileURL(name, uid, path))).json()
  return { path, entries: data.entries.map((entry) => ({ ...entry, size: entry.size ?? -1, path: `${path.replace(/\/$/, '')}/${entry.name}`, isDir: entry.directory })) }
}
export async function uploadSandboxFile(name: string, uid: string, path: string, file: File): Promise<void> {
  if (file.size > 64 * 1024 * 1024) throw new Error('Upload limit: 64 MiB')
  await (await request(fileURL(name, uid, `${path.replace(/\/$/, '')}/${file.name}`), { method: 'PUT', body: file })).json()
}
export async function deleteSandboxFile(name: string, uid: string, path: string): Promise<void> {
  await (await request(fileURL(name, uid, path), { method: 'DELETE' })).json()
}
export async function createSandboxDirectory(name: string, uid: string, path: string): Promise<void> {
  await (await request(fileURL(name, uid, path), { method: 'POST' })).json()
}
export async function downloadSandboxFile(name: string, uid: string, path: string): Promise<SandboxFileDownloadResult> {
  const response = await request(fileURL(name, uid, path))
  return { blob: await response.blob(), fileName: path.split('/').pop() || 'download.bin' }
}

// From agent-sandbox/agent-sandbox ui/src/lib/api/files.ts (Apache-2.0).
export function triggerBrowserDownload(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
