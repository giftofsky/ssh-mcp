# Testing record

Raw pass/fail history so consumers/agents can see what is verified and where to re-verify. Full suite = unit tests + opt-in integration; run command: `node --test "dist/tests/*.test.js"` after `pnpm build`.

## Environment of recorded runs

- Local client: Windows, OpenSSH_for_Windows_9.5p1 (LibreSSL 3.8.2), Node v24.18.0
- Remote test host: LAN GNU-class file server (password-auth account; `.ssh` symlink to infra-owned dir — key bootstrap refused there, password fallback used)

## Results log

| Date | Suite | Result | Notes |
|------|-------|--------|-------|
| 2026-10-20 pre-capability commit | unit + live integration | **18 pass / 0 fail** (integration ~731 ms) | password fallback connect; full roundtrip create/edit-guard/view/grep/glob/cleanup on `/tmp/ssh_it_mcp` |
| 2026-10-20 capability tool added | unit only | **20 pass / 0 fail** (incl. new caps-parse + builder tests) | live integration could NOT re-run this session: LAN host offline at that moment (plain ssh/ping timed out); capability output on real server pending when infra back |

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
