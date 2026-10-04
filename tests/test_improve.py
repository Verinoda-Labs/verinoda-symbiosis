"""The improvement checklist for an agent without a mod (verinoda/improve.py, docs/DESIGN.md D176).

The state machine is tested without a repository; the reply grammar the way a person types it; the file the list is kept
in; then the CLI (`verinoda improve`) and the MCP tools over a folder that has a `.verinoda`. The cases follow
claude-mods/verinoda-live/hooks/improve.test.ts, which tests the mod's version of the same rules."""

from __future__ import annotations

import json
import os

import pytest

from verinoda import cli, improve
from verinoda.improve import ImproveError
from verinoda.mcp.server import AtlasTools


def item(iid, group="improvement", **extra):
    return {"id": iid, "group": group, "title": f"title {iid}", "observation": f"obs {iid}", "why": f"why {iid}",
            "change": f"change {iid}", **extra}


# twelve items, ranked: problems with and without evidence, improvements, taste with and without a view
TWELVE = [item("i1", "problem", evidence=["a.py:1"]), item("i2", "problem"), item("i3"), item("i4", "taste"), item("i5"),
          item("i6", "problem", evidence=["b.py:9"]), item("i7", "taste", seen=True), item("i8"), item("i9", "problem"),
          item("i10", "taste"), item("i11"), item("i12", "problem")]


def listed(items=None, subject="src/a.py"):
    state, _ = improve.propose(improve.new_state(), TWELVE if items is None else items, subject)
    return state


def by_id(state, iid):
    return next(i for i in state["items"] if i["id"] == iid)


def number_of(state, iid):
    return next(n for n, i in improve.numbered(state) if i["id"] == iid)


def reply(state, line):
    return improve.decide(state, line)[0]


# ---- a proposed list -------------------------------------------------------------------------------------------------

def test_a_valid_list_is_stored_in_order_trimmed_cut_and_undecided():
    long = "x" * 200
    s = listed([item("i1", "problem", title=f"  {long}  ", observation="y" * 700, cost=7, evidence="not a list", seen="yes"),
                item("i2")], subject="  a file  ")
    assert s["phase"] == "choosing" and s["subject"] == "a file"
    assert [i["id"] for i in s["items"]] == ["i1", "i2"]
    first = s["items"][0]
    assert len(first["title"]) == 120 and first["title"].endswith("…") and len(first["observation"]) == 600
    assert first["cost"] == "" and first["evidence"] == [] and first["seen"] is False  # a wrong type is absent, not a refusal
    assert all(i["decision"] == "none" and i["outcome"] is None and i["sent_as"] is None for i in s["items"])
    assert improve.propose(improve.new_state(), [item("i1")], "", what="the parser")[0]["subject"] == "the parser"
    assert improve.propose(improve.new_state(), [item("i1")])[0]["subject"] == "bu konuşma"


@pytest.mark.parametrize("items,message", [
    (None, "1 to 30"), ([], "1 to 30"), ([item(f"i{n}") for n in range(31)], "1 to 30"),
    ([item("i1"), item("i1")], "item 2 repeats the id i1"), ([item("i 1")], "item 1 has an id"),
    ([item("u1")], r"item 1 \(u1\)"), ([item("i1", "bug")], r"item 1 \(i1\) has a group"),
    ([item("i1", "problem", title="  ")], r"item 1 \(i1\) has an empty title"), (["text"], "item 1 is not an object"),
])
def test_each_invalid_list_is_refused_naming_the_item(items, message):
    with pytest.raises(ImproveError, match=message + r".*nothing was shown$"):
        improve.propose(improve.new_state(), items, "s")


def test_a_new_list_replaces_the_old_keeps_unsent_own_items_and_says_what_it_replaced():
    s = reply(listed(), "3u")
    s = reply(s, "+ mine")
    new, replaced = improve.propose(s, [item("n1"), item("n2")], "other")
    assert replaced == (12, 1)
    assert [i["id"] for i in new["items"]] == ["n1", "n2", "u1"]
    assert improve.propose_text(new, replaced).count("The earlier list (12 items, 1 decisions) was replaced.") == 1
    assert improve.propose(improve.new_state(), [item("a")])[1] is None
    sent = improve.send(reply(listed(), "1u"))
    with pytest.raises(ImproveError, match="a selection is being applied"):
        improve.propose(sent, [item("z")])


# ---- first sight -----------------------------------------------------------------------------------------------------

def test_first_sight_shows_seven_and_each_group_folds_what_is_not_drawn():
    s = listed()
    visible, hidden = improve.sight_of(s)
    assert visible == {"i1", "i2", "i3", "i4", "i5", "i6", "i7"}
    assert hidden == {"problem": 2, "improvement": 2, "taste": 1}   # i8, i11 / i9, i12 / i10
    s = reply(reply(s, "more improvement"), "more problem")
    assert {"i8", "i11", "i9", "i12"} <= improve.sight_of(s)[0]
    text = improve.render(listed())
    assert "2 madde daha: `more improvement`" in text and "title i8" not in text and "title i3" in text
    # a decided, a verified and an unfolded item are drawn even when they rank low
    s = listed()
    by_id(s, "i12")["decision"] = "apply"
    by_id(s, "i11")["verified"] = True
    assert {"i12", "i11"} <= improve.sight_of(s)[0]


def test_numbers_do_not_depend_on_what_is_folded_and_follow_the_drawing():
    s = listed()
    nums = {i["id"]: n for n, i in improve.numbered(s)}
    assert [nums[x] for x in ("i1", "i2", "i6", "i9", "i12")] == [1, 2, 3, 4, 5]      # the problems first, by rank
    assert nums["i3"] == 6 and nums["i4"] == 10                                         # then improvements, then taste
    before = number_of(s, "i4")
    assert number_of(reply(s, "more improvement"), "i4") == before


# ---- the reply grammar -----------------------------------------------------------------------------------------------

def test_the_reply_sets_and_clears_and_says_the_same_thing_twice():
    s = listed()
    n1, n3 = number_of(s, "i1"), number_of(s, "i3")
    s = reply(s, f"{n1}u {n3}k")
    assert (by_id(s, "i1")["decision"], by_id(s, "i3")["decision"]) == ("apply", "keep")
    s = reply(s, f"{n1}u")                       # the same again: still apply (a typed reply sets, a button toggles)
    assert by_id(s, "i1")["decision"] == "apply"
    s = reply(s, f"{n1}0 {n3}0")
    assert by_id(s, "i1")["decision"] == "none" and by_id(s, "i3")["decision"] == "none"
    assert improve.counts(reply(listed(), "1u 2c 6k")) == {"items": 12, "apply": 1, "check": 1, "keep": 1}


def test_check_first_is_only_for_an_unverified_problem_and_a_bad_line_records_nothing():
    s = listed()
    with pytest.raises(ImproveError, match="only for a possible problem"):
        improve.decide(s, f"{number_of(s, 'i3')}c")
    with pytest.raises(ImproveError, match="`zz` is not understood; nothing was recorded"):
        improve.decide(s, "1u zz")
    assert by_id(s, "i1")["decision"] == "none"                      # the line is all or none
    with pytest.raises(ImproveError, match="no item 99"):
        improve.decide(s, "99u")
    folded = number_of(s, "i8")
    with pytest.raises(ImproveError, match="folded; say `more improvement`"):
        improve.decide(s, f"{folded}u")
    assert by_id(reply(s, f"more improvement {folded}u"), "i8")["decision"] == "apply"


def test_own_items_are_added_applied_removed_never_renumbered_by_id_and_capped_at_ten():
    s = reply(listed([item("i1")]), "+ rename the flag")
    own = by_id(s, "u1")
    assert own["decision"] == "apply" and own["title"] == "rename the flag" and improve.counts(s)["apply"] == 1
    n = number_of(s, "u1")
    s = reply(s, f"{n}x")
    assert not [i for i in s["items"] if i["group"] == "own"]
    s = reply(s, "+ second")
    assert by_id(s, "u2")                                           # u2, not u1 again
    with pytest.raises(ImproveError, match="only an item of your own can be removed"):
        improve.decide(s, "1x")
    for k in range(9):
        s = reply(s, f"+ item {k}")
    with pytest.raises(ImproveError, match="at most 10 items of your own"):
        improve.decide(s, "+ one too many")
    with pytest.raises(ImproveError, match="needs the text"):
        improve.decide(listed(), "+")
    assert reply(listed(), "1u + text after a decision")["items"][-1]["title"] == "text after a decision"


def test_details_are_asked_for_with_a_question_mark_and_cost_a_state_change_of_nothing():
    s = listed([item("i1", "problem", cost="risk", evidence=["a.py:1"]), item("i2", "problem")])
    new, acts = improve.decide(s, "1? 2?")
    assert new == s and acts["show"] == [1, 2]
    text = improve.decide_text(new, acts)
    assert "Gözlem: obs i1" in text and "Bedel: risk" in text and "Kanıt: a.py:1" in text and "Kanıt verilmedi" in text


def test_send_needs_a_chosen_item_and_makes_the_work_order_from_what_was_chosen_only():
    s = listed()
    with pytest.raises(ImproveError, match="nothing to send"):
        improve.decide(s, "gönder")
    with pytest.raises(ImproveError, match="keep \\(`k`\\) alone sends nothing"):
        improve.decide(s, "1k gönder")
    s, acts = improve.decide(s, "6u 1c 2k gönder + my own")   # a `+` takes the rest of the line, so `gönder` comes first
    order = acts["work_order"]
    assert order.startswith("My decisions on the improvement list (src/a.py):")
    assert "Apply these:\n- [i3] title i3: change i3\n- [u1] my own (my own item)" in order
    assert "Check these first (investigate only; change nothing for them):\n- [i1] title i1" in order
    assert "Keep these as they are (do not change them, also not as a side effect):\n- [i2] title i2" in order
    assert "[i4]" not in order and "[i5]" not in order                    # undecided: never named
    assert s["phase"] == "sent" and waiting_ids(s) == ["i1", "i3", "u1"]
    assert "Work on exactly this and nothing else" in improve.decide_text(s, acts)
    with pytest.raises(ImproveError, match="a selection is being applied; only `show`, `ask` and `stop` work now"):
        improve.decide(s, "2u")
    with pytest.raises(ImproveError, match="already sent"):
        improve.decide(s, "gönder")
    assert "…" in improve.render(s) and "bekleniyor" in improve.render(s)
    assert improve.selection_prompt(s).count("[i3]") == 0                 # an item already sent is not named again


def waiting_ids(state):
    return improve.waiting_ids(state)


# ---- after the send: the report ---------------------------------------------------------------------------------------

def sent_state():
    s = listed()
    s, _ = improve.decide(s, "6u 2u 1c gönder")
    return s


def test_a_report_lands_each_status_and_a_confirmed_problem_goes_back_into_the_list():
    s = sent_state()
    new, answer = improve.report(s, [{"id": "i3", "status": "applied", "note": "done", "evidence": ["a.py:3", 7, ""]},
                                     {"id": "i1", "status": "confirmed", "note": "it is real", "change": "fix the loop",
                                      "evidence": ["c.py:4"]}],
                                 ["touched d.py", 3, "", "and e.py"])
    assert answer == "Recorded: 2 outcomes. Still waiting for: i2."
    assert by_id(new, "i3")["outcome"] == {"status": "applied", "note": "done", "evidence": ["a.py:3"]}
    one = by_id(new, "i1")
    assert one["verified"] and one["checked"] == "it is real" and one["change"] == "fix the loop" and one["outcome"] is None
    assert one["decision"] == "none" and one["sent_as"] is None and one["evidence"] == ["a.py:1", "c.py:4"]
    assert new["extra"] == ["touched d.py", "and e.py"] and new["phase"] == "sent"
    rest, answer = improve.report(new, [{"id": "i2", "status": "failed", "note": "could not"}])
    assert answer == "Recorded: 1 outcomes." and rest["phase"] == "choosing"
    text = improve.render(rest)
    assert "✓ Uygulandı · title i3" in text and "✗ Uygulanamadı · title i2" in text and "(doğrulandı)" in text
    assert "Listede olmayan değişiklikler" in text and "· touched d.py" in text


@pytest.mark.parametrize("outcomes,message", [
    ([], "at least one item; nothing was recorded"),
    ([{"id": "i3", "status": "applied", "note": "x"}] * 2, "item i3 is reported twice"),
    ([{"id": "i7", "status": "applied", "note": "x"}], "no item i7 is waiting for an outcome"),
    ([{"id": "i3", "status": "done", "note": "x"}], "item i3 was sent to apply; its outcome is one of applied, partial, failed"),
    ([{"id": "i3", "status": "confirmed", "note": "x"}], "item i3 was sent to apply"),
    ([{"id": "i1", "status": "applied", "note": "x"}], "item i1 was sent to check; its outcome is one of confirmed, not_confirmed"),
    ([{"id": "i3", "status": "applied", "note": "  "}], "item i3 needs a note the user can read"),
])
def test_a_bad_report_records_nothing_and_says_which_outcome(outcomes, message):
    s = sent_state()
    with pytest.raises(ImproveError, match=message):
        improve.report(s, outcomes)
    final, _ = improve.report(s, [{"id": "i3", "status": "applied", "note": "ok"}])
    with pytest.raises(ImproveError, match="no item i3 is waiting"):          # a final item accepts no second report
        improve.report(final, [{"id": "i3", "status": "applied", "note": "again"}])


def test_stop_and_ask_get_the_person_out_of_a_model_that_never_reports():
    s = sent_state()
    stopped, _ = improve.decide(s, "stop")
    assert stopped["phase"] == "choosing" and "? Sonuç bildirilmedi · title i3" in improve.render(stopped)
    assert "ask" in improve.render(stopped)
    asked, acts = improve.decide(stopped, "ask")
    assert asked["phase"] == "sent" and acts["report_prompt"].startswith("Report the outcome of the items I sent")
    assert "(i1, i2, i3)" in improve.decide_text(asked, acts)
    with pytest.raises(ImproveError, match="no item is waiting"):
        improve.decide(listed(), "ask")
    new, _ = improve.report(stopped, [{"id": "i3", "status": "applied", "note": "late"}])  # a late report is accepted
    assert by_id(new, "i3")["outcome"]["status"] == "applied"


def test_reset_and_an_idle_state():
    assert improve.decide(listed(), "reset")[0] == improve.new_state()
    with pytest.raises(ImproveError, match="there is no list"):
        improve.decide(improve.new_state(), "1u")
    assert improve.render(improve.new_state()).startswith("Liste yok.")


# ---- the file --------------------------------------------------------------------------------------------------------

def test_the_list_is_kept_per_session_atomically_and_old_lists_are_removed(tmp_path):
    (tmp_path / ".verinoda").mkdir()
    s = listed()
    improve.save(tmp_path, "mcp-1", s)
    improve.save(tmp_path, "a b/../c", s)                                  # a name that is not a file name is made one
    assert improve.load(tmp_path, "mcp-1") == s
    assert improve.state_path(tmp_path, "a b/../c").name == "a_b____c.json"
    assert improve.load(tmp_path, "other") == improve.new_state()          # another session sees nothing
    assert improve.session_key(None) == "default" and len(improve.session_key("x" * 100)) == 40
    old = improve.state_path(tmp_path, "old")
    old.write_text("{}", encoding="utf-8")
    long_ago = old.stat().st_mtime - 3 * 24 * 3600
    os.utime(old, (long_ago, long_ago))
    improve.save(tmp_path, "mcp-1", s)
    assert not old.exists() and improve.state_path(tmp_path, "mcp-1").exists()
    improve.state_path(tmp_path, "bad").write_text("not json", encoding="utf-8")
    assert improve.load(tmp_path, "bad") == improve.new_state()            # a file this build did not write is not read
    assert not list((tmp_path / ".verinoda" / "improve").glob(".improve-*"))


# ---- the CLI ---------------------------------------------------------------------------------------------------------

@pytest.fixture
def proj(tmp_path):
    (tmp_path / ".verinoda").mkdir()
    return tmp_path


def run(capsys, *argv):
    code = cli.main(["improve", *argv])
    out = capsys.readouterr()
    return code, out.out, out.err


def test_the_cli_goes_from_a_proposal_to_a_report_through_a_file(proj, tmp_path, capsys):
    f = tmp_path / "items.json"
    f.write_text(json.dumps({"subject": "src/p.py", "items": TWELVE}), encoding="utf-8")
    code, out, _ = run(capsys, "propose", "--file", str(f), "--repo", str(proj), "--session", "s1")
    assert code == 0 and "The list is stored: 12 items" in out and "İyileştirme: src/p.py" in out
    code, out, _ = run(capsys, "decide", "6u", "1c", "--repo", str(proj), "--session", "s1")
    assert code == 0 and "[✓] title i3" in out and "[?] title i1" in out
    code, out, _ = run(capsys, "show", "--repo", str(proj), "--session", "s1")
    assert code == 0 and "2 uygula" not in out and "1 uygula · 1 kontrol" in out
    code, out, _ = run(capsys, "decide", "gönder", "--repo", str(proj), "--session", "s1", "--json")
    res = json.loads(out)
    assert code == 0 and res["phase"] == "sent" and res["session"] == "s1" and "My decisions on the improvement list" in res["text"]
    r = tmp_path / "report.json"
    r.write_text(json.dumps({"outcomes": [{"id": "i3", "status": "applied", "note": "done"},
                                          {"id": "i1", "status": "not_confirmed", "note": "nothing found"}],
                             "extra_changes": ["touched x"]}), encoding="utf-8")
    code, out, _ = run(capsys, "report", "--file", str(r), "--repo", str(proj), "--session", "s1")
    assert code == 0 and out.startswith("Recorded: 2 outcomes.") and "○ İncelendi: sorun doğrulanmadı" in out
    # another session of the same project has no list
    assert "Liste yok." in run(capsys, "show", "--repo", str(proj), "--session", "s2")[1]


def test_the_cli_refuses_with_the_reason_and_exit_code_2_and_needs_a_scanned_project(proj, tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("VERINODA_SESSION", raising=False)
    code, out, err = run(capsys, "decide", "1u", "--repo", str(proj))
    assert code == 2 and out == "" and "there is no list" in err
    f = tmp_path / "bad.json"
    f.write_text("[]", encoding="utf-8")
    code, _, err = run(capsys, "propose", "--file", str(f), "--repo", str(proj))
    assert code == 2 and "1 to 30" in err
    bare = tmp_path / "bare"
    bare.mkdir()
    with pytest.raises(SystemExit, match="has no .verinoda yet"):
        cli.main(["improve", "show", "--repo", str(bare)])
    monkeypatch.setenv("VERINODA_SESSION", "from-env")
    f.write_text(json.dumps([item("i1")]), encoding="utf-8")
    assert run(capsys, "propose", "--file", str(f), "--subject", "x", "--repo", str(proj))[0] == 0
    assert (proj / ".verinoda" / "improve" / "from-env.json").exists()


# ---- the MCP tools ---------------------------------------------------------------------------------------------------

def test_the_mcp_tools_keep_one_list_per_server_process_and_answer_structured_errors(proj):
    t = AtlasTools(proj)
    res = t.improve_propose("src/a.py", TWELVE)
    assert "error" not in res and "The list is stored: 12 items" in res["text"] and "Show the list above to the user" in res["text"]
    assert (proj / ".verinoda" / "improve" / f"mcp-{os.getpid()}.json").exists()
    res = t.improve_decide("6u 1c gönder")
    assert "Work on exactly this and nothing else" in res["text"]
    bad = t.improve_decide("2u")
    assert bad["error"] == "invalid_argument" and "a selection is being applied" in bad["message"] and bad["tool"] == "improve_decide"
    res = t.improve_report([{"id": "i3", "status": "applied", "note": "done"}], ["touched x"])
    assert res["text"].startswith("Recorded: 1 outcomes. Still waiting for: i1.")
    shown = t.improve_show()
    assert "✓ Uygulandı · title i3" in shown["text"] and "· touched x" in shown["text"]
    assert t.improve_report([], None)["error"] == "invalid_argument"


def test_an_unscanned_folder_gets_the_usual_not_initialised_answer_and_no_state(tmp_path):
    t = AtlasTools(tmp_path)
    for res in (t.improve_propose("s", [item("i1")]), t.improve_decide("1u"), t.improve_show(), t.improve_report([], None)):
        assert res["error"] == "not_initialised" and "index_update" in res["hint"]
    assert not (tmp_path / ".verinoda").exists()
