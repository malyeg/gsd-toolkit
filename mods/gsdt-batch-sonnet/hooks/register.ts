import type { EngineInterface, Register } from 'claude-code'

// While a /gsdt-batch run is on, the MAIN session's model requests go to
// Sonnet (the coordinator); subagents keep theirs, so planners stay on Opus.
// On: the gsdt-batch skill's prompt is expanded (typed /gsdt-batch or the
// Skill tool). It stays on through the skill's pause for the user's OK.
// Off: the turn that printed "gsdt-batch: done …" ends, the user cancels a
// turn, the session ends, or /gsdt-batch-off.

const ON = { plugin: 'gsdt-batch-sonnet', key: 'on' } as const
const ENDING = { plugin: 'gsdt-batch-sonnet', key: 'ending' } as const
const SKILL = 'gsdt-batch'
const MODEL = 'sonnet'
const DONE = /^\W*gsdt-batch: done\b/m

const isOn = async ($: EngineInterface) => (await $.state.get(ON)).value === true

async function set($: EngineInterface, on: boolean) {
  await $.state.set(ON, on)
  await $.state.set(ENDING, false)
  await $.ui.status(on ? `batch: ${MODEL}` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gsdt-batch-off',
      description: 'Turn the gsdt-batch Sonnet switch off',
    })
    // A reload keeps the state: show the line again.
    if (await isOn($)) await $.ui.status(`batch: ${MODEL}`)
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    if (e.skill.split(':').pop() === SKILL) await set($, true)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await isOn($))) return yield* next(e)
    const r = yield* next({ ...e, model: MODEL })
    if (DONE.test(r.answer)) await $.state.set(ENDING, true)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && (await isOn($))) {
      const ending = (await $.state.get(ENDING)).value === true
      if (e.isAborted || ending || DONE.test(e.answer)) await set($, false)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    if (await isOn($)) await set($, false)
    return next(e)
  })

  on('command.run', { command: 'gsdt-batch-off' }, async $ => {
    const was = await isOn($)
    await set($, false)
    return { text: was ? 'gsdt-batch: Sonnet switch off.' : 'gsdt-batch: the Sonnet switch was already off.' }
  })
}
