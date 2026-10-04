// The pure part of the improvement checklist pane (IMPROVE-PANE.md): validating and storing a proposed list, the
// decisions, what is sendable, what the first sight shows, applying a report, the three prompts the mod submits and the
// tool specs. Nothing here touches the engine; improve-pane.tsx wires it.
//
// The rule behind every function: nothing changes without the person's decision, and an item nobody decided about is
// "not decided", never rejected and never sent.

import type { ImproveDecision, ImproveGroup, ImproveItem, ImproveState, ImproveStatus } from '../types'

export const IMPROVE_PANE = 'verinoda-improve'
export const PROPOSE_TOOL = 'mcp__verinoda-live__improve_propose'
export const REPORT_TOOL = 'mcp__verinoda-live__improve_report'
export const SUBJECT_FALLBACK = 'bu konuşma'

export const INITIAL_IMPROVE: ImproveState = {
  phase: 'idle', subject: '', items: [], open: null, unfolded: [], extra: [], draft: '', ownSeq: 0, expect: '', turn: null, note: '',
}

export const MODEL_GROUPS = ['problem', 'improvement', 'taste'] as const
export const SHOWN_FIRST = 7 // the list's best-ranked items the pane shows before a group is opened
export const OWN_MAX = 10
const ITEMS_MAX = 30
const TITLE_MAX = 120
const TEXT_MAX = 600
const EVIDENCE_MAX = 6
const EVIDENCE_LINE_MAX = 160
const SUBJECT_MAX = 80
const OWN_TEXT_MAX = 300
const EXTRA_MAX = 20
const EXTRA_LINE_MAX = 300
const ID = /^[A-Za-z0-9_-]{1,16}$/
const OWN_ID = /^u\d+$/

export const isOwnPrompt = (origin: unknown): boolean => {
  const o = origin as { kind?: string; name?: string } | undefined
  return o?.kind === 'plugin' && o.name === 'verinoda-live'
}

// A text as stored: trimmed, and a cut one ends in an ellipsis that counts toward the limit.
export function cut(value: string, max: number): string {
  const t = value.trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// An optional list of strings: a value of another type is absent, a non-string or empty entry is dropped.
function evidenceOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter(isText).map(x => cut(x, EVIDENCE_LINE_MAX)).slice(0, EVIDENCE_MAX)
}

// ---- the list ----------------------------------------------------------------------------------------------------

// The list is what can still be marked or is being waited for; the results are what has an answer (or none came).
export const inList = (i: ImproveItem): boolean => i.outcome === null || i.outcome.status === 'waiting'
export const isResult = (i: ImproveItem): boolean => !inList(i)
export const isSendable = (i: ImproveItem): boolean => (i.decision === 'apply' || i.decision === 'check') && i.outcome === null
export const listOf = (s: ImproveState): ImproveItem[] => s.items.filter(inList)
export const resultsOf = (s: ImproveState): ImproveItem[] => s.items.filter(isResult)
export const waitingIds = (s: ImproveState): string[] => s.items.filter(i => i.outcome?.status === 'waiting').map(i => i.id)

export type Counts = { items: number; apply: number; check: number; keep: number }
export function countsOf(s: ImproveState): Counts {
  const list = listOf(s)
  return {
    items: list.length,
    apply: list.filter(i => isSendable(i) && i.decision === 'apply').length,
    check: list.filter(i => isSendable(i) && i.decision === 'check').length,
    keep: list.filter(i => i.decision === 'keep').length,
  }
}

export type Proposed = { items?: unknown; subject?: unknown }
export type ProposeOutcome = { error: string } | { state: ImproveState; replaced: { n: number; decided: number } | null }

// What a model's `improve_propose` does. The first failure is the answer and nothing is stored.
export function proposeList(s: ImproveState, args: Proposed, ctx: { interactive: boolean; what: string }): ProposeOutcome {
  if (!ctx.interactive) return { error: 'verinoda improve: nobody is at the keyboard to choose; ask in text instead' }
  if (s.phase === 'sent') {
    return { error: 'verinoda improve: a selection is being applied; report its outcomes with improve_report before proposing a new list' }
  }
  const refuse = (why: string): ProposeOutcome => ({ error: `verinoda improve: ${why}; nothing was shown` })
  const raw = args.items
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ITEMS_MAX) return refuse(`items must be a list of 1 to ${ITEMS_MAX} items`)
  const seen = new Set<string>()
  const items: ImproveItem[] = []
  for (const [n, entry] of raw.entries()) {
    const at = `item ${n + 1}`
    if (!isRecord(entry)) return refuse(`${at} is not an object`)
    const id = entry.id
    if (typeof id !== 'string' || !ID.test(id)) return refuse(`${at} has an id that is not 1 to 16 letters, digits, - or _`)
    if (OWN_ID.test(id)) return refuse(`${at} (${id}) has an id of the form u and digits, kept for the person's own items`)
    if (seen.has(id)) return refuse(`${at} repeats the id ${id}`)
    seen.add(id)
    const group = entry.group
    if (!(MODEL_GROUPS as readonly unknown[]).includes(group)) return refuse(`${at} (${id}) has a group that is not problem, improvement or taste`)
    for (const field of ['title', 'observation', 'why', 'change'] as const) {
      if (!isText(entry[field])) return refuse(`${at} (${id}) has an empty ${field}`)
    }
    items.push({
      id, group: group as ImproveGroup,
      title: cut(entry.title as string, TITLE_MAX), observation: cut(entry.observation as string, TEXT_MAX),
      why: cut(entry.why as string, TEXT_MAX), change: cut(entry.change as string, TEXT_MAX),
      cost: isText(entry.cost) ? cut(entry.cost, TEXT_MAX) : '',
      evidence: evidenceOf(entry.evidence), seen: entry.seen === true,
      verified: false, checked: '', decision: 'none', sentAs: null, outcome: null,
    })
  }
  const old = s.items.filter(i => i.group !== 'own')
  const decided = old.filter(i => i.decision !== 'none').length
  const subject = typeof args.subject === 'string' && args.subject.trim() !== ''
    ? cut(args.subject, SUBJECT_MAX) : ctx.what !== '' ? cut(ctx.what, SUBJECT_MAX) : SUBJECT_FALLBACK
  // the person's own items that were not sent stay: they wrote them, the model's new list does not take them back
  const own = s.items.filter(i => i.group === 'own' && i.outcome === null && i.sentAs === null)
  return {
    state: { ...s, phase: 'choosing', subject, items: [...items, ...own], open: null, unfolded: [], extra: [], note: '' },
    replaced: decided > 0 ? { n: old.length, decided } : null,
  }
}

export function proposeAnswer(items: ImproveItem[], placed: boolean, replaced: { n: number; decided: number } | null): string {
  const n = items.filter(i => i.group !== 'own').length
  const by = (g: ImproveGroup) => items.filter(i => i.group === g).length
  const tail = replaced === null ? '' : ` The earlier list (${replaced.n} items, ${replaced.decided} decisions) was replaced.`
  if (!placed) {
    return `The list is stored (${n} items) but the pane is not on screen. Tell the user to run /verinoda-improve to see it. Change nothing meanwhile.${tail}`
  }
  return `Shown to the user: ${n} items (${by('problem')} possible problems, ${by('improvement')} improvements, ${by('taste')} matters of taste). ` +
    `Stop here: change nothing and wait for their selection, which arrives as a message.${tail}`
}

// ---- what the first sight shows --------------------------------------------------------------------------------

export type Sight = { visible: Set<string>; hidden: Record<'problem' | 'improvement' | 'taste', number> }

// Of the model's items in the list the seven best-ranked, and besides them any item with a decision, any verified one
// and the open one. A group that was unfolded shows whole.
export function sightOf(s: ImproveState): Sight {
  const model = listOf(s).filter(i => i.group !== 'own')
  const visible = new Set<string>()
  model.forEach((i, rank) => {
    if (rank < SHOWN_FIRST || i.decision !== 'none' || i.verified || i.id === s.open || s.unfolded.includes(i.group)) visible.add(i.id)
  })
  const hidden = { problem: 0, improvement: 0, taste: 0 }
  for (const i of model) if (!visible.has(i.id) && i.group !== 'own') hidden[i.group] += 1
  return { visible, hidden }
}

// ---- the person's decisions --------------------------------------------------------------------------------------

export function setDecision(s: ImproveState, id: string, decision: ImproveDecision): ImproveState {
  const item = s.items.find(i => i.id === id)
  if (s.phase !== 'choosing' || item === undefined || item.outcome !== null || item.group === 'own') return s
  if (decision === 'check' && (item.group !== 'problem' || item.verified)) return s
  const next: ImproveDecision = item.decision === decision ? 'none' : decision
  return { ...s, items: s.items.map(i => (i.id === id ? { ...i, decision: next } : i)) }
}

export function toggleOpen(s: ImproveState, id: string): ImproveState {
  return { ...s, open: s.open === id ? null : id }
}

export function unfold(s: ImproveState, group: ImproveGroup): ImproveState {
  return s.unfolded.includes(group) ? s : { ...s, unfolded: [...s.unfolded, group] }
}

export function addOwn(s: ImproveState, text: string): ImproveState {
  const t = cut(text, OWN_TEXT_MAX)
  const count = s.items.filter(i => i.group === 'own' && inList(i)).length
  if (s.phase !== 'choosing' || t === '' || count >= OWN_MAX) return s
  const k = s.ownSeq + 1
  const item: ImproveItem = {
    id: `u${k}`, group: 'own', title: t, observation: '', why: '', change: '', cost: '', evidence: [], seen: false,
    verified: false, checked: '', decision: 'apply', sentAs: null, outcome: null,
  }
  return { ...s, items: [...s.items, item], ownSeq: k, draft: '' }
}

export function removeOwn(s: ImproveState, id: string): ImproveState {
  const item = s.items.find(i => i.id === id)
  if (item === undefined || item.group !== 'own' || !inList(item)) return s
  return { ...s, items: s.items.filter(i => i.id !== id), open: s.open === id ? null : s.open }
}

export const ownCount = (s: ImproveState): number => s.items.filter(i => i.group === 'own' && inList(i)).length

// ---- the flow ----------------------------------------------------------------------------------------------------

// The command starts a review: the model's items, the results and the notes go; the person's own items that were not sent stay.
export function startReview(s: ImproveState, what: string): ImproveState {
  const own = s.items.filter(i => i.group === 'own' && i.outcome === null && i.sentAs === null)
  return { ...s, phase: 'reviewing', subject: cut(what, SUBJECT_MAX), items: own, open: null, unfolded: [], extra: [], expect: 'review', turn: null, note: '' }
}

// What starting over would throw away, for the command's answer: the model's items, when any of them held a decision.
export function replacedBy(s: ImproveState): number | null {
  const old = s.items.filter(i => i.group !== 'own')
  return old.some(i => i.decision !== 'none') ? old.length : null
}

// Pressing send marks the sendable items as sent; their decision, and so their mark, stays.
export function send(s: ImproveState): ImproveState {
  return {
    ...s, phase: 'sent', expect: 'selection', turn: null, note: '',
    items: s.items.map(i => (isSendable(i)
      ? { ...i, sentAs: i.decision === 'check' ? 'check' as const : 'apply' as const, outcome: { status: 'waiting' as ImproveStatus, note: '', evidence: [] } }
      : i)),
  }
}

const toUnreported = (i: ImproveItem): ImproveItem =>
  (i.outcome?.status === 'waiting' ? { ...i, outcome: { status: 'unreported' as ImproveStatus, note: '', evidence: [] } } : i)

export function stopWaiting(s: ImproveState): ImproveState {
  return { ...s, phase: 'choosing', expect: '', turn: null, note: '', items: s.items.map(toUnreported) }
}

export const hasUnreported = (s: ImproveState): boolean => s.items.some(i => i.outcome?.status === 'unreported')

export function askReport(s: ImproveState): ImproveState {
  return {
    ...s, phase: 'sent', expect: 'report', turn: null, note: '',
    items: s.items.map(i => (i.outcome?.status === 'unreported' ? { ...i, outcome: { status: 'waiting' as ImproveStatus, note: '', evidence: [] } } : i)),
  }
}

// A prompt the engine did not take: the state is as it was before the press, and the pane says so.
export function dropped(s: ImproveState, kind: 'review' | 'selection' | 'report'): ImproveState {
  const base = { ...s, expect: '' as const, note: 'not-sent' as const }
  if (kind === 'review') return { ...base, phase: 'idle' }
  if (kind === 'selection') {
    return { ...base, phase: 'choosing', items: s.items.map(i => (i.outcome?.status === 'waiting' ? { ...i, sentAs: null, outcome: null } : i)) }
  }
  return { ...base, phase: 'choosing', items: s.items.map(toUnreported) }
}

// ---- the turns ---------------------------------------------------------------------------------------------------

// The first line of a prompt the mod submitted, as far as it is the same whatever the list holds.
export const PROMPT_HEAD = {
  review: 'Make a list of what could be changed here so that I can choose.',
  selection: 'My decisions on the improvement list (',
  report: 'Report the outcome of the items I sent that you have not reported yet',
} as const

// A turn that begins with the text of the prompt just submitted is the mod's own: only that one is tracked.
export function onTurnStart(s: ImproveState, text: string, turnId: string): ImproveState | undefined {
  if (s.expect === '' || !text.trim().startsWith(PROMPT_HEAD[s.expect])) return undefined
  return { ...s, expect: '', turn: turnId }
}

// The mod's own turn ended (or was interrupted): what the model did not report is not known, and a review with no list
// says so. Any other turn changes nothing.
export function onTurnComplete(s: ImproveState, turnId: string): ImproveState | undefined {
  if (s.turn === null || s.turn !== turnId) return undefined
  if (s.phase === 'sent') return { ...s, turn: null, phase: 'choosing', items: s.items.map(toUnreported) }
  if (s.phase === 'reviewing') return { ...s, turn: null, note: 'no-list' }
  return { ...s, turn: null }
}

// ---- the report --------------------------------------------------------------------------------------------------

export const STATUSES = ['applied', 'partial', 'failed', 'confirmed', 'not_confirmed'] as const
const FITS: Record<'apply' | 'check', readonly string[]> = { apply: ['applied', 'partial', 'failed'], check: ['confirmed', 'not_confirmed'] }

export type ReportArgs = { outcomes?: unknown; extra_changes?: unknown }
export type ReportOutcome = { error: string } | { state: ImproveState; answer: string }

export function applyReport(s: ImproveState, args: ReportArgs): ReportOutcome {
  const refuse = (why: string): ReportOutcome => ({ error: `verinoda improve: ${why}` })
  const raw = args.outcomes
  if (!Array.isArray(raw) || raw.length < 1 || !raw.every(isRecord)) {
    return refuse('outcomes must list at least one item; nothing was recorded')
  }
  const ids = new Set<string>()
  for (const o of raw) {
    const id = String(o.id)
    if (ids.has(id)) return refuse(`item ${id} is reported twice`)
    ids.add(id)
  }
  for (const o of raw) {
    const id = String(o.id)
    const item = s.items.find(i => i.id === id)
    const status = item?.outcome?.status
    if (item === undefined || (status !== 'waiting' && status !== 'unreported')) return refuse(`no item ${id} is waiting for an outcome`)
    const sentAs = item.sentAs ?? 'apply'
    if (typeof o.status !== 'string' || !FITS[sentAs].includes(o.status)) {
      return refuse(`item ${id} was sent to ${sentAs}; its outcome is one of ${FITS[sentAs].join(', ')}`)
    }
    if (!isText(o.note)) return refuse(`item ${id} needs a note the user can read`)
  }
  const byId = new Map(raw.map(o => [String(o.id), o]))
  const items = s.items.map(i => {
    const o = byId.get(i.id)
    if (o === undefined) return i
    const note = cut(o.note as string, TEXT_MAX)
    const evidence = evidenceOf(o.evidence)
    if (o.status === 'confirmed') {
      // a confirmed problem is not an outcome: it goes back into the list, to be marked again, with what the check found
      return {
        ...i, verified: true, checked: note, outcome: null, decision: 'none' as ImproveDecision, sentAs: null,
        change: isText(o.change) ? cut(o.change, TEXT_MAX) : i.change, evidence: [...i.evidence, ...evidence].slice(0, EVIDENCE_MAX),
      }
    }
    return { ...i, outcome: { status: o.status as ImproveStatus, note, evidence } }
  })
  const extra = Array.isArray(args.extra_changes)
    ? [...s.extra, ...args.extra_changes.filter(isText).map(x => cut(x, EXTRA_LINE_MAX))].slice(0, EXTRA_MAX) : s.extra
  const next: ImproveState = { ...s, items, extra }
  const waiting = waitingIds(next)
  const state = waiting.length === 0 && s.phase === 'sent' ? { ...next, phase: 'choosing' as const } : next
  return { state, answer: `Recorded: ${raw.length} outcomes.${waiting.length > 0 ? ` Still waiting for: ${waiting.join(', ')}.` : ''}` }
}

// ---- the prompts the mod submits (all as the person's words) ----------------------------------------------------

export function reviewPrompt(what: string): string {
  const look = what.trim() === ''
    ? 'what we have been working on in this conversation. If that is not clear, ask me one question first.' : what.trim()
  return [
    `${PROMPT_HEAD.review} Do not change anything yet.`,
    `What to look at: ${look}`,
    '',
    'Look at it first: read the code, and if it has a rendered view you can look at, look at it. Then call',
    `${PROPOSE_TOOL} with the items, ranked, the most worth doing first. Do not pad the list. Then stop and`,
    'wait for my selection.',
  ].join('\n')
}

export function selectionPrompt(s: ImproveState): string {
  const line = (i: ImproveItem, withChange: boolean) => i.group === 'own'
    ? `- [${i.id}] ${i.title} (my own item)` : `- [${i.id}] ${i.title}${withChange ? `: ${i.change}` : ''}`
  const sendable = s.items.filter(isSendable)
  const apply = sendable.filter(i => i.decision === 'apply')
  const check = sendable.filter(i => i.decision === 'check')
  const keep = s.items.filter(i => i.outcome === null && i.decision === 'keep')
  const parts = [`${PROMPT_HEAD.selection}${s.subject}):`]
  if (apply.length > 0) parts.push('', 'Apply these:', ...apply.map(i => line(i, true)))
  if (check.length > 0) parts.push('', 'Check these first (investigate only; change nothing for them):', ...check.map(i => line(i, false)))
  if (keep.length > 0) parts.push('', 'Keep these as they are (do not change them, also not as a side effect):', ...keep.map(i => line(i, false)))
  parts.push(
    '',
    'Everything else stays as it is. You may make the small auxiliary changes an item needs. If one would add behaviour, change',
    'behaviour I did not choose, or cost something, tell me before you do it. When you are done or cannot go on, call',
    `${REPORT_TOOL} with one outcome for each item to apply or to check, and list under extra_changes any`,
    'change that was not on the list.',
  )
  return parts.join('\n')
}

export function reportPrompt(ids: string[]): string {
  return `${PROMPT_HEAD.report} (${ids.join(', ')}) with ${REPORT_TOOL}.\nChange nothing else.`
}

// ---- the tools ---------------------------------------------------------------------------------------------------

export const IMPROVE_TOOL_SPECS = [
  {
    name: 'improve_propose',
    description:
      'Show the user a list of what could be changed, in the Verinoda pane, so that they choose. Call it only when the user asked ' +
      'for improvement options or a review list, in words or with /verinoda-improve; never on your own initiative. Before calling, ' +
      'look at the code or the screen in question and change nothing. Rank the items, the most worth doing first, and do not pad ' +
      'the list. Each item is one change the user can say yes or no to. `group`: `problem` is a possible bug, inconsistency or ' +
      'unexpected behaviour (give `evidence`, the file:line you read); `improvement` is usability, readability, performance or ' +
      'upkeep; `taste` is look, tone, density, colour or layout, a preference and not a defect (set `seen` to true only if you ' +
      'judged it from a rendered view or a screenshot). `title` says the change in one concrete line (not "improve the hierarchy" ' +
      'but "make Save the only primary button"); `observation` is what is there now; `why` is why it may matter; `change` is ' +
      'exactly what you would do and what stays as it is; `cost` is what it costs or risks, if anything. After the call, stop: ' +
      'change nothing and wait for the user\'s selection, which arrives as a message.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What was looked at, in a few words: a file, a screen, a module' },
        items: {
          type: 'array', minItems: 1, maxItems: ITEMS_MAX,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short and unique in this list: i1, i2, ...' },
              group: { enum: ['problem', 'improvement', 'taste'] },
              title: { type: 'string' }, observation: { type: 'string' }, why: { type: 'string' }, change: { type: 'string' },
              cost: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, seen: { type: 'boolean' },
            },
            required: ['id', 'group', 'title', 'observation', 'why', 'change'],
          },
        },
      },
      required: ['subject', 'items'],
    },
  },
  {
    name: 'improve_report',
    description:
      'Report what happened to each item the user sent from the Verinoda pane, once you are done or cannot go on. One outcome per ' +
      'item id you were given. For an item to apply: `applied` (done as described), `partial` (say what is missing) or `failed` ' +
      '(say why). For an item to check first: `confirmed` (the problem is real; put the fix you propose in `change` and do not ' +
      'apply it) or `not_confirmed` (you looked and found nothing that needs a change). `note` is one or two sentences the user ' +
      'reads; `evidence` is what shows it: the check you ran and its result, a file:line. List under `extra_changes` every change ' +
      'you made that was not on the list.',
    inputSchema: {
      type: 'object',
      properties: {
        outcomes: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, status: { enum: [...STATUSES] }, note: { type: 'string' }, change: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'status', 'note'],
          },
        },
        extra_changes: { type: 'array', items: { type: 'string' } },
      },
      required: ['outcomes'],
    },
  },
] as const

export const OFFER_SECTION = {
  id: 'verinoda-live:improve',
  text:
    'When the user asks for something to be better, nicer, cleaner or of higher quality without saying what should change, do ' +
    'not guess and do not start editing. Offer in one line to list what could be changed so that they choose: ' +
    '`/verinoda-improve` opens the list, and they may add what to look at. If they ask for the list in words, look first, then ' +
    `call \`${PROPOSE_TOOL}\`. A request that says what to change is not vague: do it.`,
} as const

// ---- the pane's words (Turkish) ---------------------------------------------------------------------------------

export const GROUP_LABEL: Record<ImproveGroup, string> = {
  problem: 'Olası sorunlar', improvement: 'İşlevsel iyileştirmeler', taste: 'Estetik seçenekler', own: 'Sizin eklediğiniz',
}
export const MARK: Record<ImproveDecision, string> = { none: '[ ]', apply: '[✓]', keep: '[–]', check: '[?]' }
export const RESULT_LABEL: Record<'applied' | 'partial' | 'failed' | 'not_confirmed' | 'unreported', string> = {
  applied: '✓ Uygulandı', partial: '◐ Kısmen uygulandı', failed: '✗ Uygulanamadı',
  not_confirmed: '○ İncelendi: sorun doğrulanmadı', unreported: '? Sonuç bildirilmedi',
}

// The suffix a row carries: one at most.
export function suffixOf(i: ImproveItem): string {
  if (i.verified) return ' (doğrulandı)'
  if (i.group === 'problem' && i.evidence.length === 0) return ' (kanıtsız)'
  if (i.group === 'taste' && !i.seen) return ' (tahmin)'
  return ''
}

export function countsLine(c: Counts): string {
  if (c.items === 0) return ''
  return [`${c.items} madde`, c.apply > 0 ? `${c.apply} uygula` : '', c.check > 0 ? `${c.check} kontrol` : '', c.keep > 0 ? `${c.keep} kalsın` : '']
    .filter(Boolean).join(' · ')
}
