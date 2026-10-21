// Opt-in integration test (PLAN.md §5 line 102): runs only with SSH_IT_HOST/PORT/USER env set (+SSH_IT_PASSWORD for the accepted password-fallback deviation); skips silently otherwise. connect -> scratch tree roundtrip via view/create/edit/grep/glob -> cleanup + disconnect. Run: node --test "dist/tests"
import { test } from "node:test";
import * as a from "node:assert";

import * as sess from "../src/core/sessions"; // drives the REAL spawn("ssh",...) path end-to-end (manual smoke §5 line 103 is opencode wiring; this covers core)
import * as cm from "../src/core/commands";

test("integration opt-in roundtrip (SSH_IT_HOST/PORT/USER)", async () => { const H = process.env.SSH_IT_HOST; const P = process.env.SSH_IT_PORT; const U = process.env.SSH_IT_USER; if (!H || !P || !U) return; // skip silently when unset (§5 line 102)
  const I = process.env.SSH_IT_IDENTITY; const PW = process.env.SSH_IT_PASSWORD; const nm = await sess.connect(H, Number(P), U, I, "ssh-it", PW); a.ok(nm === "ssh-it", "connect returns the session name (§3 ssh_connect row line 72)"); try { const l = await sess.ensureLive("ssh-it"); const s = l.session; // ensureLive returns {session, reconnected} per sessions.ts §4 line 89 recovery API
    let r = await s.send("cd /tmp; mkdir ssh_it_mcp 2>/dev/null || true", 15_000); a.ok(!r.connLost && !r.timedOut, "scratch dir setup (§5 line 102: cd/mkdir on the persistent shell)"); const f = "/tmp/ssh_it_mcp/f.txt";
    r = await sess.createHeredoc(s, f, "alpha\nbeta\ngamma\n"); a.ok(r.rc === 0, JSON.stringify(r)); // create roundtrip (§3 line 77 heredoc write)
    const ed = await sess.editGuarded(s, f, "beta", "BETA"); a.ok(ed.ok && /updated/.test(ed.message), ed.message); // edit guard + full-file rewrite-back on real FS (§3 lines 78-79)
    r = await s.send(cm.buildView(f, 2, 2)); a.ok(r.rc === 0 && r.text.includes("BETA") && r.text.includes("gamma"), JSON.stringify(r)); // view window shows edited content (§3 line 76 offset/limit)
    r = await s.send(cm.buildGrep("BETA", "/tmp/ssh_it_mcp", { engine: s.grepEngine })); a.ok(r.rc === 0 && r.text.length > 0, "grep found the match as file:line:text (§3 line 79 + §9 engine ladder)");
    r = await s.send(cm.buildGlob("**/*.txt", "/tmp/ssh_it_mcp")); a.ok(r.text.includes("f.txt"), "glob found the scratch file — basename approximation ok here (§3 line 80)");
    r = await s.send("rm -rf /tmp/ssh_it_mcp", 15_000); a.ok(!r.connLost, "cleanup + disconnect per §5 line 102"); const nm2 = sess.disconnect("ssh-it"); a.ok(nm2 === "ssh-it", "disconnect returns name + drops persisted spec (§3 line 73)"); } catch (e) { throw new Error(`integration failed: ${sess.errText(e)
}`); } });
