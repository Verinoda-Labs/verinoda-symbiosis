import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ImproveState } from '../types'
import {
  addOwn, applyReport, countsOf, INITIAL_IMPROVE, listOf, PROPOSE_TOOL, proposeList, REPORT_TOOL, reportPrompt, reviewPrompt,
  selectionPrompt, send, setDecision, sightOf, unfold,
} from './improve'

const ROOT = 'C:/work/proj'
const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as never
const SCRIPTED = { cwd: ROOT, surface: 'terminal', isInteractive: false } as never

const item = (id: string, group: 'problem' | 'improvement' | 'taste' = 'improvement', extra: Record<string, unknown> = {}) => ({
  id, group, title: `title ${id}`, observation: `obs ${id}`, why: `why ${id}`, change: `change ${id}`, ...extra,
})
// twelve items, ranked: problems with and without evidence, improvements, taste with and without a view
const TWELVE = [
  item('i1', 'problem', { evidence: ['a.py:1'] }), item('i2', 'problem'), item('i3', 'improvement'), item('i4', 'taste'),
  item('i5', 'improvement'), item('i6', 'problem', { evidence: ['b.py:9'] }), item('i7', 'taste', { seen: true }),
  item('i8', 'improvement'), item('i9', 'problem'), item('i10', 'taste'), item('i11', 'improvement'), item('i12', 'problem'),
]
const WHAT = { interactive: true, what: '' }

function listed(items: unknown[] = TWELVE, subject = 'src/a.py'): ImproveState {
  const out = proposeList(INITIAL_IMPROVE, { subject, items }, WHAT)
  if ('error' in out) throw new Error(out.error)
  return out.state
}
const decided = (s: ImproveState, id: string, d: 'apply' | 'keep' | 'check') => setDecision(s, id, d)

describe('improve: pure parts', () => {
  test('a valid list is stored in the order given, texts trimmed and cut, nothing decided; the subject falls back', () => {
    const long = 'x'.repeat(200)
    const s = listed([item('i1', 'problem', { title: `  ${long}  `, observation: 'y'.repeat(700), cost: 7, evidence: 'not a list', seen: 'yes' }), item('i2')], '  a file  ')
    expect(s.phase).toBe('choosing')
    expect(s.subject).toBe('a file')
    expect(s.items.map(i => i.id)).toEqual(['i1', 'i2'])
    expect(s.items[0]?.title.length).toBe(120)
    expect(s.items[0]?.title.endsWith('…')).toBe(true)
    expect(s.items[0]?.observation.length).toBe(600)
    expect(s.items.every(i => i.decision === 'none' && i.outcome === null && i.sentAs === null)).toBe(true)
    // optional fields of the wrong type are absent, not a refusal
    expect(s.items[0]).toEqual(expect.objectContaining({ cost: '', evidence: [], seen: false }))
    const noSubject = proposeList(INITIAL_IMPROVE, { subject: '', items: [item('i1')] }, { interactive: true, what: 'the parser' })
    expect('state' in noSubject && noSubject.state.subject).toBe('the parser')
    const nothing = proposeList(INITIAL_IMPROVE, { items: [item('i1')] }, WHAT)
    expect('state' in nothing && nothing.state.subject).toBe('bu konuşma')
  })

  test('each invalid list is refused naming the item, and nothing is stored', () => {
    const bad: [string, unknown, RegExp][] = [
      ['no items', undefined, /1 to 30/],
      ['an empty list', [], /1 to 30/],
      ['31 items', Array.from({ length: 31 }, (_, n) => item(`i${n}`)), /1 to 30/],
      ['a repeated id', [item('i1'), item('i1')], /item 2 repeats the id i1/],
      ['a bad id', [item('i 1')], /item 1 has an id/],
      ['an id of the person\'s kind', [item('u1')], /item 1 \(u1\)/],
      ['an unknown group', [item('i1', 'bug' as never)], /item 1 \(i1\) has a group/],
      ['an empty title', [item('i1', 'problem', { title: '  ' })], /item 1 \(i1\) has an empty title/],
      ['an entry that is not an object', ['text'], /item 1 is not an object/],
    ]
    for (const [name, items, message] of bad) {
      const out = proposeList(INITIAL_IMPROVE, { subject: 's', items }, WHAT)
      expect(name).toBeTruthy()
      expect('error' in out && out.error).toMatch(message)
      expect('error' in out && out.error).toMatch(/nothing was shown$/)
    }
    expect(proposeList(INITIAL_IMPROVE, { subject: 's', items: [item('i1')] }, { interactive: false, what: '' })).toEqual({
      error: 'verinoda improve: nobody is at the keyboard to choose; ask in text instead',
    })
  })

  test('first sight: the seven best-ranked, a decided, a verified or an open item beyond them, and a group unfolded whole', () => {
    let s = listed()
    const first = sightOf(s)
    expect([...first.visible]).toEqual(['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'])
    // hidden counts only what is not drawn: i8 i11 (improvements), i9 i12 (problems), i10 (taste)
    expect(first.hidden).toEqual({ problem: 2, improvement: 2, taste: 1 })
    s = decided(s, 'i12', 'apply')
    expect(sightOf(s).visible.has('i12')).toBe(true)
    expect(sightOf(s).hidden.problem).toBe(1)
    s = { ...s, open: 'i10' }
    expect(sightOf(s).visible.has('i10')).toBe(true)
    s = { ...s, items: s.items.map(i => (i.id === 'i11' ? { ...i, verified: true } : i)) }
    expect(sightOf(s).visible.has('i11')).toBe(true)
    s = unfold(s, 'problem')
    expect(sightOf(s).hidden.problem).toBe(0)
    expect(sightOf(s).visible.has('i9')).toBe(true)
  })

  test('decisions: apply, keep, check; the same again clears; check only for an unverified problem', () => {
    let s = listed()
    s = decided(s, 'i1', 'apply')
    expect(s.items[0]?.decision).toBe('apply')
    s = decided(s, 'i1', 'keep')
    expect(s.items[0]?.decision).toBe('keep')
    s = decided(s, 'i1', 'keep')
    expect(s.items[0]?.decision).toBe('none')
    s = decided(s, 'i2', 'check')
    expect(s.items[1]?.decision).toBe('check')
    expect(decided(s, 'i3', 'check').items[2]?.decision).toBe('none') // an improvement: nothing to check
    const verified = { ...s, items: s.items.map(i => (i.id === 'i2' ? { ...i, verified: true, decision: 'none' as const } : i)) }
    expect(decided(verified, 'i2', 'check').items[1]?.decision).toBe('none')
    expect(countsOf(decided(decided(s, 'i3', 'apply'), 'i4', 'keep'))).toEqual({ items: 12, apply: 1, check: 1, keep: 1 })
  })

  test('the selection prompt names apply, check and keep, only what was decided, and the person\'s own items', () => {
    let s = listed()
    expect(selectionPrompt(s)).not.toContain('Apply these') // nothing decided: nothing named
    s = decided(decided(decided(s, 'i3', 'apply'), 'i2', 'check'), 'i5', 'keep')
    s = addOwn(s, 'rename the flag')
    const text = selectionPrompt(s)
    expect(text.startsWith('My decisions on the improvement list (src/a.py):')).toBe(true)
    expect(text).toContain('Apply these:\n- [i3] title i3: change i3\n- [u1] rename the flag (my own item)')
    expect(text).toContain('Check these first (investigate only; change nothing for them):\n- [i2] title i2')
    expect(text).toContain('Keep these as they are (do not change them, also not as a side effect):\n- [i5] title i5')
    expect(text).not.toContain('i1]') // undecided: never named
    expect(text).toContain(REPORT_TOOL)
    const onlyApply = selectionPrompt(decided(listed(), 'i3', 'apply'))
    expect(onlyApply).not.toContain('Check these')
    expect(onlyApply).not.toContain('Keep these')
    // after a send, an item with an outcome is not named again
    const sent = send(s)
    expect(selectionPrompt(sent)).not.toContain('[i3]')
    expect(reportPrompt(['i3', 'u1'])).toContain('(i3, u1)')
    expect(reviewPrompt('')).toContain('what we have been working on in this conversation')
    expect(reviewPrompt('src/a.py')).toContain('What to look at: src/a.py')
  })

  test('a report: each status lands, a confirmed problem goes back into the list, a bad report records nothing', () => {
    let s = decided(decided(decided(listed(), 'i3', 'apply'), 'i5', 'apply'), 'i2', 'check')
    s = decided(s, 'i1', 'check')
    s = send(s)
    const ok = applyReport(s, {
      outcomes: [
        { id: 'i3', status: 'applied', note: 'done', evidence: ['a.py:3', 7, ''] },
        { id: 'i2', status: 'confirmed', note: 'it is real', change: 'fix the loop', evidence: ['c.py:4'] },
        { id: 'i1', status: 'not_confirmed', note: 'fine' },
      ],
      extra_changes: ['touched d.py', 3, '', 'and e.py'],
    })
    if (!('state' in ok)) throw new Error(ok.error)
    expect(ok.answer).toBe('Recorded: 3 outcomes. Still waiting for: i5.')
    const by = (id: string) => ok.state.items.find(i => i.id === id)
    expect(by('i3')?.outcome).toEqual({ status: 'applied', note: 'done', evidence: ['a.py:3'] })
    expect(by('i1')?.outcome?.status).toBe('not_confirmed')
    expect(by('i2')).toEqual(expect.objectContaining({ verified: true, checked: 'it is real', change: 'fix the loop', outcome: null, decision: 'none', sentAs: null }))
    expect(by('i2')?.evidence).toEqual(['c.py:4'])
    expect(ok.state.extra).toEqual(['touched d.py', 'and e.py'])
    expect(ok.state.phase).toBe('sent') // one item is still waiting
    const rest = applyReport(ok.state, { outcomes: [{ id: 'i5', status: 'failed', note: 'could not' }] })
    expect('state' in rest && rest.state.phase).toBe('choosing')

    const refused: [unknown, RegExp][] = [
      [[], /at least one item; nothing was recorded/],
      [[{ id: 'i3', status: 'applied', note: 'x' }, { id: 'i3', status: 'applied', note: 'x' }], /item i3 is reported twice/],
      [[{ id: 'i9', status: 'applied', note: 'x' }], /no item i9 is waiting for an outcome/],
      [[{ id: 'i4', status: 'applied', note: 'x' }], /no item i4 is waiting/], // never sent
      [[{ id: 'i3', status: 'done', note: 'x' }], /item i3 was sent to apply; its outcome is one of applied, partial, failed/],
      [[{ id: 'i3', status: 'confirmed', note: 'x' }], /item i3 was sent to apply/],
      [[{ id: 'i2', status: 'applied', note: 'x' }], /item i2 was sent to check; its outcome is one of confirmed, not_confirmed/],
      [[{ id: 'i3', status: 'applied', note: '  ' }], /item i3 needs a note the user can read/],
    ]
    for (const [outcomes, message] of refused) {
      const out = applyReport(s, { outcomes })
      expect('error' in out && out.error).toMatch(message)
    }
    // a final item accepts no second report
    const again = applyReport(ok.state, { outcomes: [{ id: 'i3', status: 'applied', note: 'x' }] })
    expect('error' in again && again.error).toMatch(/no item i3 is waiting/)
  })
})

// ---- the wiring ------------------------------------------------------------------------------------------------

type Opts = { placed?: boolean; drop?: 'review' | 'selection' | 'report' | 'all' }

// The world beneath the plugin: an indexed project, and a record of what the plugin registered, opened and submitted.
function world(on: On, opts: Opts = {}) {
  const tools: string[] = []
  const commands: string[] = []
  const opened: { id: string; title?: string; focus?: boolean }[] = []
  const submitted: { text: string; origin?: unknown; context?: readonly string[] }[] = []
  on('session.start', () => ({ cwd: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.stat', () => ({ value: { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 } }) as never)
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__verinoda-live__${e.name}` } } as never
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opened.push({ id: e.id, title: e.title, focus: e.focus })
    return { value: opts.placed === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } } as never
  })
  on('process.run', ($, e) => {
    if (e.argv[1] === '-c') return { value: { exitCode: 0, stdout: '{"locked": false, "behind": 0}', stderr: '' } } as never
    if (e.argv[1] === 'check') return { value: { exitCode: 0, stdout: '{"sites": []}', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '{}', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, origin: e.origin, context: e.context })
    const kind = e.text.startsWith('My decisions') ? 'selection' : e.text.startsWith('Report the outcome') ? 'report' : 'review'
    if (opts.drop === 'all' || opts.drop === kind) return { drop: 'refused' } as never
    return { text: e.text, context: e.context }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are an agent.', scope: 'shared' }] }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  return { tools, commands, opened, submitted }
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never
const cmd = (args = '') => ({ command: 'verinoda-improve', args }) as never
const propose = (items: unknown[] = TWELVE, subject = 'src/a.py') => ({ tool: PROPOSE_TOOL, subject, items }) as never
const report = (outcomes: unknown[], extra?: unknown) => ({ tool: REPORT_TOOL, outcomes, extra_changes: extra }) as never
const done = (turnId: string, agentId?: string) =>
  ({ turnId, ...(agentId === undefined ? {} : { agentId }), answer: '', durationMs: 1, isAborted: false, reason: 'end_turn' }) as never
const result = (r: unknown) => (r as { result?: string }).result ?? ''
const text = (r: unknown) => (r as { text?: string }).text ?? ''

const MOUNT = (surface: 'terminal' | 'desktop' | 'mobile' = 'terminal', bodyColumns = 48, isFocused = true) => ({
  plugin: 'verinoda-live', surface, component: 'Pane', requestId: 'verinoda-improve',
  props: { title: 'İyileştirme', isFocused, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } } as never,
}) as never

async function begin($: Engine, on: On, opts: Opts = {}, extra: { options?: Record<string, unknown>; start?: unknown } = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world(on, opts)
  await $.session.start((extra.start ?? START) as never)
  await clock.settle()
  return { ...w, clock }
}

describe('improve: the command and the tools', () => {
  test('a scripted session: the command says it needs a person, opens nothing, lists no tool, submits nothing', async ($, on) => {
    const w = await begin($, on, {}, { start: SCRIPTED })
    const res = await $.command.run(cmd())
    expect(text(res)).toBe('verinoda improve needs a person to choose: it does nothing in a scripted session')
    expect(w.opened).toEqual([])
    expect(w.tools).toEqual([])
    expect(w.submitted).toEqual([])
    expect(result(await $.tool.call(propose()))).toBe('verinoda improve: nobody is at the keyboard to choose; ask in text instead')
  })

  test('an interactive session: no tool before the command, both after it; the command opens the pane and asks for the review as the person', async ($, on) => {
    const w = await begin($, on)
    expect(w.tools).toEqual([])
    expect(w.commands).toContain('verinoda-improve')
    const res = await $.command.run(cmd('where is the parser slow?'))
    await w.clock.advance(100)
    await w.clock.settle()
    expect(text(res)).toBe('looking at it; the list will appear in the pane, and nothing is changed until you choose')
    expect(w.tools.sort()).toEqual(['improve_propose', 'improve_report'])
    expect(w.opened).toEqual([{ id: 'verinoda-improve', title: 'İyileştirme', focus: true }])
    expect(w.submitted.length).toBe(1)
    expect(w.submitted[0]?.text).toContain('What to look at: where is the parser slow?')
    expect(w.submitted[0]?.origin).toEqual(expect.objectContaining({ kind: 'plugin', name: 'verinoda-live', asUser: true }))
    // a reload (a second session.start) with a list on the screen lists the tools again
    w.tools.length = 0
    await $.session.start(START)
    expect(w.tools.sort()).toEqual(['improve_propose', 'improve_report'])
  })

  test('both tools are first-class, not behind ToolSearch', async ($, on) => {
    await begin($, on)
    for (const tool of [PROPOSE_TOOL, REPORT_TOOL]) {
      const described = await $.tool.describe({ tool, description: 'd' } as never)
      expect(described).toEqual(expect.objectContaining({ isDeferred: false }))
    }
  })

  test('the mod\'s own prompts pass its prompt hook untouched: no context, no task for the gate', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, { auto: 'nudge', assist: 'strict' })
    const w = world(on)
    await $.session.start(START)
    await clock.settle()
    await $.command.run(cmd('where is the parser slow?'))
    await clock.advance(100)
    await clock.settle()
    expect(w.submitted[0]?.context ?? []).toEqual([])
    await $.tool.call(propose())
    await $.ui.mount(MOUNT())
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await clock.advance(100)
    await clock.settle()
    expect(w.submitted[1]?.text.startsWith('My decisions')).toBe(true)
    expect(w.submitted[1]?.context ?? []).toEqual([])
    // the person's own code question still gets the nudge: the bypass is for the mod's prompts only
    const ask = await $.prompt.submit({ text: 'Where is the graph rebuilt after update?', wait: false, origin: { kind: 'composer' } } as never)
    expect((ask.context ?? []).length).toBeGreaterThan(0)
  })

  test('improve_propose draws the three groups in order, marks the unseen and the unproved, selects nothing, and says Shown', async ($, on) => {
    await begin($, on)
    await $.command.run(cmd('src/a.py'))
    const answer = result(await $.tool.call(propose()))
    expect(answer).toBe('Shown to the user: 12 items (5 possible problems, 4 improvements, 3 matters of taste). Stop here: change nothing and wait for their selection, which arrives as a message.')
    const pane = await $.ui.mount(MOUNT())
    expect(await pane.find({ text: /İyileştirme: src\/a\.py/ })).toBeDefined()
    expect(await pane.find({ text: /12 madde$/ })).toBeDefined() // nothing selected: only the count
    expect((await pane.find({ key: 'item-i1' }))?.props.label).toBe('[ ] title i1')
    expect((await pane.find({ key: 'item-i2' }))?.props.label).toBe('[ ] title i2 (kanıtsız)')
    expect((await pane.find({ key: 'item-i4' }))?.props.label).toBe('[ ] title i4 (tahmin)')
    expect((await pane.find({ key: 'item-i7' }))?.props.label).toBe('[ ] title i7')
    expect(await pane.find({ key: 'send' })).toBeUndefined()
    expect(await pane.find({ text: /Göndermek için en az bir madde seçin\./ })).toBeDefined()
    expect(await pane.find({ key: 'item-i8' })).toBeUndefined() // folded
    expect((await pane.find({ key: 'more-improvement' }))?.props.label).toBe('2 madde daha')
    const flatText = JSON.stringify(await pane.drawn())
    expect(flatText.indexOf('Olası sorunlar')).toBeLessThan(flatText.indexOf('İşlevsel iyileştirmeler'))
    expect(flatText.indexOf('İşlevsel iyileştirmeler')).toBeLessThan(flatText.indexOf('Estetik seçenekler'))
  })

  test('improve_propose answers that the list is stored when the pane is not placed', async ($, on) => {
    await begin($, on, { placed: false })
    const answer = result(await $.tool.call(propose([item('i1'), item('i2')])))
    expect(answer).toBe('The list is stored (2 items) but the pane is not on screen. Tell the user to run /verinoda-improve to see it. Change nothing meanwhile.')
  })
})

describe('improve: the pane', () => {
  test('a row opens its details; a problem without evidence says so; apply marks it and send appears; keep alone sends nothing', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i2' })
    expect(await pane.find({ text: /Gözlem: obs i2/ })).toBeDefined()
    expect(await pane.find({ text: /Neden: why i2/ })).toBeDefined()
    expect(await pane.find({ text: /Öneri: change i2/ })).toBeDefined()
    expect(await pane.find({ text: /^Kanıt verilmedi$/ })).toBeDefined()
    expect(await pane.find({ key: 'act-check' })).toBeDefined()
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-keep' })
    expect((await pane.find({ key: 'item-i2' }))?.props.label).toBe('[–] title i2 (kanıtsız)')
    expect(await pane.find({ key: 'send' })).toBeUndefined() // keep alone sends nothing
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    expect((await pane.find({ key: 'send' }))?.props.label).toBe('Gönder (1)')
    expect((await pane.find({ key: 'act-apply' }))?.props.label).toBe('● Uygula')
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' }) // the same again clears it
    expect((await pane.find({ key: 'item-i2' }))?.props.label).toBe('[ ] title i2 (kanıtsız)')
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' }) // an improvement: nothing to check first
    expect(await pane.find({ key: 'act-check' })).toBeUndefined()
    await $.ui.press({ plugin: 'verinoda-live', key: 'more-improvement' })
    expect(await pane.find({ key: 'item-i8' })).toBeDefined()
    expect(await pane.find({ key: 'more-improvement' })).toBeUndefined()
  })

  test('the person\'s own items: typed, added selected, the field emptied, removable, never a reused id, ten at most', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose([item('i1')]))
    const pane = await $.ui.mount(MOUNT())
    await $.ui.input({ plugin: 'verinoda-live', key: 'own', text: 'rename the flag', kind: 'change' } as never)
    expect((await pane.find({ key: 'own' }))?.props.value).toBe('rename the flag')
    await $.ui.input({ plugin: 'verinoda-live', key: 'own', text: 'rename the flag' } as never)
    expect((await pane.find({ key: 'item-u1' }))?.props.label).toBe('[✓] rename the flag')
    expect((await pane.find({ key: 'own' }))?.props.value).toBe('')
    expect((await pane.find({ key: 'send' }))?.props.label).toBe('Gönder (1)')
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-u1' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-remove' })
    expect(await pane.find({ key: 'item-u1' })).toBeUndefined()
    await $.ui.input({ plugin: 'verinoda-live', key: 'own', text: 'second' } as never)
    expect(await pane.find({ key: 'item-u2' })).toBeDefined() // u2, not u1 again
    for (let n = 3; n <= 11; n++) await $.ui.input({ plugin: 'verinoda-live', key: 'own', text: `item ${n}` } as never)
    expect(await pane.find({ key: 'item-u11' })).toBeDefined() // u2 to u11: ten
    expect(await pane.find({ key: 'own' })).toBeUndefined() // the field is not drawn beyond ten
  })

  test('send asks as the person and waits: nothing can be marked, stop-waiting is the way out', async ($, on) => {
    const w = await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await w.clock.advance(100)
    await w.clock.settle()
    await w.clock.advance(100)
    await w.clock.settle()
    expect(w.submitted.at(-1)?.text).toContain('Apply these:\n- [i3] title i3: change i3')
    expect(w.submitted.at(-1)?.origin).toEqual(expect.objectContaining({ kind: 'plugin', name: 'verinoda-live', asUser: true }))
    for (const key of ['item-i1', 'own', 'send', 'ask-report', 'more-improvement', 'act-apply']) expect(await pane.find({ key })).toBeUndefined()
    expect(await pane.find({ text: /i3.*… bekleniyor/ })).toBeDefined()
    expect(await pane.find({ text: /Seçimleriniz gönderildi; sonuçlar burada görünecek\./ })).toBeDefined()
    await $.ui.press({ plugin: 'verinoda-live', key: 'stop-waiting' })
    expect(await pane.find({ text: /\? Sonuç bildirilmedi · title i3/ })).toBeDefined()
    expect(await pane.find({ key: 'ask-report' })).toBeDefined()
  })

  test('improve_propose during a send is refused; during choosing it replaces the list and keeps the unsent own items', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    await $.ui.input({ plugin: 'verinoda-live', key: 'own', text: 'mine' } as never)
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    // choosing: a new list replaces the old, the own item stays, and the answer says what was replaced
    const replaced = result(await $.tool.call(propose([item('n1'), item('n2')], 'other')))
    expect(replaced).toMatch(/The earlier list \(12 items, 1 decisions\) was replaced\.$/)
    expect(await pane.find({ key: 'item-n1' })).toBeDefined()
    expect(await pane.find({ key: 'item-i3' })).toBeUndefined()
    expect(await pane.find({ key: 'item-u1' })).toBeDefined()
    // sent: refused, the list is as it was
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    const refused = result(await $.tool.call(propose([item('z1')])))
    expect(refused).toBe('verinoda improve: a selection is being applied; report its outcomes with improve_report before proposing a new list')
    expect(await pane.find({ text: /u1.*… bekleniyor|mine … bekleniyor/ })).toBeDefined()
  })

  test('improve_report: partial reports keep waiting, the last one returns to choosing, a repeat is refused, extras are listed', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    for (const id of ['i3', 'i5']) {
      await $.ui.press({ plugin: 'verinoda-live', key: `item-${id}` })
      await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    }
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    const first = result(await $.tool.call(report([{ id: 'i3', status: 'applied', note: 'done', evidence: ['a.py:3'] }], ['touched d.py'])))
    expect(first).toBe('Recorded: 1 outcomes. Still waiting for: i5.')
    expect(await pane.find({ text: /✓ Uygulandı · title i3/ })).toBeDefined()
    expect(await pane.find({ text: /i5 … bekleniyor|title i5 … bekleniyor/ })).toBeDefined()
    expect(await pane.find({ key: 'stop-waiting' })).toBeDefined() // still sent
    const second = result(await $.tool.call(report([{ id: 'i5', status: 'partial', note: 'half' }])))
    expect(second).toBe('Recorded: 1 outcomes.')
    expect(await pane.find({ text: /◐ Kısmen uygulandı · title i5/ })).toBeDefined()
    expect(await pane.find({ key: 'stop-waiting' })).toBeUndefined() // back to choosing
    expect(await pane.find({ key: 'item-i1' })).toBeDefined()
    expect(await pane.find({ text: /Listede olmayan değişiklikler/ })).toBeDefined()
    expect(await pane.find({ text: /· touched d\.py/ })).toBeDefined()
    expect(result(await $.tool.call(report([{ id: 'i3', status: 'applied', note: 'again' }])))).toMatch(/no item i3 is waiting for an outcome/)
  })

  test('the mod\'s own turn: a turn already running, a subagent and an older tracked turn change nothing; the matching one does', async ($, on) => {
    const w = await begin($, on)
    await $.command.run(cmd('src/a.py'))
    await w.clock.advance(100)
    await w.clock.settle()
    await $.turn.start({ text: 'Make a list of what could be changed here so that I can choose. Do not change anything yet.\nWhat to look at: src/a.py', turnId: 'review' } as never)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    for (const id of ['i3', 'i5']) {
      await $.ui.press({ plugin: 'verinoda-live', key: `item-${id}` })
      await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    }
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await w.clock.advance(100)
    await w.clock.settle()
    // the review's own turn is still running when send is pressed: its end must not count; nor a subagent's
    await $.turn.complete(done('review'))
    await $.turn.complete(done('other', 'sub-1'))
    await $.turn.complete(done('running'))
    expect(await pane.find({ key: 'stop-waiting' })).toBeDefined()
    expect(await pane.find({ text: /Sonuç bildirilmedi/ })).toBeUndefined()
    // the selection's own turn begins and ends with one item still waiting
    await $.turn.start({ text: w.submitted.at(-1)?.text ?? '', turnId: 'sel' } as never)
    await $.tool.call(report([{ id: 'i3', status: 'applied', note: 'done' }]))
    await $.turn.complete(done('sel'))
    expect(await pane.find({ text: /\? Sonuç bildirilmedi · title i5/ })).toBeDefined()
    expect(await pane.find({ key: 'stop-waiting' })).toBeUndefined()
    // asking for it: the report prompt goes out as the person's, and a report that arrives is accepted
    await $.ui.press({ plugin: 'verinoda-live', key: 'ask-report' })
    await w.clock.advance(100)
    await w.clock.settle()
    expect(w.submitted.at(-1)?.text).toContain('(i5)')
    expect(result(await $.tool.call(report([{ id: 'i5', status: 'applied', note: 'late' }])))).toBe('Recorded: 1 outcomes.')
    expect(await pane.find({ text: /✓ Uygulandı · title i5/ })).toBeDefined()
  })

  test('a review that ends without a list says so; a list that comes later replaces the line; another turn changes nothing', async ($, on) => {
    await begin($, on)
    await $.command.run(cmd())
    const pane = await $.ui.mount(MOUNT())
    expect(await pane.find({ text: /İnceleniyor… Claude listeyi hazırlıyor/ })).toBeDefined()
    await $.turn.complete(done('unrelated'))
    expect(await pane.find({ text: /Liste henüz gelmedi/ })).toBeUndefined()
    await $.turn.start({ text: 'Make a list of what could be changed here so that I can choose. Do not change anything yet.', turnId: 'review' } as never)
    await $.turn.complete(done('review'))
    expect(await pane.find({ text: /Liste henüz gelmedi\. Claude bir soru sormuş olabilir/ })).toBeDefined()
    await $.tool.call(propose([item('i1')]))
    expect(await pane.find({ text: /Liste henüz gelmedi/ })).toBeUndefined()
    expect(await pane.find({ key: 'item-i1' })).toBeDefined()
  })

  test('a confirmed check puts the item back in the list, verified, with the check\'s note and no second check', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i2' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-check' })
    expect((await pane.find({ key: 'item-i2' }))?.props.label).toBe('[?] title i2 (kanıtsız)')
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await $.tool.call(report([{ id: 'i2', status: 'confirmed', note: 'the loop skips the last row', change: 'use <= here', evidence: ['c.py:4'] }]))
    expect((await pane.find({ key: 'item-i2' }))?.props.label).toBe('[ ] title i2 (doğrulandı)')
    expect(await pane.find({ text: /İnceleme: the loop skips the last row/ })).toBeDefined()
    expect(await pane.find({ text: /Öneri: use <= here/ })).toBeDefined()
    expect(await pane.find({ key: 'act-check' })).toBeUndefined()
  })

  test('the command: choosing with no argument only opens; with one starts over and says so; sent starts nothing; all final starts anew', async ($, on) => {
    const w = await begin($, on)
    await $.command.run(cmd('src/a.py'))
    await w.clock.advance(100)
    await w.clock.settle()
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    expect(text(await $.command.run(cmd()))).toBe('improvement list opened (12 items)')
    expect(w.submitted.length).toBe(1) // only the first review was asked for
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await w.clock.advance(100)
    await w.clock.settle()
    expect(text(await $.command.run(cmd('other')))).toBe('a selection is being applied; its outcomes will show in the pane')
    expect(w.submitted.length).toBe(2)
    await $.tool.call(report([{ id: 'i3', status: 'applied', note: 'done' }]))
    await pane.find({ key: 'item-i4' }) // the tree is drawn again after the report
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i4' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-keep' })
    expect(text(await $.command.run(cmd('the parser')))).toBe('looking at it; the list will appear in the pane, and nothing is changed until you choose (the earlier list of 12 items was replaced)')
    await w.clock.advance(100)
    await w.clock.settle()
    expect(w.submitted.at(-1)?.text).toContain('What to look at: the parser')
    expect(await pane.find({ text: /İnceleniyor/ })).toBeDefined()
    // every item has a final outcome and nothing is left to mark: a bare command starts over
    await $.tool.call(propose([item('f1')]))
    await pane.find({ key: 'item-f1' }) // the tree is drawn again after the list
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-f1' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await w.clock.advance(100)
    await w.clock.settle()
    await $.tool.call(report([{ id: 'f1', status: 'applied', note: 'ok' }]))
    expect(text(await $.command.run(cmd()))).toMatch(/^looking at it/)
  })

  test('a prompt the engine did not take: a review goes back to idle, a selection is sendable again, a report is asked again', async ($, on) => {
    // a review
    const w = await begin($, on, { drop: 'review' })
    await $.command.run(cmd())
    await w.clock.advance(100)
    await w.clock.settle()
    const idle = await $.ui.mount(MOUNT())
    expect(await idle.find({ text: /Liste yok\. \/verinoda-improve/ })).toBeDefined()
    expect(await idle.find({ text: /İstek gönderilemedi\./ })).toBeDefined()
  })

  test('a selection that did not enter puts the marks back and can be sent again; so does a report request', async ($, on) => {
    await begin($, on, { drop: 'selection' })
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    expect(await pane.find({ text: /İstek gönderilemedi\./ })).toBeDefined()
    expect((await pane.find({ key: 'item-i3' }))?.props.label).toBe('[✓] title i3')
    expect((await pane.find({ key: 'send' }))?.props.label).toBe('Gönder (1)')
  })

  test('a report request that did not enter leaves the items unreported', async ($, on) => {
    const w = await begin($, on, { drop: 'report' })
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT())
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i3' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'send' })
    await w.clock.advance(100)
    await w.clock.settle()
    await $.turn.start({ text: w.submitted.at(-1)?.text ?? '', turnId: 'sel' } as never)
    await $.turn.complete(done('sel'))
    await pane.find({ key: 'ask-report' }) // the tree is drawn again after the turn
    await $.ui.press({ plugin: 'verinoda-live', key: 'ask-report' })
    await w.clock.advance(100)
    await w.clock.settle()
    expect(await pane.find({ text: /İstek gönderilemedi\./ })).toBeDefined()
    expect(await pane.find({ text: /\? Sonuç bildirilmedi · title i3/ })).toBeDefined()
    expect(await pane.find({ key: 'ask-report' })).toBeDefined()
    await $.ui.press({ plugin: 'verinoda-live', key: 'stop-waiting' }).catch(() => undefined) // not drawn: nothing waits
    await $.tool.call(propose([item('n1')])) // a new list removes the line
    expect(await pane.find({ text: /İstek gönderilemedi\./ })).toBeUndefined()
  })

  test('with the setting off: no tool and no section; /clear resets the list, another end does not', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const w = world(on)
    // off
    await $.session.start(START)
    await clock.settle()
    expect(w.tools).toEqual([])
    expect((await $.prompt.compose(COMPOSE) as unknown as { sections: { id: string }[] }).sections.map(s => s.id)).not.toContain('verinoda-live:improve')
    // a list, then the session ends: a clear resets it, another reason does not
    await $.command.run(cmd('a'))
    await $.tool.call(propose())
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(text(await $.command.run(cmd()))).toBe('improvement list opened (12 items)')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(text(await $.command.run(cmd()))).toMatch(/^looking at it/) // phase idle: it starts a review
  })
})

describe('improve: the offer setting', () => {
  test('with the setting on the tools and the prompt section are there from the start', { options: { improveOffer: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const w = world(on)
    await $.session.start(START)
    await clock.settle()
    expect(w.tools.sort()).toEqual(['improve_propose', 'improve_report'])
    const sections = ((await $.prompt.compose(COMPOSE)) as unknown as { sections: { id: string; scope: string; text: string }[] }).sections
    const offer = sections.find(s => s.id === 'verinoda-live:improve')
    expect(offer?.scope).toBe('session')
    expect(offer?.text).toContain('/verinoda-improve')
  })

  test('with the setting on a scripted session gets neither', { options: { improveOffer: true } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const w = world(on)
    await $.session.start(SCRIPTED)
    await clock.settle()
    expect(w.tools).toEqual([])
    const sections = ((await $.prompt.compose(COMPOSE)) as unknown as { sections: { id: string }[] }).sections
    expect(sections.map(s => s.id)).not.toContain('verinoda-live:improve')
  })
})

describe('improve: surfaces', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the pane is the same on ${surface}`, async ($, on) => {
      await begin($, on)
      await $.tool.call(propose())
      const pane = await $.ui.mount(MOUNT(surface))
      expect(await pane.find({ key: 'item-i1' })).toBeDefined()
      expect(await pane.find({ key: 'own' })).toBeDefined()
    })
  }

  test('mobile has no Input and says where to add an item', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT('mobile'))
    expect(await pane.find({ key: 'item-i1' })).toBeDefined()
    expect(await pane.find({ key: 'own' })).toBeUndefined()
    expect(await pane.find({ text: /Kendi maddenizi eklemek için terminali ya da masaüstünü kullanın\./ })).toBeDefined()
  })

  test('at 30 columns the tree still validates and keeps its controls', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const pane = await $.ui.mount(MOUNT('terminal', 30))
    expect(await pane.find({ key: 'item-i1' })).toBeDefined()
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i1' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    expect((await pane.find({ key: 'send' }))?.props.label).toBe('Gönder (1)')
  })

  test('the footer names only the keys that exist and changes when the pane does not hold the keyboard', async ($, on) => {
    await begin($, on)
    await $.tool.call(propose())
    const focused = await $.ui.mount(MOUNT('terminal', 48, true))
    expect(await focused.find({ text: /^tab gezin · enter aç$/ })).toBeDefined() // nothing marked, nothing open: no g, no u k c
    await $.ui.press({ plugin: 'verinoda-live', key: 'item-i2' })
    await $.ui.press({ plugin: 'verinoda-live', key: 'act-apply' })
    expect(await focused.find({ text: /^g gönder · u uygula · k kalsın · c kontrol · tab gezin · enter aç$/ })).toBeDefined()
    await focused.unmount()
    const idle = await $.ui.mount(MOUNT('terminal', 48, false))
    expect(await idle.find({ text: /^Seçmek için ctrl\+x tab$/ })).toBeDefined()
  })

  test('nothing in the list is a pane without a count line; an empty improve is the idle line', async ($, on) => {
    await begin($, on)
    const pane = await $.ui.mount(MOUNT())
    expect(await pane.find({ text: /Liste yok\. \/verinoda-improve \[neye bakılsın\] ile başlatın\./ })).toBeDefined()
    expect(listOf(INITIAL_IMPROVE)).toEqual([])
  })
})
