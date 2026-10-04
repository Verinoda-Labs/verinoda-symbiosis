// The improvement checklist pane, wired (IMPROVE-PANE.md): the command, the two tools, the turns that are the mod's own,
// the pane. The logic that needs no engine is in ./improve.ts. This is a module of its own, called by `register`, so that
// register.tsx does not grow by a feature's whole body; it keeps its own state (`mod`) and reads `$.state` for the rest.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ImproveGroup, ImproveState } from '../types'
import {
  addOwn, applyReport, askReport, countsLine, countsOf, dropped, GROUP_LABEL, hasUnreported, IMPROVE_PANE, IMPROVE_TOOL_SPECS,
  INITIAL_IMPROVE, isSendable, listOf, MARK, MODEL_GROUPS, OFFER_SECTION, onTurnComplete, onTurnStart, ownCount, OWN_MAX,
  PROPOSE_TOOL, proposeAnswer, proposeList, REPORT_TOOL, removeOwn, replacedBy, reportPrompt, RESULT_LABEL, resultsOf, reviewPrompt,
  selectionPrompt, send, setDecision, sightOf, startReview, stopWaiting, suffixOf, toggleOpen, unfold,
} from './improve'

const improve = atom({ plugin: 'verinoda-live', key: 'improve' } as const, INITIAL_IMPROVE)

// Module state: a reload runs `session.start` again, which sets both.
const mod = { interactive: false, offer: false }

const PANE_ROWS = 16
const PANE_TITLE = 'İyileştirme'
const REVIEW_DELAY_MS = 50

// Work left running after a hook returns: a reload or the end of the session aborts its $ calls, which is no error.
function background(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

async function registerTools($: EngineInterface): Promise<void> {
  // a name registered again is replaced, so there is no flag to keep
  for (const spec of IMPROVE_TOOL_SPECS) {
    await $.tool.register({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema as unknown as Record<string, unknown> })
  }
}

// A prompt of the mod's, as the person's words; never awaited by the hook or the press that raised it. One the engine
// did not take puts the state back as it was before the press.
function submit($: EngineInterface, text: string, kind: 'review' | 'selection' | 'report'): void {
  const back = () => update($, improve, s => (s.expect === kind ? dropped(s, kind) : s))
  background($.prompt.submit({ text, asUser: true }).then(r => (r.drop !== undefined ? back() : undefined), back))
}

async function openPane($: EngineInterface, focus: boolean): Promise<boolean> {
  const res = await $.ui.open({ id: IMPROVE_PANE, title: PANE_TITLE, rows: PANE_ROWS, ...(focus ? { focus: true as const } : {}) })
  return (res as { isPlaced?: boolean } | undefined)?.isPlaced !== false
}

async function pressSend($: EngineInterface): Promise<void> {
  const s = await read($, improve)
  if (s.phase !== 'choosing' || !s.items.some(isSendable)) return
  const text = selectionPrompt(s)
  await update($, improve, send)
  submit($, text, 'selection')
}

async function pressAskReport($: EngineInterface): Promise<void> {
  const s = await read($, improve)
  if (s.phase !== 'choosing' || !hasUnreported(s)) return
  const ids = s.items.filter(i => i.outcome?.status === 'unreported').map(i => i.id)
  await update($, improve, askReport)
  submit($, reportPrompt(ids), 'report')
}

const edit = ($: EngineInterface, fn: (s: ImproveState) => ImproveState) => update($, improve, fn).catch(() => undefined)

type On = Parameters<Register>[0]
type Options = Parameters<Register>[1]

// Called by register.tsx with its `on`: a plugin has one hooks module, the engine follows `$` only within one file, and it
// refuses two hooks of one event with no matcher. So the three events register.tsx also hooks (`session.start`,
// `prompt.compose`, `turn.complete`) carry a matcher here that every call satisfies.
export function registerImprove(on: On, options: Options): void {
  // a scripted session has nobody to type the command; `mod.interactive` stays false there and the tools are never listed
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    mod.interactive = true
    mod.offer = options.improveOffer === true
    await $.command.register({
      name: 'verinoda-improve', argumentHint: '[what to look at]',
      description: 'List what could be changed here and choose what to apply; nothing changes until you choose.',
    })
    // the tools are listed to the model only on request: after the command, or at once when the offer is on
    if (mod.interactive && (mod.offer || (await read($, improve)).phase !== 'idle')) await registerTools($)
    return next(e)
  })

  on('prompt.compose', { model: /./ }, async ($, e, next) => {
    const out = await next(e)
    if (!mod.offer || !mod.interactive) return out
    return { sections: [...out.sections, { ...OFFER_SECTION, scope: 'session' as const }] }
  })

  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const n = onTurnComplete(await read($, improve), e.turnId)
      if (n !== undefined) await update($, improve, () => n)
    }
    return next(e)
  })

  on('tool.describe', { tool: [PROPOSE_TOOL, REPORT_TOOL] }, ($, e) => {
    const spec = IMPROVE_TOOL_SPECS.find(s => `mcp__verinoda-live__${s.name}` === e.tool)
    return { description: spec?.description ?? e.description, isDeferred: false }
  })

  // `/clear` ends the conversation without a `session.start` after it, so the list of the old one is dropped here.
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') background(update($, improve, () => INITIAL_IMPROVE))
    return next(e)
  })

  on('command.run', { command: 'verinoda-improve' }, async ($, e) => {
    const what = e.args.trim()
    if (!mod.interactive) return { text: 'verinoda improve needs a person to choose: it does nothing in a scripted session' }
    const s = await read($, improve)
    if (s.phase === 'sent') {
      await openPane($, true)
      return { text: 'a selection is being applied; its outcomes will show in the pane' }
    }
    const list = listOf(s)
    if (s.phase === 'choosing' && what === '' && (list.length > 0 || hasUnreported(s))) {
      await openPane($, true)
      return { text: `improvement list opened (${list.length} items)` }
    }
    const replaced = replacedBy(s)
    await registerTools($)
    await update($, improve, () => startReview(s, what))
    await openPane($, true) // the person's command is behind it: placed at any width
    // The host refuses a prompt raised from inside a command's hook ("it would wait on the turn this hook is holding";
    // seen in the test host, not tried in a real session), so the review is asked for a moment after the hook has returned.
    background($.clock.sleep(REVIEW_DELAY_MS).then(() => submit($, reviewPrompt(what), 'review')))
    return {
      text: 'looking at it; the list will appear in the pane, and nothing is changed until you choose' +
        (replaced === null ? '' : ` (the earlier list of ${replaced} items was replaced)`),
    }
  })

  on('tool.call', { tool: PROPOSE_TOOL }, async ($, e) => {
    const s = await read($, improve)
    const out = proposeList(s, { items: e.items, subject: e.subject }, { interactive: mod.interactive, what: s.phase === 'reviewing' ? s.subject : '' })
    if ('error' in out) return { result: out.error }
    await update($, improve, () => out.state)
    // opened by a model's call, not by the person: on a narrow terminal it may wait undrawn
    const placed = await openPane($, false)
    return { result: proposeAnswer(out.state.items, placed, out.replaced) }
  })

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    const s = await read($, improve)
    const out = applyReport(s, { outcomes: e.outcomes, extra_changes: e.extra_changes })
    if ('error' in out) return { result: out.error }
    await update($, improve, () => out.state)
    return { result: out.answer }
  })

  // Which turn is the mod's own: the one that begins with the prompt just submitted, and only the newest.
  on('turn.start', async ($, e, next) => {
    const s = await read($, improve)
    const n = onTurnStart(s, e.text, e.turnId)
    if (n !== undefined) await update($, improve, () => n)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: IMPROVE_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // mobile has none: its table names an Input that draws nothing, so the surface decides, not the table
    const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
    const s = await read($, improve)

    if (s.phase === 'idle' || s.phase === 'reviewing') {
      const first = s.phase === 'idle'
        ? 'Liste yok. /verinoda-improve [neye bakılsın] ile başlatın.'
        : s.note === 'no-list'
          ? 'Liste henüz gelmedi. Claude bir soru sormuş olabilir: yanıtlayın ya da /verinoda-improve ile yeniden başlatın.'
          : 'İnceleniyor… Claude listeyi hazırlıyor; hiçbir şey değiştirilmiyor.'
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text key="state" wrap="wrap">{first}</Text>
          {s.phase === 'idle' && s.note === 'not-sent' && <Text key="not-sent" color="yellow" wrap="wrap">İstek gönderilemedi.</Text>}
        </Box>
      )
    }

    const isSent = s.phase === 'sent'
    const list = listOf(s)
    const results = resultsOf(s)
    const sight = sightOf(s)
    const counts = countsOf(s)
    const sendable = counts.apply + counts.check
    const open = s.open === null ? undefined : list.find(i => i.id === s.open)

    const row = (i: (typeof list)[number]) => {
      const label = `${MARK[i.decision]} ${i.title}${i.group === 'own' ? '' : suffixOf(i)}`
      const details = i.id === s.open ? (
        <Box key={`open-${i.id}`} flexDirection="column" paddingLeft={4}>
          {i.group === 'own' && <Text key="own-text" wrap="wrap">{i.title}</Text>}
          {i.group !== 'own' && <Text key="obs" wrap="wrap">{`Gözlem: ${i.observation}`}</Text>}
          {i.group !== 'own' && <Text key="why" wrap="wrap">{`Neden: ${i.why}`}</Text>}
          {i.group !== 'own' && <Text key="change" wrap="wrap">{`Öneri: ${i.change}`}</Text>}
          {i.group !== 'own' && i.cost !== '' && <Text key="cost" wrap="wrap">{`Bedel: ${i.cost}`}</Text>}
          {i.group !== 'own' && i.evidence.length > 0 && <Text key="evidence" wrap="wrap">{`Kanıt: ${i.evidence.join(', ')}`}</Text>}
          {i.group === 'problem' && i.evidence.length === 0 && <Text key="evidence" wrap="wrap">Kanıt verilmedi</Text>}
          {i.verified && <Text key="checked" wrap="wrap">{`İnceleme: ${i.checked}`}</Text>}
          {!isSent && (
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              {i.group === 'own' && <Button key="act-remove" label="Kaldır" variant="secondary" onPress={() => edit($, st => removeOwn(st, i.id))} />}
              {i.group !== 'own' && (
                <Button key="act-apply" label={`${i.decision === 'apply' ? '● ' : ''}Uygula`} hotkey="u"
                  variant={i.decision === 'apply' ? 'primary' : 'secondary'} onPress={() => edit($, st => setDecision(st, i.id, 'apply'))} />
              )}
              {i.group !== 'own' && (
                <Button key="act-keep" label={`${i.decision === 'keep' ? '● ' : ''}Kalsın`} hotkey="k"
                  variant={i.decision === 'keep' ? 'primary' : 'secondary'} onPress={() => edit($, st => setDecision(st, i.id, 'keep'))} />
              )}
              {i.group === 'problem' && !i.verified && (
                <Button key="act-check" label={`${i.decision === 'check' ? '● ' : ''}Önce kontrol et`} hotkey="c"
                  variant={i.decision === 'check' ? 'primary' : 'secondary'} onPress={() => edit($, st => setDecision(st, i.id, 'check'))} />
              )}
            </Box>
          )}
        </Box>
      ) : null
      return (
        <Box key={`row-${i.id}`} flexDirection="column">
          {isSent
            ? <Text key={`row-text-${i.id}`} wrap="wrap">{`${label}${i.outcome?.status === 'waiting' ? ' … bekleniyor' : ''}`}</Text>
            : <Button key={`item-${i.id}`} label={label} variant="secondary" onPress={() => edit($, st => toggleOpen(st, i.id))} />}
          {details}
        </Box>
      )
    }

    const group = (g: ImproveGroup) => {
      const inGroup = list.filter(i => i.group === g)
      if (inGroup.length === 0) return null
      const shown = g === 'own' ? inGroup : inGroup.filter(i => sight.visible.has(i.id))
      const folded = g === 'own' ? 0 : sight.hidden[g]
      return (
        <Box key={`group-${g}`} flexDirection="column">
          <Text bold>{GROUP_LABEL[g]}</Text>
          {shown.map(row)}
          {!isSent && folded > 0 && <Button key={`more-${g}`} label={`${folded} madde daha`} variant="secondary" onPress={() => edit($, st => unfold(st, g))} />}
        </Box>
      )
    }

    const ownCanGrow = ownCount(s) < OWN_MAX
    const keys = [
      !isSent && sendable > 0 ? 'g gönder' : '',
      !isSent && open !== undefined && open.group !== 'own' ? `u uygula · k kalsın${open.group === 'problem' && !open.verified ? ' · c kontrol' : ''}` : '',
      'tab gezin · enter aç',
    ].filter(Boolean)

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box key="head" flexDirection="column">
          <Text bold wrap="wrap">{`İyileştirme: ${s.subject}`}</Text>
          {!isSent && counts.items > 0 && <Text key="counts" dimColor wrap="wrap">{countsLine(counts)}</Text>}
          {!isSent && s.note === 'not-sent' && <Text key="not-sent" color="yellow" wrap="wrap">İstek gönderilemedi.</Text>}
        </Box>
        {results.length > 0 && (
          <Box key="results" flexDirection="column">
            <Text bold>Sonuçlar</Text>
            {results.map(i => {
              const status = (i.outcome?.status ?? 'unreported') as keyof typeof RESULT_LABEL
              const note = i.outcome?.note ?? ''
              const evidence = i.outcome?.evidence ?? []
              return (
                <Box key={`result-${i.id}`} flexDirection="column">
                  <Text wrap="wrap">{`${RESULT_LABEL[status]} · ${i.title}`}</Text>
                  {note !== '' && <Text dimColor wrap="wrap">{`    ${note}`}</Text>}
                  {evidence.length > 0 && <Text dimColor wrap="wrap">{`    ${evidence.join(', ')}`}</Text>}
                </Box>
              )
            })}
            {!isSent && hasUnreported(s) && <Button key="ask-report" label="Sonucu iste" variant="secondary" onPress={() => background(pressAskReport($))} />}
          </Box>
        )}
        {s.extra.length > 0 && (
          <Box key="extra" flexDirection="column">
            <Text bold>Listede olmayan değişiklikler</Text>
            {s.extra.map((x, n) => <Text key={`extra-${n}`} wrap="wrap">{`· ${x}`}</Text>)}
          </Box>
        )}
        {MODEL_GROUPS.map(group)}
        {group('own')}
        {!isSent && list.length > 0 && ownCanGrow && (Input !== undefined
          ? (
            <Input key="own" label="Kendi maddeniz" submitLabel="ekle" value={s.draft}
              onInput={v => { edit($, st => ({ ...st, draft: v })) }} onSubmit={v => { edit($, st => addOwn(st, v)) }} />
          )
          : <Text key="own-mobile" dimColor wrap="wrap">Kendi maddenizi eklemek için terminali ya da masaüstünü kullanın.</Text>)}
        {!isSent && list.length > 0 && (sendable > 0
          ? <Button key="send" label={`Gönder (${sendable})`} hotkey="g" variant="primary" onPress={() => background(pressSend($))} />
          : <Text key="send-hint" dimColor wrap="wrap">Göndermek için en az bir madde seçin.</Text>)}
        {isSent && (
          <Box key="sent" flexDirection="column">
            <Text key="sent-line" wrap="wrap">Seçimleriniz gönderildi; sonuçlar burada görünecek.</Text>
            <Button key="stop-waiting" label="Beklemeyi bırak" variant="secondary" onPress={() => edit($, stopWaiting)} />
          </Box>
        )}
        <Text key="footer" dimColor wrap="wrap">{e.props.isFocused ? keys.join(' · ') : 'Seçmek için ctrl+x tab'}</Text>
      </Box>
    )
  })
}

