import { expect, test } from 'claude-code/testing'

// Each hook here stands for the engine, beneath the plugin.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], models: string[], status: (string | undefined)[], answer = '') {
  on('command.register', () => ({ value: { command: 'gsdt-batch-off' } }))
  on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({ text: '' }))
}

// A turn.step is a stream: read it to its end.
async function drain(s: AsyncIterable<unknown>) {
  for await (const _ of s) void _
}

const step = (agentId?: string) => ({
  turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}),
})
const skill = (name: string) => ({ skill: name, text: 'x', frontmatter: {}, source: 'userSettings' } as never)
const done = (answer: string, isAborted = false) => ({
  answer, durationMs: 1, isAborted, turnId: 't1', reason: isAborted ? 'aborted' : 'answer',
} as never)

test('off: requests keep their model', async ($, on) => {
  const models: string[] = []
  engine(on, models, [])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await drain($.turn.step(step()))
  expect(models).toEqual(['claude-opus-5-5'])
})

test('on: main goes to sonnet, subagents keep theirs, the status line says so', async ($, on) => {
  const models: string[] = []
  const status: (string | undefined)[] = []
  engine(on, models, status)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.skill.prompt(skill('gsd-toolkit:gsdt-batch'))
  await drain($.turn.step(step()))
  await drain($.turn.step(step('agent-1')))
  expect(models).toEqual(['sonnet', 'claude-opus-5-5'])
  expect(status).toContain('batch: sonnet')
})

test('another skill does not turn it on', async ($, on) => {
  const models: string[] = []
  engine(on, models, [])
  await $.skill.prompt(skill('gsd-quick-batch'))
  await drain($.turn.step(step()))
  expect(models).toEqual(['claude-opus-5-5'])
})

test('stays on through the pause; off after the done line', async ($, on) => {
  const models: string[] = []
  engine(on, models, [], 'sorted list, OK?')
  await $.skill.prompt(skill('gsdt-batch'))
  await drain($.turn.step(step()))
  await $.turn.complete(done('sorted list, OK?'))   // the pause for the OK
  await drain($.turn.step(step()))
  await $.turn.complete(done('gsdt-batch: done items=3 real=2 tiny=1'))
  await drain($.turn.step(step()))
  expect(models).toEqual(['sonnet', 'sonnet', 'claude-opus-5-5'])
})

test('a cancelled turn turns it off', async ($, on) => {
  const models: string[] = []
  engine(on, models, [])
  await $.skill.prompt(skill('gsdt-batch'))
  await $.turn.complete(done('', true))
  await drain($.turn.step(step()))
  expect(models).toEqual(['claude-opus-5-5'])
})

test('/gsdt-batch-off turns it off by hand', async ($, on) => {
  const models: string[] = []
  engine(on, models, [])
  await $.skill.prompt(skill('gsdt-batch'))
  const r = await $.command.run({ command: 'gsdt-batch-off', args: '' } as never)
  expect(r.text).toContain('off')
  await drain($.turn.step(step()))
  expect(models).toEqual(['claude-opus-5-5'])
})
