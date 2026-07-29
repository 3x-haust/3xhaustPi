import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const compatibility = JSON.parse(
  await readFile(new URL('./compatibility.json', import.meta.url), 'utf8'),
)
const ai = await import('../packages/ai/dist/index.js')
const agent = await import('../packages/agent/dist/index.js')
const sessionBridge = await import('../packages/tenuis-session/dist/index.js')

assert.equal(typeof ai.createModels, 'function')
assert.equal(typeof agent.Agent, 'function')
assert.equal(typeof sessionBridge.createTenuisSession, 'function')
assert.equal(typeof sessionBridge.validateBrokeredTools, 'function')
assert.equal(sessionBridge.TENUIS_SESSION_BRIDGE_VERSION, 1)
assert.deepEqual(sessionBridge.validateBrokeredTools([], []), [])

assert.equal(compatibility.embedding.ambientResourceDiscovery, false)
assert.equal(compatibility.embedding.ambientAuthFile, false)
assert.equal(compatibility.embedding.builtinFileTools, false)
assert.equal(compatibility.embedding.builtinShellTools, false)
assert.equal(compatibility.embedding.credentialsOwner, 'Tenuis')
assert.equal(compatibility.embedding.toolsOwner, 'Tenuis')

process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    kind: 'tenuis-pi-embedding-smoke',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    packages: compatibility.packages.map(({ name, version }) => ({ name, version })),
    ambientDefaultsDisabledByContract: true,
  }),
)
