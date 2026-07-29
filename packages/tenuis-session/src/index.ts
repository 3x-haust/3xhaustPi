import {
  AgentHarness,
  InMemorySessionStorage,
  Session,
  type AgentHarnessEvent,
  type AgentHarnessTool,
} from '@earendil-works/pi-agent-core'
import type { ImageContent, Model, Models } from '@earendil-works/pi-ai'

export const TENUIS_SESSION_BRIDGE_VERSION = 1 as const

const BROKERED_TOOL_NAME = /^(workspace|patch|command|git|browser|computer)\.[a-z][a-z0-9-]*$/
const AMBIENT_TOOL_NAMES = new Set(['bash', 'edit', 'read', 'write', 'grep', 'find', 'ls'])

export interface TenuisToolContext {
  readonly projectId: string
  readonly connectionBindingId: string
  readonly turnId: string
}

export type TenuisBrokeredTool = AgentHarnessTool<TenuisToolContext>

export interface CreateTenuisSessionInput {
  readonly bridgeVersion: typeof TENUIS_SESSION_BRIDGE_VERSION
  readonly models: Models
  readonly model: Model<any>
  readonly systemPrompt: string
  readonly tools: readonly TenuisBrokeredTool[]
  readonly allowedToolNames: readonly string[]
  readonly toolContext: () => TenuisToolContext
  readonly thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

export function validateBrokeredTools(
  tools: readonly TenuisBrokeredTool[],
  allowedToolNames: readonly string[],
): string[] {
  const allowed = new Set(allowedToolNames)
  if (allowed.size !== allowedToolNames.length) throw new Error('Allowed tool names must be unique')

  const names = tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) throw new Error('Brokered tool names must be unique')
  if (names.length !== allowed.size) throw new Error('Every allowed tool must have exactly one implementation')

  for (const name of names) {
    if (AMBIENT_TOOL_NAMES.has(name) || !BROKERED_TOOL_NAME.test(name)) {
      throw new Error(`Tool is not Tenuis-brokered: ${name}`)
    }
    if (!allowed.has(name)) throw new Error(`Tool is outside the explicit allowlist: ${name}`)
  }

  return names
}

export class TenuisPiSession {
  readonly bridgeVersion = TENUIS_SESSION_BRIDGE_VERSION
  readonly activeToolNames: readonly string[]
  readonly #harness: AgentHarness<TenuisToolContext>
  readonly #storage: InMemorySessionStorage

  constructor(input: CreateTenuisSessionInput) {
    if (input.bridgeVersion !== TENUIS_SESSION_BRIDGE_VERSION) throw new Error('Unsupported Tenuis session bridge version')
    if (!input.systemPrompt.trim()) throw new Error('Tenuis system prompt must not be empty')

    const activeToolNames = validateBrokeredTools(input.tools, input.allowedToolNames)
    this.#storage = new InMemorySessionStorage()
    const session = new Session(this.#storage)
    this.#harness = new AgentHarness<TenuisToolContext>({
      session,
      models: input.models,
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: [...input.tools],
      activeToolNames,
      resources: { promptTemplates: [], skills: [] },
      toolContext: input.toolContext,
      thinkingLevel: input.thinkingLevel ?? 'off',
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
    })
    this.activeToolNames = Object.freeze([...activeToolNames])
  }
  async getSessionId(): Promise<string> {
    return (await this.#storage.getMetadata()).id
  }

  prompt(text: string, options?: { images?: ImageContent[] }) {
    return this.#harness.prompt(text, options)
  }

  steer(text: string, options?: { images?: ImageContent[] }) {
    return this.#harness.steer(text, options)
  }

  followUp(text: string, options?: { images?: ImageContent[] }) {
    return this.#harness.followUp(text, options)
  }

  abort() {
    return this.#harness.abort()
  }

  subscribe(listener: (event: AgentHarnessEvent) => Promise<void> | void) {
    return this.#harness.subscribe(listener)
  }
}

export function createTenuisSession(input: CreateTenuisSessionInput): TenuisPiSession {
  return new TenuisPiSession(input)
}
