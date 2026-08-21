import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import {
  createThreeXhaustSession,
  summarizeThreeXhaustBenchmark,
  X3HAUST_SESSION_BRIDGE_VERSION,
} from '../dist/index.js'

const repetitionsArgument = process.argv.find((argument) => argument.startsWith('--repetitions='))
const repetitions = repetitionsArgument ? Number(repetitionsArgument.split('=')[1]) : 24

function responsePlan(count) {
  return Array.from({ length: count }, (_, index) => [
    fauxAssistantMessage(
      fauxToolCall('workspace.inspect', { documentId: `fixture-${index % 3}` }, { id: `call-${index}` }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(`Fixture ${index % 3} inspected.`),
  ]).flat()
}

async function runScenario(cacheRetention) {
  const models = createModels()
  const provider = fauxProvider({
    provider: `3xhaustpi-benchmark-${cacheRetention}-${process.pid}-${Date.now()}`,
  })
  models.setProvider(provider.provider)
  provider.setResponses(responsePlan(repetitions))
  const inspectTool = {
    name: 'workspace.inspect',
    label: 'Inspect benchmark fixture',
    description: 'Read one deterministic benchmark fixture.',
    parameters: {
      type: 'object',
      properties: { documentId: { type: 'string' } },
      required: ['documentId'],
      additionalProperties: false,
    },
    async execute(_toolCallId, { documentId }) {
      return {
        content: [{ type: 'text', text: `contents:${documentId}:${'stable-prefix-'.repeat(128)}` }],
        details: { documentId },
      }
    },
  }
  const session = createThreeXhaustSession({
    bridgeVersion: X3HAUST_SESSION_BRIDGE_VERSION,
    models,
    model: provider.getModel(),
    systemPrompt: `3xhaustpi benchmark system prefix.\n${'stable-system-prefix-'.repeat(512)}`,
    tools: [inspectTool],
    allowedToolNames: ['workspace.inspect'],
    toolContext: () => ({
      projectId: 'benchmark-project',
      connectionBindingId: 'benchmark-binding',
      turnId: 'benchmark-turn',
    }),
    cacheRetention,
  })
  const durationsMs = []
  for (let index = 0; index < repetitions; index += 1) {
    const startedAt = performance.now()
    await session.prompt(`Inspect deterministic fixture ${index % 3}.`)
    durationsMs.push(performance.now() - startedAt)
  }
  return { metrics: session.getMetrics(), durationsMs }
}

const baseline = await runScenario('none')
const optimized = await runScenario('long')
const report = summarizeThreeXhaustBenchmark({ repetitions, baseline, optimized })
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
