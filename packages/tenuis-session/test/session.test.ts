import { describe, expect, it } from 'vitest'
import {
  TENUIS_SESSION_BRIDGE_VERSION,
  validateBrokeredTools,
  type TenuisBrokeredTool,
} from '../src/index.js'

const tool = (name: string) => ({ name }) as TenuisBrokeredTool

describe('Tenuis session bridge', () => {
  it('exports a stable bridge version', () => {
    expect(TENUIS_SESSION_BRIDGE_VERSION).toBe(1)
  })

  it('accepts an exact set of namespaced brokered tools', () => {
    expect(
      validateBrokeredTools(
        [tool('workspace.inspect'), tool('patch.apply'), tool('command.run')],
        ['workspace.inspect', 'patch.apply', 'command.run'],
      ),
    ).toEqual(['workspace.inspect', 'patch.apply', 'command.run'])
  })

  it.each(['read', 'bash', 'write', 'workspace', 'extension.run', '../workspace.inspect'])(
    'rejects ambient or unowned tool %s',
    (name) => {
      expect(() => validateBrokeredTools([tool(name)], [name])).toThrow('not Tenuis-brokered')
    },
  )

  it('rejects missing, extra, and duplicate implementations', () => {
    expect(() => validateBrokeredTools([tool('workspace.inspect')], ['workspace.inspect', 'patch.apply'])).toThrow(
      'exactly one implementation',
    )
    expect(() => validateBrokeredTools([tool('workspace.inspect')], ['patch.apply'])).toThrow(
      'outside the explicit allowlist',
    )
    expect(() =>
      validateBrokeredTools([tool('workspace.inspect'), tool('workspace.inspect')], ['workspace.inspect']),
    ).toThrow('must be unique')
  })
})
