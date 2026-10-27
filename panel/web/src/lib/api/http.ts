import { authRequired } from '../auth'

export class HttpError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function request(path: string, init?: RequestInit & { operation?: boolean }): Promise<Response> {
  const { operation, ...options } = init || {}
  const headers = new Headers(options.headers)
  if (operation) headers.set('Accept', 'application/x-ndjson')
  let response = await fetch(path, { credentials: 'same-origin', ...options, headers })
  if (operation && response.ok && !response.headers.get('Content-Type')?.startsWith('application/')) {
    throw new Error('Operation status is unavailable. Sign in again and check sandbox state before retrying.')
  }
  if (operation && response.ok && response.headers.get('Content-Type')?.startsWith('application/x-ndjson')) {
    try {
      const result: { status: number; body: string } = await response.json()
      if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string') throw new Error('Invalid operation result')
      response = new Response(result.body, { status: result.status })
    } catch {
      throw new Error('Operation status is uncertain. Refresh sandbox state before retrying.')
    }
  }
  if (response.status === 401) authRequired()
  if (!response.ok) {
    const text = await response.text()
    let message = text
    try { message = JSON.parse(text).error || text } catch { /* HTTP errors may be plain text. */ }
    throw new HttpError(message || `HTTP ${response.status}`, response.status)
  }
  return response
}
