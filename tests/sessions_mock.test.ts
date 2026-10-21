// Unit tests for session-level flows driven by mock_runner canned streams (PLAN.md §5 lines 97-102 core parts; network integration is separate). No real ssh here.
import { test } from "node:test";
import * as a from "node:assert";

import * as sess from "../src/core/sessions"; // Session ctor + editGuarded flow are exported for exactly these mock-driven tests (§5 line 95)
import * as cm from "../src/core/commands";
import { MockRunner } from "../src/core/mock_runner"; // test double feeding canned byte streams (PLAN.md §2 core/ tree)

const TOK = "aabbccdd"; const TERM = (rc: number) => `\x01E${TOK}\x01rc=${rc}\n`; // framed terminator per session token (§2 line 49: one random token at spawn — fixed here for canned streams)
function mkSession(name: string): sess.Session { return new sess.Session(name, { host: "h", port: 2, user: "u" }, TOK); }

test("view + checksum roundtrip via mock framing", async () => { // §3 line 76 flow: windowed read then sha256 second send cached per path for the edit guard
  const s = mkSession("t1"); const m = new MockRunner([["one\ntwo\n" + TERM(0)], ["ab".repeat(32) + " /f\n" + TERM(0)]], undefined, undefined, 0); // chunks include terminator so framing pops exactly one result per send
  s.attach(m); const r1 = await s.send(cm.buildView("/f")); a.ok(r1.text === "one\ntwo\n" && r1.rc === 0, JSON.stringify(r1)); // payload before terminator only (framing.ts)
  const r2 = await s.send(cm.buildChecksum("/f")); const h = cm.parseChecksum(r2.text); a.ok(h !== null && h.length === 64, "sha256 parsed for edit guard cache (§3 line 76 / §4)"); });

test("timeout path returns partial output + error shape", async () => { // §5 lines 98-100: no sentinel within timeout -> failure/timeout with partial output (§2 line 60); hard kill marks session dead for auto-reconnect (§2 shortcut line 65)
  const s = mkSession("t2"); const m = new MockRunner([["partial-out"]]); // deliberately NO terminator chunk
  s.attach(m); const r = await s.send("sleepy", 1_500); a.ok(r.timedOut === true && r.text === "partial-out" && r.rc === null, JSON.stringify(r)); a.ok(s.dead, "session marked dead -> auto-reconnect next call (§4 line 89)");
  let threw = false; try { await s.send("again", 1_500); } catch (e) { threw = true; } a.ok(threw, "send on dead session throws; ensureLive reconnects instead of writing to a corpse (§4 lines 89-91)"); });

test("connLost when the process exits mid-flight", async () => { // auth/connection death surfaces as structured error shape with ssh-client stderr kept separate (framing.ts / sessions attach wiring)
  const m = new MockRunner([], ["Permission denied, please try again.\n"], 1); // exitAfterWrites=1: died after first send, no output
  const s = mkSession("t3"); s.attach(m); const r = await s.send("printf ok", 5_000); a.ok(r.connLost === true && r.rc === null, JSON.stringify(r)); });

test("edit guard mismatch returns changed-since-read and does NOT write back", async () => { // §5 line 101 + §3 line 78: checksum-mismatch guard returns "file changed since read" and writes nothing
  const s = mkSession("t4"); const shaA = "ab".repeat(32); const shaB = "cd".repeat(32); // realistic hex digests for parseChecksum regex ([0-9a-f]{40,128})
  const m = new MockRunner([[shaA + " /f\n" + TERM(0)], ["line1\nline2\n" + TERM(0)], [shaB + " /f\n" + TERM(0)]]); // chk1, cat, chk2 only — deliberately NO create-heredoc canned entry
  s.attach(m); const r = await sess.editGuarded(s, "/f", "line1", "X"); a.ok(!r.ok && /file changed between read/.test(r.message), r.message); a.strictEqual(m.writeCount(), 3); // only chk1+cat+chk2 sent: guard returned BEFORE heredoc write-back (§3 line 78)
});

test("capability probe parses name=path lines + derives hasRg (repo issues #1/#2)", async () => { // connect probe now sends buildCaps once; parse shared via setCapsFromText so ssh_capabilities refresh reuses same code path
  const s = mkSession("t6"); const m = new MockRunner([["rg=/usr/bin/rg\ngrep=/bin/grep\nawk=/bin/awk\n" + TERM(0)]]); s.attach(m); const r = await s.send(cm.buildCaps()); a.ok(r.rc === 0 && r.text.includes("rg="), JSON.stringify(r)); sess.setCapsFromText(s, r.text); // live probe path feeds same helper
  a.ok(s.hasRg && s.caps.has("grep") && !s.caps.has("sha256sum"), "hasRg derived from caps map; absent binaries simply missing (issue #1 mark-not-available surface)"); });

test("edit success path writes full file back", async () => { // §3 lines 78-79 happy path: read + applyEdit locally + rewrite whole file via createHeredoc (§4 edit-guard semantics)
  const s = mkSession("t5"); const shaA = "ab".repeat(32);
  const m = new MockRunner([[shaA + " /f\n" + TERM(0)], ["foo bar\n" + TERM(0)], [shaA + " /f\n" + TERM(0)], [TERM(0)]]); // chk1, cat, matching chk2, create rc=0
  s.attach(m); const r = await sess.editGuarded(s, "/f", "foo bar", "baz qux"); a.ok(r.ok && r.message.includes("updated /f"), r.message); a.strictEqual(m.writeCount(), 4); // 4th send is the heredoc rewrite ✓
});

test("§9 stat tier: tuple guard rejects mid-call race without write-back (3 sends)", async () => { const s = mkSession("t7"); sess.setCapsFromText(s, "stat=/bin/stat\n"); // engine stays grep; stat enables O(1) guard+preflight tier
  const m = new MockRunner([["10 1760953600\n" + TERM(0)], ["line1\nline2\n" + TERM(0)], ["999 1760953601\n" + TERM(0)]]); // stat, cat, post-stat tuple differs (size+mtime changed)
  s.attach(m); const r = await sess.editGuarded(s, "/f", "line1", "X"); a.ok(!r.ok && /file changed between read/.test(r.message), r.message); a.strictEqual(m.writeCount(), 3); }); // no heredoc send after race detection ✓ atomicity+guard both hold

test("§9 size preflight refuses huge file before any cat (1 send when stat probed)", async () => { const s = mkSession("t8"); sess.setCapsFromText(s, "stat=/bin/stat\n"); const m = new MockRunner([["5000 1760953600\n" + TERM(0)]]);
  s.attach(m); const r = await sess.editGuarded(s, "/f", "x", "y", false, 4_096); a.ok(!r.ok && /too large/.test(r.message), r.message); a.strictEqual(m.writeCount(), 1); }); // preflight fires on first stat send, full read never shipped
