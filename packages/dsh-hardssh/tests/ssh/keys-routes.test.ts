/**
 * SSH key routes: discovery, import, and Ed25519 generation. The keysDir is
 * injected so the test never touches the developer's real ~/.ssh.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRoutes, type SshRoutes } from '../../src/ssh/routes.ts'
import { SSH_API } from '../../src/ssh/protocol.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-keys-routes-'))
const keysDir = join(dir, '.ssh')

let server: Server
let port: number
let owned: SshRoutes

interface HttpResponse { status: number; text: string }

function send(method: string, path: string, body?: unknown): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    }, (response: IncomingMessage) => {
      let text = ''
      response.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

beforeAll(async () => {
  owned = makeRoutes({
    store: {} as never,
    engine: {} as never,
    stagingDir: join(dir, 'staging'),
    keysDir,
  })
  server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = owned.routes.find(candidate => candidate.kind === 'exact' && candidate.path === rawPath)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await owned.dispose()
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  rmSync(dir, { recursive: true, force: true })
})

describe('SSH key routes', () => {
  it('answers discovery info and ordered search directories', async () => {
    const response = await send('GET', SSH_API.keyInfo)
    expect(response.status).toBe(200)
    const body = JSON.parse(response.text) as {
      home: string
      keysDir: string
      searchDirs: string[]
      defaultKeyPath?: string
      android: boolean
    }
    expect(body.home.length).toBeGreaterThan(0)
    expect(body.keysDir).toBe(keysDir)
    expect(body.searchDirs[0]).toBe(keysDir)
    // The machine may already have a real default key; when it does, it must
    // come from one of the advertised search directories.
    if (body.defaultKeyPath !== undefined) {
      expect(body.searchDirs.some(directory => body.defaultKeyPath!.startsWith(directory))).toBe(true)
    }
    expect(typeof body.android).toBe('boolean')
  })

  it('imports a private key, makes it owner-only, and never overwrites', async () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
    const first = await send('POST', SSH_API.keyImport, { name: 'id_ed25519', content: key })
    expect(first.status).toBe(200)
    const firstPath = (JSON.parse(first.text) as { path: string }).path
    expect(firstPath).toBe(join(keysDir, 'id_ed25519'))
    expect(readFileSync(firstPath, 'utf8')).toBe(key)
    if (process.platform !== 'win32') expect(statSync(firstPath).mode & 0o077).toBe(0)

    const second = await send('POST', SSH_API.keyImport, { name: 'id_ed25519', content: key })
    expect(second.status).toBe(200)
    expect((JSON.parse(second.text) as { path: string }).path).toBe(join(keysDir, 'id_ed25519-2'))

    // Discovery now prefers the OpenSSH default name.
    const info = await send('GET', SSH_API.keyInfo)
    expect((JSON.parse(info.text) as { defaultKeyPath?: string }).defaultKeyPath).toBe(firstPath)
  })

  it('rejects non-key content and path-shaped names', async () => {
    const notAKey = await send('POST', SSH_API.keyImport, { name: 'x', content: 'hello' })
    expect(notAKey.status).toBe(400)

    const traversal = await send('POST', SSH_API.keyImport, {
      name: '../evil',
      content: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
    })
    expect(traversal.status).toBe(400)
    expect(existsSync(join(keysDir, 'evil'))).toBe(false)
  })

  it('generates an Ed25519 pair and returns the public line', async () => {
    const response = await send('POST', SSH_API.keyGenerate, { name: 'generated' })
    expect(response.status).toBe(200)
    const body = JSON.parse(response.text) as { path: string; publicKey: string }
    expect(body.path).toBe(join(keysDir, 'generated'))
    expect(readFileSync(body.path, 'utf8')).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(body.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ dsh-hardssh$/)
  })
})
