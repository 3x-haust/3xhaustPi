import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const EXPECTED_EMBEDDING_POLICY = Object.freeze({
  ambientResourceDiscovery: false,
  ambientAuthFile: false,
  ambientProjectExtensions: false,
  ambientGlobalExtensions: false,
  builtinFileTools: false,
  builtinShellTools: false,
  credentialsOwner: '3xhaustpi',
  toolsOwner: '3xhaustpi',
  policyOwner: '3xhaustpi',
})

export function assertCompatibilityManifest(compatibility) {
  assert.equal(compatibility.schemaVersion, 2)
  assert.equal(compatibility.repository.name, '3x-haust/3xhaustPi')
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
    [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-agent-core',
      '@3xhaust/semantic-contract',
      '@3xhaust/core',
      '@3xhaust/pi-adapter',
      '@3xhaust/pi-session',
    ],
  )
  assert.deepEqual(compatibility.embedding, EXPECTED_EMBEDDING_POLICY)
  assert.deepEqual(compatibility.artifacts.requiredInventory, [
    'packages/semantic-contract/LICENSE',
    'packages/semantic-contract/dist/index.js',
    'packages/semantic-contract/dist/index.d.ts',
    'packages/core/LICENSE',
    'packages/core/dist/index.js',
    'packages/core/dist/index.d.ts',
    'packages/pi-adapter/LICENSE',
    'packages/pi-adapter/dist/index.js',
    'packages/pi-adapter/dist/index.d.ts',
    'packages/pi-session/LICENSE',
    'packages/pi-session/dist/index.js',
    'packages/pi-session/dist/index.d.ts',
  ])
  assert.equal(compatibility.artifacts.receiptSchemaVersion, 2)
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
const semanticContract = await import('../packages/semantic-contract/dist/index.js')
const core = await import('../packages/core/dist/index.js')
const piAdapter = await import('../packages/pi-adapter/dist/index.js')
const sessionBridge = await import('../packages/pi-session/dist/index.js')

assert.equal(typeof ai.createModels, 'function')
assert.equal(typeof agent.Agent, 'function')
assert.equal(typeof semanticContract.parseSemanticOutput, 'function')
assert.deepEqual(
  core.getCapabilityCatalog().capabilities.map(({ id }) => id),
  ['searchText', 'searchSymbol', 'readRanges', 'applyPatch', 'getDiagnostics'],
)
assert.equal(
  (
    await core.compileSemanticOutput(
      semanticContract.parseSemanticOutput({
        protocolVersion: 2,
        kind: 'intent',
        payload: {
          kind: 'inspect',
          objective: 'Inspect the package',
          target: { kind: 'documents', documentIds: ['doc_package'] },
          evidenceGoals: ['Observe the package'],
          constraints: [],
          doneWhen: 'A read invocation exists',
        },
      }),
      {
        projectId: semanticContract.parseProjectId('prj_embedding'),
        turnId: 'turn_embedding',
        projectRevision: 'rev_embedding',
        observationDigests: [],
      },
    )
  ).kind,
  'readPlan',
)
assert.equal(typeof piAdapter.createThreeXhaustPiAdapter, 'function')
assert.equal(typeof piAdapter.createModelsPiComplete, 'function')
assert.equal(typeof piAdapter.X3HAUST_SEMANTIC_STABLE_PREFIX, 'string')
assert.equal(
  semanticContract.parseSemanticOutput({
    protocolVersion: 2,
    kind: 'intent',
    payload: {
      kind: 'verify',
      objective: 'Verify the embedding contract',
      target: { kind: 'behavior', description: 'Load the packaged exports' },
      evidenceGoals: ['Observe the export'],
      constraints: [],
      doneWhen: 'The strict envelope parses',
    },
  }).payload.kind,
  'verify',
)
assert.equal(typeof sessionBridge.createThreeXhaustSession, 'function')
assert.equal(typeof sessionBridge.validateBrokeredTools, 'function')
assert.equal(sessionBridge.X3HAUST_SESSION_BRIDGE_VERSION, 1)
assert.deepEqual(sessionBridge.validateBrokeredTools([], []), [])

process.stdout.write(
  JSON.stringify({
    schemaVersion: 2,
    kind: '3xhaustpi-embedding-smoke',
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    packages: compatibility.packages.map(({ name, version }) => ({ name, version })),
    ambientDefaultsDisabledByContract: true,
  }),
)
