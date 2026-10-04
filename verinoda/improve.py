"""The improvement checklist for an agent without a mod (docs/DESIGN.md D176).

A vague request ("make this better") becomes a short ranked list the person can recognise their wish in: the agent looks and
changes nothing, the list is shown, the person marks what to apply, keep or check first, and only then does the agent work
on what was chosen. The Claude Code mod draws this as a pane (``claude-mods/verinoda-live/hooks/improve.ts``, the same
rules and the same messages); an agent with no mod (Codex in a terminal) gets it as text: the list is rendered here, the
person answers in one line, and that line is parsed here, by code, not by the model's reading of it.

The rules that decide every open question, unchanged from the mod: nothing changes without the person's decision;
nothing is selected at the start (an item without a decision is "not decided": never rejected, never sent); a suspicion is
not a fact (a problem shows its evidence or says it has none, a matter of taste says it is a guess); the first sight is
short (seven items, the rest folded by group); the boundary of the work is what the person chose.

Nothing here prints or reads a file but :func:`load` and :func:`save`; the state is a plain dict that round-trips JSON.
"""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from verinoda.paths import atlas_dir

GROUPS = ("problem", "improvement", "taste")
SHOWN_FIRST = 7           # the best-ranked items a group shows before it is unfolded
OWN_MAX = 10              # items of the person's own in one list
ITEMS_MAX = 30
TITLE_MAX = 120
TEXT_MAX = 600
EVIDENCE_MAX = 6
EVIDENCE_LINE_MAX = 160
SUBJECT_MAX = 80
OWN_TEXT_MAX = 300
EXTRA_MAX = 20
EXTRA_LINE_MAX = 300
SUBJECT_FALLBACK = "bu konuşma"
STALE_SECONDS = 2 * 24 * 3600   # a list nobody touched for two days is a session that is over

_ID = re.compile(r"^[A-Za-z0-9_-]{1,16}$")
_OWN_ID = re.compile(r"^u\d+$")
_KEY = re.compile(r"[^A-Za-z0-9_-]")

STATUSES = ("applied", "partial", "failed", "confirmed", "not_confirmed")
_FITS = {"apply": ("applied", "partial", "failed"), "check": ("confirmed", "not_confirmed")}

GROUP_LABEL = {"problem": "Olası sorunlar", "improvement": "İşlevsel iyileştirmeler", "taste": "Estetik seçenekler",
               "own": "Sizin eklediğiniz"}
MARK = {"none": "[ ]", "apply": "[✓]", "keep": "[–]", "check": "[?]"}
RESULT_LABEL = {"applied": "✓ Uygulandı", "partial": "◐ Kısmen uygulandı", "failed": "✗ Uygulanamadı",
                "not_confirmed": "○ İncelendi: sorun doğrulanmadı", "unreported": "? Sonuç bildirilmedi"}

GRAMMAR = ("Yanıt: numara + harf. u uygula · k kalsın · c önce kontrol et · 0 temizle · n? ayrıntı · "
           "+ metin kendi maddenizi ekler (satır sonuna kadar: gönder önce yazılır) · more <grup> katlanmışı açar · gönder")


class ImproveError(ValueError):
    """A refusal that names what is wrong; the message is the answer, and nothing was stored."""


# ---- the state ---------------------------------------------------------------------------------------------------

def new_state() -> dict[str, Any]:
    return {"phase": "idle", "subject": "", "items": [], "unfolded": [], "extra": [], "own_seq": 0, "note": ""}


def cut(value: str, limit: int) -> str:
    """Trimmed; a cut text ends in an ellipsis that counts toward the limit."""
    t = value.strip()
    return t if len(t) <= limit else t[:max(0, limit - 1)].rstrip() + "…"


def _is_text(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _evidence(v: Any) -> list[str]:
    """An optional list of strings: another type is absent, a non-string or empty entry is dropped."""
    if not isinstance(v, list):
        return []
    return [cut(x, EVIDENCE_LINE_MAX) for x in v if _is_text(x)][:EVIDENCE_MAX]


def in_list(i: dict) -> bool:
    return i["outcome"] is None or i["outcome"]["status"] == "waiting"


def is_sendable(i: dict) -> bool:
    return i["decision"] in ("apply", "check") and i["outcome"] is None


def list_of(s: dict) -> list[dict]:
    return [i for i in s["items"] if in_list(i)]


def results_of(s: dict) -> list[dict]:
    return [i for i in s["items"] if not in_list(i)]


def waiting_ids(s: dict) -> list[str]:
    return [i["id"] for i in s["items"] if i["outcome"] and i["outcome"]["status"] == "waiting"]


def has_unreported(s: dict) -> bool:
    return any(i["outcome"] and i["outcome"]["status"] == "unreported" for i in s["items"])


def counts(s: dict) -> dict[str, int]:
    lst = list_of(s)
    return {"items": len(lst),
            "apply": sum(1 for i in lst if is_sendable(i) and i["decision"] == "apply"),
            "check": sum(1 for i in lst if is_sendable(i) and i["decision"] == "check"),
            "keep": sum(1 for i in lst if i["decision"] == "keep")}


def numbered(s: dict) -> list[tuple[int, dict]]:
    """The list's items with the numbers the person types: the model's by group and rank, then their own in the order
    added. The numbers do not depend on what is folded, so a number stays the same from one drawing to the next."""
    lst = list_of(s)
    ordered = [i for g in GROUPS for i in lst if i["group"] == g] + [i for i in lst if i["group"] == "own"]
    return list(enumerate(ordered, 1))


def sight_of(s: dict) -> tuple[set[str], dict[str, int]]:
    """The ids drawn at first sight and, per group, how many are folded: the seven best-ranked of the model's items in the
    list, and besides them any item with a decision, any verified one and any group unfolded whole."""
    model = [i for i in list_of(s) if i["group"] != "own"]
    visible = {i["id"] for rank, i in enumerate(model)
               if rank < SHOWN_FIRST or i["decision"] != "none" or i["verified"] or i["group"] in s["unfolded"]}
    hidden = {g: sum(1 for i in model if i["group"] == g and i["id"] not in visible) for g in GROUPS}
    return visible, hidden


# ---- a proposed list ---------------------------------------------------------------------------------------------

def propose(s: dict, items: Any, subject: Any = "", what: str = "") -> tuple[dict, tuple[int, int] | None]:
    """What the model's ``improve_propose`` does: validate and store; the first failure is the answer and nothing is stored.
    Returns the new state and, when the list it replaced held decisions, (the model's items it had, how many were decided)."""
    if s["phase"] == "sent":
        raise ImproveError("verinoda improve: a selection is being applied; report its outcomes with improve_report "
                           "before proposing a new list")

    def refuse(why: str):
        raise ImproveError(f"verinoda improve: {why}; nothing was shown")

    if not isinstance(items, list) or not 1 <= len(items) <= ITEMS_MAX:
        refuse(f"items must be a list of 1 to {ITEMS_MAX} items")
    seen: set[str] = set()
    new: list[dict] = []
    for n, entry in enumerate(items, 1):
        at = f"item {n}"
        if not isinstance(entry, dict):
            refuse(f"{at} is not an object")
        iid = entry.get("id")
        if not isinstance(iid, str) or not _ID.match(iid):
            refuse(f"{at} has an id that is not 1 to 16 letters, digits, - or _")
        if _OWN_ID.match(iid):
            refuse(f"{at} ({iid}) has an id of the form u and digits, kept for the person's own items")
        if iid in seen:
            refuse(f"{at} repeats the id {iid}")
        seen.add(iid)
        group = entry.get("group")
        if group not in GROUPS:
            refuse(f"{at} ({iid}) has a group that is not problem, improvement or taste")
        for field in ("title", "observation", "why", "change"):
            if not _is_text(entry.get(field)):
                refuse(f"{at} ({iid}) has an empty {field}")
        new.append({"id": iid, "group": group, "title": cut(entry["title"], TITLE_MAX),
                    "observation": cut(entry["observation"], TEXT_MAX), "why": cut(entry["why"], TEXT_MAX),
                    "change": cut(entry["change"], TEXT_MAX),
                    "cost": cut(entry["cost"], TEXT_MAX) if _is_text(entry.get("cost")) else "",
                    "evidence": _evidence(entry.get("evidence")), "seen": entry.get("seen") is True,
                    "verified": False, "checked": "", "decision": "none", "sent_as": None, "outcome": None})
    old = [i for i in s["items"] if i["group"] != "own"]
    decided = sum(1 for i in old if i["decision"] != "none")
    sub = cut(subject, SUBJECT_MAX) if _is_text(subject) else cut(what, SUBJECT_MAX) if what.strip() else SUBJECT_FALLBACK
    # the person's own items that were not sent stay: they wrote them, a new list from the model does not take them back
    own = [i for i in s["items"] if i["group"] == "own" and i["outcome"] is None and i["sent_as"] is None]
    out = {**s, "phase": "choosing", "subject": sub, "items": new + own, "unfolded": [], "extra": [], "note": ""}
    return out, ((len(old), decided) if decided else None)


# ---- decisions ---------------------------------------------------------------------------------------------------

def _find(s: dict, number: int) -> dict:
    for n, i in numbered(s):
        if n == number:
            return i
    raise ImproveError(f"verinoda improve: there is no item {number} in the list")


def set_decision(item: dict, decision: str) -> None:
    """``u`` apply, ``k`` keep, ``c`` check first, ``0`` clear. The typed reply sets, it does not toggle: a reply said twice
    must mean the same thing twice (the pane's button toggles, a button is pressed once at a time)."""
    if item["group"] == "own":
        if decision in ("keep", "check"):
            raise ImproveError("verinoda improve: an item of your own can only be applied (remove it with `<n>x`)")
        return  # an own item is always to apply; 0 on it changes nothing
    if decision == "check" and (item["group"] != "problem" or item["verified"]):
        raise ImproveError(f"verinoda improve: `c` (check first) is only for a possible problem that no check has "
                           f"confirmed; item {item['id']} is not one")
    item["decision"] = decision


def add_own(s: dict, text: str) -> None:
    t = cut(text, OWN_TEXT_MAX)
    if t == "":
        raise ImproveError("verinoda improve: `+` needs the text of the item")
    if sum(1 for i in list_of(s) if i["group"] == "own") >= OWN_MAX:
        raise ImproveError(f"verinoda improve: at most {OWN_MAX} items of your own")
    k = s["own_seq"] + 1
    s["own_seq"] = k
    s["items"].append({"id": f"u{k}", "group": "own", "title": t, "observation": "", "why": "", "change": "", "cost": "",
                       "evidence": [], "seen": False, "verified": False, "checked": "", "decision": "apply",
                       "sent_as": None, "outcome": None})


_TOKEN = re.compile(r"^(\d+)([ukc0x?])$", re.IGNORECASE)
_LETTER = {"u": "apply", "k": "keep", "c": "check", "0": "none"}


def decide(s: dict, line: str) -> tuple[dict, dict[str, Any]]:
    """The person's reply line, parsed. All of it or none: a token that is not understood refuses the line and says the
    grammar. Returns the new state and ``{"show": [item numbers asked about], "send": bool, "stop": bool, "ask": bool}``."""
    if s["phase"] == "idle":
        raise ImproveError("verinoda improve: there is no list; the agent proposes one with improve_propose")
    out = copy.deepcopy(s)
    acts: dict[str, Any] = {"show": [], "send": False, "stop": False, "ask": False}
    text = line.strip()
    own_text = None
    m = re.search(r"(?:^|\s)\+\s*(.*)$", text, re.DOTALL)
    if m:                                   # everything after a `+` is the item's text
        own_text = m.group(1)
        text = text[:m.start()].strip()
    tokens = text.split()
    sent = out["phase"] == "sent"
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        low = tok.lower()
        i += 1
        if low in ("gönder", "gonder", "send"):
            acts["send"] = True
        elif low == "stop":
            acts["stop"] = True
        elif low == "ask":
            acts["ask"] = True
        elif low == "reset":
            out = new_state()
            sent = False
        elif low == "show":
            continue                         # the answer is the drawing
        elif low == "more":
            grp = tokens[i].lower() if i < len(tokens) else ""
            i += 1
            if grp not in GROUPS:
                raise ImproveError(f"verinoda improve: `more` is followed by problem, improvement or taste. {GRAMMAR}")
            if grp not in out["unfolded"]:
                out["unfolded"].append(grp)
        else:
            t = _TOKEN.match(tok)
            if not t:
                raise ImproveError(f"verinoda improve: `{tok}` is not understood; nothing was recorded. {GRAMMAR}")
            number, letter = int(t.group(1)), t.group(2).lower()
            item = _find(out, number)
            if letter == "?":
                acts["show"].append(number)
            elif sent:
                raise ImproveError("verinoda improve: a selection is being applied; only `show`, `ask` and `stop` work now")
            elif letter == "x":
                if item["group"] != "own":
                    raise ImproveError(f"verinoda improve: `{tok}`: only an item of your own can be removed")
                out["items"] = [x for x in out["items"] if x["id"] != item["id"]]
            else:
                if item["group"] != "own" and item["id"] not in sight_of(out)[0]:
                    raise ImproveError(f"verinoda improve: item {number} is folded; say `more {item['group']}` first")
                set_decision(item, _LETTER[letter])
    if own_text is not None:
        if sent:
            raise ImproveError("verinoda improve: a selection is being applied; no item can be added now")
        add_own(out, own_text)
    if acts["send"] and sent:
        raise ImproveError("verinoda improve: the selection was already sent")
    if acts["send"] and not any(is_sendable(x) for x in out["items"]):
        raise ImproveError("verinoda improve: nothing to send: mark at least one item to apply (`u`) or to check (`c`); "
                           "keep (`k`) alone sends nothing")
    if acts["send"]:
        prompt = selection_prompt(out)
        out = send(out)
        acts["work_order"] = prompt
    if acts["stop"]:
        out = stop_waiting(out)
    if acts["ask"]:
        if not has_unreported(out) and not waiting_ids(out):
            raise ImproveError("verinoda improve: no item is waiting for an outcome")
        acts["report_prompt"] = report_prompt([x["id"] for x in out["items"]
                                               if x["outcome"] and x["outcome"]["status"] in ("waiting", "unreported")])
        out = ask_report(out)
    return out, acts


# ---- the flow ----------------------------------------------------------------------------------------------------

def send(s: dict) -> dict:
    """Marks the sendable items as sent; their decision, and so their mark, stays."""
    out = copy.deepcopy(s)
    out["phase"], out["note"] = "sent", ""
    for i in out["items"]:
        if is_sendable(i):
            i["sent_as"] = "check" if i["decision"] == "check" else "apply"
            i["outcome"] = {"status": "waiting", "note": "", "evidence": []}
    return out


def _unreport(i: dict) -> None:
    if i["outcome"] and i["outcome"]["status"] == "waiting":
        i["outcome"] = {"status": "unreported", "note": "", "evidence": []}


def stop_waiting(s: dict) -> dict:
    out = copy.deepcopy(s)
    out["phase"], out["note"] = "choosing", ""
    for i in out["items"]:
        _unreport(i)
    return out


def ask_report(s: dict) -> dict:
    out = copy.deepcopy(s)
    out["phase"], out["note"] = "sent", ""
    for i in out["items"]:
        if i["outcome"] and i["outcome"]["status"] == "unreported":
            i["outcome"] = {"status": "waiting", "note": "", "evidence": []}
    return out


def report(s: dict, outcomes: Any, extra_changes: Any = None) -> tuple[dict, str]:
    """What the model's ``improve_report`` does; a report with any invalid outcome records nothing and says which."""
    def refuse(why: str):
        raise ImproveError(f"verinoda improve: {why}")

    if not isinstance(outcomes, list) or not outcomes or not all(isinstance(o, dict) for o in outcomes):
        refuse("outcomes must list at least one item; nothing was recorded")
    ids: set[str] = set()
    for o in outcomes:
        oid = str(o.get("id"))
        if oid in ids:
            refuse(f"item {oid} is reported twice")
        ids.add(oid)
    by_id = {i["id"]: i for i in s["items"]}
    for o in outcomes:
        oid = str(o.get("id"))
        item = by_id.get(oid)
        state = item["outcome"]["status"] if item and item["outcome"] else None
        if state not in ("waiting", "unreported"):
            refuse(f"no item {oid} is waiting for an outcome")
        sent_as = item["sent_as"] or "apply"
        if o.get("status") not in _FITS[sent_as]:
            refuse(f"item {oid} was sent to {sent_as}; its outcome is one of {', '.join(_FITS[sent_as])}")
        if not _is_text(o.get("note")):
            refuse(f"item {oid} needs a note the user can read")
    out = copy.deepcopy(s)
    for o in outcomes:
        item = next(i for i in out["items"] if i["id"] == str(o["id"]))
        note, evidence = cut(o["note"], TEXT_MAX), _evidence(o.get("evidence"))
        if o["status"] == "confirmed":
            # a confirmed problem is not an outcome: it goes back into the list, to be marked again, with what the check found
            item.update(verified=True, checked=note, outcome=None, decision="none", sent_as=None)
            if _is_text(o.get("change")):
                item["change"] = cut(o["change"], TEXT_MAX)
            item["evidence"] = (item["evidence"] + evidence)[:EVIDENCE_MAX]
        else:
            item["outcome"] = {"status": o["status"], "note": note, "evidence": evidence}
    if isinstance(extra_changes, list):
        out["extra"] = (out["extra"] + [cut(x, EXTRA_LINE_MAX) for x in extra_changes if _is_text(x)])[:EXTRA_MAX]
    waiting = waiting_ids(out)
    if not waiting and out["phase"] == "sent":
        out["phase"] = "choosing"
    tail = f" Still waiting for: {', '.join(waiting)}." if waiting else ""
    return out, f"Recorded: {len(outcomes)} outcomes.{tail}"


# ---- the prompts (what the agent reads) --------------------------------------------------------------------------

def selection_prompt(s: dict) -> str:
    """The work order: the person's decisions, from the sendable items and, under "Keep", the list's items marked keep.
    A section with no item is left out; an item that is not sendable (undecided, or already sent) is never named."""
    def line(i: dict, with_change: bool) -> str:
        if i["group"] == "own":
            return f"- [{i['id']}] {i['title']} (my own item)"
        return f"- [{i['id']}] {i['title']}" + (f": {i['change']}" if with_change else "")

    sendable = [i for i in s["items"] if is_sendable(i)]
    apply = [i for i in sendable if i["decision"] == "apply"]
    check = [i for i in sendable if i["decision"] == "check"]
    keep = [i for i in s["items"] if i["outcome"] is None and i["decision"] == "keep"]
    parts = [f"My decisions on the improvement list ({s['subject']}):"]
    if apply:
        parts += ["", "Apply these:", *[line(i, True) for i in apply]]
    if check:
        parts += ["", "Check these first (investigate only; change nothing for them):", *[line(i, False) for i in check]]
    if keep:
        parts += ["", "Keep these as they are (do not change them, also not as a side effect):",
                  *[line(i, False) for i in keep]]
    parts += ["", ("Everything else stays as it is. You may make the small auxiliary changes an item needs. If one would add "
                   "behaviour, change behaviour I did not choose, or cost something, tell me before you do it. When you are "
                   "done or cannot go on, call improve_report (`verinoda improve report` in a shell) with one outcome for "
                   "each item to apply or to check, and list under extra_changes any change that was not on the list.")]
    return "\n".join(parts)


def report_prompt(ids: list[str]) -> str:
    return (f"Report the outcome of the items I sent that you have not reported yet ({', '.join(ids)}) with improve_report. "
            "Change nothing else.")


PROPOSE_NOTE = ("[Verinoda] Show the list above to the user exactly as it is written (do not summarise, translate or "
                "reorder it), then stop: change nothing and wait for their reply line. Pass that line, unchanged, to "
                "improve_decide.")


# ---- the rendering (what the person reads: Turkish, like the pane) ------------------------------------------------

def counts_line(c: dict[str, int]) -> str:
    if not c["items"]:
        return ""
    parts = [f"{c['items']} madde", f"{c['apply']} uygula" if c["apply"] else "", f"{c['check']} kontrol" if c["check"] else "",
             f"{c['keep']} kalsın" if c["keep"] else ""]
    return " · ".join(p for p in parts if p)


def suffix_of(i: dict) -> str:
    if i["verified"]:
        return " (doğrulandı)"
    if i["group"] == "problem" and not i["evidence"]:
        return " (kanıtsız)"
    if i["group"] == "taste" and not i["seen"]:
        return " (tahmin)"
    return ""


def render_item(n: int, i: dict) -> str:
    """One item's details: what is there, why it may matter, the change, its cost, the evidence."""
    if i["group"] == "own":
        return f"{n} {i['title']} (sizin maddeniz)"
    lines = [f"{n} {i['title']}{suffix_of(i)}", f"    Gözlem: {i['observation']}", f"    Neden: {i['why']}",
             f"    Öneri: {i['change']}"]
    if i["cost"]:
        lines.append(f"    Bedel: {i['cost']}")
    if i["evidence"]:
        lines.append(f"    Kanıt: {', '.join(i['evidence'])}")
    elif i["group"] == "problem":
        lines.append("    Kanıt verilmedi")
    if i["verified"]:
        lines.append(f"    İnceleme: {i['checked']}")
    return "\n".join(lines)


def render(s: dict, *, details: list[int] | None = None) -> str:
    if s["phase"] == "idle":
        return "Liste yok. Ajan `improve_propose` ile bir liste önerir (`$verinoda improve [neye bakılsın]`)."
    out = [f"İyileştirme: {s['subject']}"]
    if s["phase"] == "choosing" and (cl := counts_line(counts(s))):
        out.append(cl)
    results = results_of(s)
    if results:
        out += ["", "Sonuçlar"]
        for i in results:
            out.append(f"  {RESULT_LABEL[i['outcome']['status']]} · {i['title']}")
            if i["outcome"]["note"]:
                out.append(f"      {i['outcome']['note']}")
            if i["outcome"]["evidence"]:
                out.append(f"      {', '.join(i['outcome']['evidence'])}")
    if s["extra"]:
        out += ["", "Listede olmayan değişiklikler", *[f"  · {x}" for x in s["extra"]]]
    visible, hidden = sight_of(s)
    nums = numbered(s)
    for g in (*GROUPS, "own"):
        rows = [(n, i) for n, i in nums if i["group"] == g and (g == "own" or i["id"] in visible)]
        folded = hidden.get(g, 0) if g != "own" else 0
        if not rows and not folded:
            continue
        out += ["", GROUP_LABEL[g]]
        for n, i in rows:
            label = f"{MARK[i['decision']]} {i['title']}{'' if g == 'own' else suffix_of(i)}"
            if i["outcome"] and i["outcome"]["status"] == "waiting":
                label += " … bekleniyor"
            out.append(f" {n} {label}")
        if folded and s["phase"] == "choosing":
            out.append(f" {folded} madde daha: `more {g}`")
    if details:
        out += [""]
        for n in details:
            out.append(render_item(n, _find(s, n)))
    out.append("")
    if s["phase"] == "sent":
        out += ["Seçimleriniz gönderildi; sonuçlar buraya gelecek. Beklemekten vazgeçmek: `stop`; sonucu istemek: `ask`."]
    else:
        sendable = counts(s)["apply"] + counts(s)["check"]
        out.append(GRAMMAR)
        if list_of(s):
            out.append(f"Göndermek için: `gönder` ({sendable} madde)." if sendable else "Göndermek için en az bir madde seçin.")
        if has_unreported(s):
            out.append("Bildirilmeyen sonuç var: `ask` ile ajandan istenir.")
    return "\n".join(out)


def propose_text(s: dict, replaced: tuple[int, int] | None) -> str:
    tail = f" The earlier list ({replaced[0]} items, {replaced[1]} decisions) was replaced." if replaced else ""
    n = sum(1 for i in s["items"] if i["group"] != "own")
    by = {g: sum(1 for i in s["items"] if i["group"] == g) for g in GROUPS}
    head = (f"The list is stored: {n} items ({by['problem']} possible problems, {by['improvement']} improvements, "
            f"{by['taste']} matters of taste).{tail}")
    return f"{head}\n\n{render(s)}\n\n{PROPOSE_NOTE}"


def decide_text(s: dict, acts: dict[str, Any]) -> str:
    """What the agent gets after a reply line: the drawing, and, when the line sent the selection, the work order."""
    if "work_order" in acts:
        return ("Seçimleriniz gönderildi. [Verinoda] The person sent their selection. Work on exactly this and nothing "
                f"else:\n\n{acts['work_order']}")
    if "report_prompt" in acts:
        return acts["report_prompt"]
    return render(s, details=acts["show"] or None)


# ---- persistence -------------------------------------------------------------------------------------------------

def session_key(key: str | None) -> str:
    """The name a list is kept under: one per agent session, so two sessions in one project never see each other's
    choices (the mod learned this the hard way: a choice kept in a file every session shared reached sessions that
    never asked for it)."""
    return _KEY.sub("_", key or "default")[:40] or "default"


def state_path(repo: Path, key: str | None) -> Path:
    return atlas_dir(repo) / "improve" / f"{session_key(key)}.json"


def load(repo: Path, key: str | None) -> dict[str, Any]:
    p = state_path(repo, key)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return new_state()
    if not isinstance(data, dict) or data.get("phase") not in ("idle", "choosing", "sent") or not isinstance(data.get("items"), list):
        return new_state()   # a file this build did not write is not read
    return {**new_state(), **data}


def save(repo: Path, key: str | None, state: dict[str, Any]) -> None:
    """Atomic (a crash leaves the old list), and lists nobody touched for two days are removed on the way."""
    p = state_path(repo, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".improve-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(state, fh, ensure_ascii=False)
        os.replace(tmp, p)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    now = time.time()
    for other in p.parent.glob("*.json"):
        try:
            if other != p and now - other.stat().st_mtime > STALE_SECONDS:
                other.unlink()
        except OSError:
            continue
