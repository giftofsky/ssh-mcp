// Unit tests for command builders + local edit semantics (PLAN.md §5 lines 99-101). No network; POSIX bash round-trip guarded by platform check (§100 env guard).
import { test } from "node:test"; import * as a from "node:assert"; import { spawnSync } from "node:child_process"; import * as os from "node:os";

import * as cm from "../src/core/commands"; // compiled dist/tests -> dist/src/core ✓ layout preserved (rootDir ".")

test("capability probe command is POSIX-loop and covers probed binaries (issues #1/#2 + §9 ladder set)", () => { const caps = cm.buildCaps(); a.ok(caps.startsWith("for b in rg ag ugrep grep sed patch diff stat wc find awk python3 sha256sum shasum openssl") && caps.includes("command -v $b"), "single framed send; setCapsFromText parses name=path lines (§9 extended probe list)"); });

test("shq escapes single quotes in the 'p'\\''q' form", () => { // PLAN.md line 83 exact escaping shape — hand-written expected values, no impl-derived ones
  a.strictEqual(cm.shq("plain"), "'plain'"); a.strictEqual(cm.shq("it's"), "'it'\\''s'"); const tricky = "a'b\"c $(x) `y` %s ; | &"; // backticks/quotes kept as data; only ' triggers the escape dance (PLAN.md line 84 central helper, unit-tested)
  a.strictEqual(cm.shq(tricky), "'a'\\''b\"c $(x) `y` %s ; | &'"); });

test("shq survives a real bash round-trip on POSIX (skipped on win32 per PLAN.md §100 env guard)", () => { if (os.platform() === "win32") return; // mock_runner's canned outputs cover the remote dialect cross-platform (§5 line 100)
  const s = "it's $(x) `y` %s ;|&<>"; const r = spawnSync("bash", ["-c", "printf %s " + cm.shq(s)]); a.strictEqual(r.status, 0, String(r.stderr ?? "")); a.strictEqual(String(r.stdout), s); });

test("path builders reject Windows backslashes with POSIX hint (PLAN.md §3 line 84)", () => { const rejView = (): void => { cm.buildView("C:\\tmp\\x"); }; const rejGlob = (): void => { cm.buildGlob("C:\\**", "."); }; a.throws(rejView, /must be a POSIX remote path/); a.throws(rejGlob, /must be a POSIX remote path/); });

test("view window arithmetic + head-window form (PLAN.md §3 line 76)", () => { const win = cm.buildView("/f", 10, 5); a.strictEqual(win, "awk 'NR>=10 && NR<15 {print} NR>=15{exit}' '/f'"); const head = cm.buildView("/a b/f"); a.ok(head.startsWith("awk 'NR<=2000' "), "head 2000-line window via awk, never full cat (§3 line 76)"); a.ok(head.endsWith("'/a b/f'"), "spaces in paths quoted via shq (line 84)"); });

test("create heredoc delimiter collision detection (PLAN.md §3 line 77)", () => { const tok = "deadbeef"; a.ok(cm.contentCollidesWithDelim("x\n__MK_deadbeef__\ny", tok), "content containing the delim line must force token regeneration (regenerate-token loop in createHeredoc)"); a.ok(!cm.contentCollidesWithDelim("__MK_deadbeefer extra", tok), "near-miss lines are fine"); });

test("glob basename translation + limit default (PLAN.md §3 line 80)", () => { const g = cm.buildGlob("**/*.ts", "/srv"); a.ok(g.startsWith("find '/srv'"), "dir quoted via shq (line 84)"); a.ok(g.includes("-name '*.ts'"), "** pruned to basename match (documented approximation, line 80)"); a.ok(g.endsWith("| head -n 500"), "default cap 500 (§3 line 80 limit?)"); });

test("grep engine ladder rg/ag/ugrep/GNU/portable forms (§3 line 79 + §6 drift + §9)", () => { const rg = cm.buildGrep("pat", "/d", { engine: "rg", includeGlob: "*.ts" }); a.ok(rg.startsWith("rg --no-heading -n") && rg.includes("--glob '*.ts'"), "line form matches local-Grep contract (file:line:text)");
  const ag = cm.buildGrep("pat", "/d", { engine: "ag", context: 2 }); a.ok(ag.startsWith("ag --nogroup -n") && ag.includes("-C 2"), "ag keeps file:line:text via --nogroup; glob omitted (shortcut documented in builder)");
  const ug = cm.buildGrep("pat", "/d", { engine: "ugrep", includeGlob: "*.ts" }); a.ok(ug.startsWith("ugrep -r -n") && ug.includes("--glob='*.ts'"), "ugrep tier form with --glob= include (§9 ladder)");
  const full = cm.buildGrep("pat", undefined, { includeGlob: "*.ts" }); a.ok(full.includes("-rnH") && full.includes("--include='*.ts'") && full.includes("--exclude-dir='.svn'"), "GNU grep default tier -rnH --include= + VCS-dir skip (§3 lines 79-80)"); const port = cm.buildGrep("pat", "/d", { engine: "grep", portable: true }); a.ok(!port.includes("-H") && !port.includes("--include") && !port.includes("--exclude"), "portable form drops GNU-only flags for BSD/busybox retry (§6 line 112)"); });

test("§9 stat tuple parse + wc size probe + atomic create write-back shape", () => { a.ok(cm.buildStat("/f").startsWith("stat -c '%s %Y'"), "GNU tuple form gated by caps.has(stat) in editGuarded"); const t = cm.parseStatTuple("  4291 1760953600 "); a.ok(t !== null && t[0] === 4291 && t[1] === 1760953600, "size+mtime epoch parsed for O(1) race guard"); const w = cm.buildSizeProbe("/f"); a.ok(w.startsWith("wc -c <"), "stdin-form size probe (no filename noise)"); const cr = cm.buildCreate("t9", "/x/f", "a\n"); a.ok(cr.includes(".t9.tmp") && cr.includes("mv -f"), "atomic tmp+rename write-back (§9): partial file never observable mid-write"); });


test("applyEdit local Edit-tool semantics (PLAN.md §3 lines 78-79)", () => { const nf = cm.applyEdit("abc", "zz", "y"); if (!nf.ok) a.ok(nf.error.includes("not found"), "not-found error (§5 line 101)"); else throw new Error("expected not-found rejection");
  const amb = cm.applyEdit("aXbXc", "X", "Y"); if (!amb.ok) a.ok(amb.error.includes("matches 2 times"), "ambiguous-match error without replace_all (§3 line 79)"); else throw new Error("expected ambiguous rejection");
  const all = cm.applyEdit("aXbXc", "X", "Y", true); if (all.ok) a.strictEqual(all.content, "aYbYc", "replace_all happy path (§5 line 101)"); else throw new Error("replace_all must succeed");
  const empty = cm.applyEdit("abc", "", "y"); if (!empty.ok) a.ok(empty.error.includes("empty old_string")); else throw new Error("empty old_string must be rejected"); });
