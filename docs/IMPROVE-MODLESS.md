# The improvement checklist without a mod: Codex CLI (backlog 13.10)

Status: **design, not built.** Decided 2026-10-04 with the person who uses Codex in a terminal (`codex`, the CLI; version
not yet known, see the unknowns). This is the brief for whoever builds it. The mod's version of the same feature is
`claude-mods/verinoda-live/IMPROVE-PANE.md` (built as D175, tested only against a test host); read its "rules that decide
every open question" first: they hold here unchanged.

## What it is for

The same as the mod's: a vague request ("make this better") becomes a short ranked list the person can recognise their
wish in; they mark what to apply, keep or check first; only then does the agent work. The mod draws that as a pane in
Claude Code. Codex has no mod mechanism and no pane, so this version is made of what Verinoda already installs for
Codex (`verinoda install --agent codex`: a skill and an MCP server, `verinoda/agents/installer.py`) and nothing else.

## What carries over, what does not

Carries over, word for word, from the mod's brief:

1. Nothing changes without the person's decision; opening the list is not consent.
2. Nothing is selected at the start. An item without a decision means "not decided": never rejected, never sent.
3. A suspicion is not a fact: a `problem` item shows its evidence (`file:line`) or says it has none; a `taste` item the
   model did not judge from a rendered view says it is a guess. "Check first" asks for an investigation, not a change.
4. The first sight is short: the seven best-ranked items; the rest folded by group, not padded.
5. Only on request: the person's explicit words. Nothing of this runs on its own.
6. A session with nobody at the keyboard (`codex exec`, no terminal) gets none of it.
7. The boundary of the work is what the person chose; every change that was not on the list is reported.

Does not carry over: the pane, the clickable rows, the mascot, `$.state`, the mod's turn tracking, and anything that needs
an event hook the person did not install. Selecting is typed, not clicked: that is the price, and it is said so in the
skill.

## The shape

One new pure module, `verinoda/improve.py`, written as the state machine of `claude-mods/verinoda-live/hooks/improve.ts`
(validate and store a list, decisions, what is sendable, first sight, the report, the three prompts), with the same
messages. Three doors into it, so that no agent needs a mod:

- the CLI: `verinoda improve propose|decide|show|report` (JSON in, text out), for an agent that has a shell and no MCP;
- MCP tools `improve_propose`, `improve_decide`, `improve_show`, `improve_report`, **behind `run_tool` and in the full
  profile**, not in the core menu (backlog rule: the core profile stays at five tools; each listed tool is standing
  context in every request);
- the skill, which says when and how to call them.

State is **per server process**, in memory: Codex starts the MCP server per session over stdio, so one session is one list
and two sessions in one project cannot see each other's choices. (The mod's store taught this: a choice kept in a file
shared by every session reached sessions that never asked for it, `claude-mods/verinoda-live/AGENTS.md`, host fact 3.)
A file (`.verinoda/improve/<session>.json`) is for step 2 (a browser page needs to read it), not for step 1.

## The flow (what the person types)

The person writes `$verinoda improve [what to look at]` (Codex has no slash command for a skill, see
`agents/templates/codex_SKILL.md`). Then:

1. The agent looks at the code and **changes nothing**, then calls `improve_propose` with the items (same schema as the
   mod's tool; same validation; same cuts).
2. The tool answers with the list **rendered as text** (below) and "show this to the user as it is, then stop and wait".
   The agent prints it. The model must not summarise or reorder it; the instruction says so, and the first test of a real
   session is whether it does (see the unknowns).
3. The person answers in a line, for example `3u 5k 2c +ekle şunu da` (below). The agent passes the line **unchanged** to
   `improve_decide`: the parsing is code, not the model's reading. The tool echoes what it recorded.
4. `send` (or `gönder`) in that line, or a line that is only that word, makes `improve_decide` answer with the **work
   order** (the mod's selection prompt, verbatim) and set the phase to `sent`. The agent works on exactly that.
5. The agent calls `improve_report` (same schema and validation as the mod's) and prints the results the tool renders.

The rendered list, an example (labels Turkish, like the pane; a setting for the language is the answer-language item, not
this one):

```
İyileştirme: src/parser.py  (9 madde)

Olası sorunlar
 1 [ ] Boş girdide IndexError (kanıtsız)
 2 [ ] Son satır atlanıyor · parser.py:88
İşlevsel iyileştirmeler
 3 [ ] Hata iletisinde dosya adı yok
 4 [ ] ...
 2 madde daha: `more improvement`
Sizin eklediğiniz
 (yok)

Yanıt: numara + harf. u uygula · k kalsın · c önce kontrol et · 0 temizle. Örnek: `2u 3k 1c`
Kendi maddeniz için: `+ metin`.  Göndermek için: `gönder`.
```

Grammar of the reply (`improve_decide`), small on purpose: tokens `<number><u|k|c|0>`; `+ <text>` adds an own item (at most
10); `more <group>` unfolds; `show` redraws; `send`/`gönder` sends; `reset` starts over. Anything else is refused with the
grammar, never guessed at. `c` is refused outside a `problem` and on a verified item, as in the mod. Numbers are the rank
in the drawing, not the model's ids (the person never types an id).

## Where the agent's choice is taken away from it

The prompt-only rule ("change nothing until the list is chosen") is only a request to the model. Two things make it hold
better, in order of cost:

- the skill says it first and the tool answers say it again ("change nothing; wait for the person's line");
- **optional, version-dependent:** a Codex `PreToolUse` hook on `apply_patch` and on the shell's writing commands that
  denies while the phase is `reviewing` or `choosing`. `verinoda agent-hooks` already writes `.codex/hooks.json`
  (`PostToolUse` on Bash, `verinoda/agent_hooks.py`); a `PreToolUse` entry would be one more. It needs the person's Codex
  to run such a hook and to let it deny; both are unknowns. Without it the rule is a request, and the design says so.

## What the skill says

A new section in `agents/templates/codex_SKILL.md`, and in `claude_SKILL.md` for a Claude Code without the mod (the
template is 243 and 242 lines today and a test allows fewer than 240: the section goes in a reference file the skill
points at, or the skill is cut elsewhere; not by raising the limit). It states: only on the person's explicit request,
never because a request is vague (the skill's description lets Codex choose it by itself, so the section must say "this
part only when asked"); how the five steps go; print the tool's text as it is; pass the person's line as it is; the
boundary of the work; the report. In Turkish for the person, English for the model, as in the mod.

## Not in this step

- A browser page for ticking (`verinoda ui` already serves a local page; an "İyileştir" tab would read the state file).
  Step 2, after the typed protocol has been used in a real session. It is a local HTTP server: loopback only and a random
  token, as the locate daemon does, and a school's shared machine makes that matter.
- MCP elicitation. Verinoda's question plan names `mcp_elicitation` as a kind of answer
  (`verinoda/schemas/question_plan.v1.json`) but nothing implements it, and whether Codex's MCP client supports it is not
  known here.
- Items nested under an outcome, single-choice groups, previews, a remembered "keep": the mod's later steps, same order.
- The other mod features (answer language, check after edits, commit review, a fresh index) are separate items.

## Files

- `verinoda/improve.py`: the pure state machine and the renderings; no I/O.
- `verinoda/cli.py`: `improve` with its four subcommands (`add(...)`, like the others).
- `verinoda/mcp/server.py`: the four tools in the full profile and in `GATEWAY_CATALOG`.
- `verinoda/agents/templates/*_SKILL.md` or a reference file: the section above.
- `tests/test_improve.py`: the cases of `claude-mods/verinoda-live/hooks/improve.test.ts` that are pure (a valid list, each
  invalid list, first sight, decisions, the selection prompt, a report, the grammar), plus the MCP tools and the CLI.
- `docs/DESIGN.md` (the next `D` number), `docs/UPGRADING.md`, and the row 13.10 of `docs/BACKLOG.md` cut down to what is
  left (the root `AGENTS.md` rule).

## Done when

A real `codex` session in a terminal: the list appears as text and is the tool's, not the model's rewrite; the person's
line is recorded as typed; the agent changes only what was chosen and reports it with `improve_report`; nothing changed
before the choice. Measure and write down: turns spent, and how many times the model altered the list or skipped a call.

## Unknowns to report back, not to guess

- Which Codex version, and whether its hooks run and may deny (`PreToolUse`) in it. The person has not given the version.
- Whether Codex prints an MCP tool's result to the person, or only gives it to the model (the design assumes the agent
  must print it, and says so; if Codex shows the result itself, step 2 of the flow gets simpler).
- Whether each MCP call asks the person for approval in Codex (friction for four calls per list).
- Whether the model keeps the list verbatim and passes the reply unchanged, over a long session. Not measured for any agent.
- Whether `$verinoda improve` is picked up as the person's explicit request and the skill is not chosen by Codex on a vague
  request.
- Whether the Codex sandbox lets the MCP server start with the project's `.codex/config.toml` (Codex reads it only for
  trusted projects, `verinoda/agents/installer.py`).
