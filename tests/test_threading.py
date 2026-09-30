from email_tracker.threading_ids import MAX_HOPS, compute_thread_ids


def e(i, irt="", refs=()):
    return {"id": i, "messageId": f"<{i}>", "inReplyTo": f"<{irt}>" if irt else "",
            "references": [f"<{r}>" for r in refs]}


def test_in_reply_to_chain():
    roots = compute_thread_ids([e("c", "b"), e("b", "a"), e("a")])
    assert roots == {"a": "a", "b": "a", "c": "a"}


def test_references_fallback_when_in_reply_to_missing_or_outside():
    roots = compute_thread_ids([e("a"), e("b", refs=["a"]), e("c", "nowhere", refs=["a", "b"]),
                                e("d", refs=["zzz"])])
    assert roots["b"] == "a"
    assert roots["c"] == "a"      # nearest resolvable reference is b, whose root is a
    assert roots["d"] == "d"


def test_missing_parent_is_its_own_root():
    assert compute_thread_ids([e("x", "gone")]) == {"x": "x"}


def test_cycle_terminates():
    roots = compute_thread_ids([e("a", "b"), e("b", "a")])
    assert set(roots) == {"a", "b"}   # both resolved; the walk stopped at the repeat


def test_hop_cap():
    chain = [e("m0")] + [e(f"m{i}", f"m{i-1}") for i in range(1, MAX_HOPS + 10)]
    roots = compute_thread_ids(reversed(chain))
    assert roots[f"m{MAX_HOPS + 9}"] != "m0"   # capped, like v1
    assert roots["m5"] == "m0"


def test_persisted_after_import(loaded):
    ids = {e["id"]: e.get("threadId") for e in loaded.list_emails()}
    assert ids["r1@x"] == "root@x"
    assert ids["r2@x"] == "root@x"
    assert ids["orphan@x"] == "orphan@x"
    assert all(ids.values())


def test_delete_root_rethreads(loaded):
    loaded.delete_email("root@x")
    ids = {e["id"]: e["threadId"] for e in loaded.list_emails()}
    assert ids["r1@x"] == "r1@x"
    assert ids["r2@x"] == "r1@x"   # r2's references still reach r1
