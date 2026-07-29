import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const EXPECTED_EMBEDDING_POLICY = Object.freeze({
  ambientResourceDiscovery: false,
  ambientAuthFile: false,
  ambientProjectExtensions: false,
  ambientGlobalExtensions: false,
  builtinFileTools: false,
  builtinShellTools: false,
  credentialsOwner: 'Tenuis',
  toolsOwner: 'Tenuis',
  policyOwner: 'Tenuis',
})

export function assertCompatibilityManifest(compatibility) {
  assert.equal(compatibility.schemaVersion, 1)
  assert.equal(compatibility.repository.name, '3x-haust/TenuisPi')
  assert.equal(compatibility.repository.lineage, 'standalone-source-port')
  assert.equal(compatibility.repository.importedFrom, 'earendil-works/pi')
  assert.match(compatibility.repository.upstreamCommit, /^[a-f0-9]{40}$/)
  assert.equal(compatibility.repository.syncStrategy, 'reviewed-source-candidate-pr')
  assert.equal(compatibility.repository.stablePromotionRequiresExactCommitReceipt, true)
  assert.match(compatibility.runtime.node, /^>=22/)
  assert.deepEqual(compatibility.runtime.platforms, [
    'darwin-arm64',
    'darwin-x64',
    'win32-x64',
    'win32-arm64',
  ])
  assert.deepEqual(
    compatibility.packages.map(({ name }) => name),
    ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@3x-haust/tenuis-pi-session'],
  )
  assert.deepEqual(compatibility.embedding, EXPECTED_EMBEDDING_POLICY)
  assert.deepEqual(compatibility.artifacts.requiredInventory, [
    'packages/tenuis-session/LICENSE',
    'packages/tenuis-session/dist/index.js',
    'packages/tenuis-session/dist/index.d.ts',
  ])
  assert.equal(compatibility.artifacts.receiptSchemaVersion, 1)
  assert.equal(compatibility.artifacts.digest, 'sha256')
  assert.equal(compatibility.artifacts.provenance, 'github-actions-exact-commit')
}

const compatibility = JSON.parse(
  await readFile(new URL('./compatibility.json', import.meta.url), 'utf8'),
)
assertCompatibilityManifest(compatibility)

for (const [key, expected] of Object.entries(EXPECTED_EMBEDDING_POLICY)) {
  const weakened = structuredClone(compatibility)
  weakened.embedding[key] = typeof expected === 'boolean' ? !expected : 'Pi'
  assert.throws(() => assertCompatibilityManifest(weakened), `weakened embedding policy accepted: ${key}`)
}

const ai = await import('../packages/ai/dist/index.js')
const agent = await import('../packages/agent/dist/index.js')
const sessionBridge = await import('../packages/tenuis-session/dist/index.js')

assert.equal(typeof ai.createModels, 'function')
assert.equal(typeof agent.Agent, 'function')
assert.equal(typeof sessionBridge.createTenuisSession, 'function')
assert.equal(typeof sessionBridge.validateBrokeredTools, 'function')
assert.equal(sessionBridge.TENUIS_SESSION_BRIDGE_VERSION, 1)
assert.deepEqual(sessionBridge.validateBrokeredTools([], []), [])

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
