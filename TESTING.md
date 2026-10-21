# Testing record

Raw pass/fail history so consumers/agents can see what is verified and where to re-verify. Full suite = unit tests + opt-in integration; run command: `node --test "dist/tests/*.test.js"` after `pnpm build`.

## Environment of recorded runs

- Local client: Windows, OpenSSH_for_Windows_9.5p1 (LibreSSL 3.8.2), Node v24.18.0
- Remote test host: LAN GNU-class file server (password-auth account; `.ssh` symlink to infra-owned dir — key bootstrap refused there, password fallback used)

## Results log

| Date | Suite | Result | Notes |
|------|-------|--------|-------|
| 2026-10-20 pre-capability commit | unit + live integration | **18 pass / 0 fail** (integration ~731 ms) | password fallback connect; full roundtrip create/edit-guard/view/grep/glob/cleanup on `/tmp/ssh_it_mcp` |
| 2026-10-21 §9 impl (grep ladder, atomic tmp+mv write-back, stat-tuple guard + size preflight) | unit + live integration | **unit 23 pass / 0 fail; live roundtrip PASS (~994 ms)** on LAN GNU-class host — exercised real stat-guard path and atomic create/edit via tmp+mv; patch/sed tiers still pending |

### Live capability snapshot — LAN file server tsteoh@192.168.82.18 (2026-10-21, refresh=true)

```
shell=bash  engine=grep (no rg/ag/ugrep on box)
present: grep /bin/grep | sed /bin/sed | patch /usr/bin/patch | diff /usr/bin/diff
         stat /usr/bin/stat | wc /usr/bin/wc | find /usr/bin/find | awk /usr/bin/awk
absent : rg ag ugrep (+ sha256sum/shasum not in display list — checksum floor chain used)
```

Implication: §9 patch tier (patch+diff present ✓) and sed micro-edit tier would be *available* on this box if implemented; grep runs GNU form with VCS-dir skip today.

## Unit test names (current suite, all passing)

framing: sentinel split across chunk boundaries keeps unflushable tail; payload noise %s quotes CRLF tabs survive verbatim; back-to-back sentinels FIFO one-per-command; no terminator => null + partial grows for timeout shape
commands: shq escapes single quotes 'p'\''q'; shq POSIX round-trip (skipped on win32); path builders reject Windows backslashes with hint; view window arithmetic + head-window form; create heredoc delimiter collision detection; glob basename translation + limit default; grep rg/grep/portable flag variants (+ --exclude-dir VCS-skip tweak); applyEdit local Edit-tool semantics
sessions_mock: view+checksum roundtrip via mock framing; timeout path returns partial output + error shape; connLost when process exits mid-flight; edit guard mismatch does NOT write back; capability probe parses name=path lines + derives hasRg (issues #1/#2); edit success writes full file back
integration (opt-in, SSH_IT_HOST/PORT/USER [+SSH_IT_PASSWORD]): connect → scratch tree roundtrip → cleanup + disconnect — touches ONLY `/tmp/ssh_it_mcp*` on target; require explicit consent before running against non-test hosts

## Reproduce

```
pnpm build && pnpm test                                   # unit (network-free)
# live (consent first): export SSH_IT_HOST=... SSH_IT_PORT=22 SSH_IT_USER=... [SSH_IT_PASSWORD=...] then node --test "dist/tests/*.test.js"
```
