# ssh-mcp — Build Plan

MCP server that keeps persistent SSH sessions open and gives coding agents local-tool-equivalent access to a remote machine: `ssh_exec`, `ssh_view`, `ssh_create`, `ssh_edit`, `ssh_grep`, `ssh_glob`. All traffic goes through the **local OpenSSH client** (`ssh` binary), one long-lived process per session — no re-auth per call.

Hand this whole file to any coding agent. Decisions below are settled; do not redesign, only implement.

## 1. Stack

- TypeScript + `@modelcontextprotocol/sdk` (stdio transport). Pin version in package.json; before coding, confirm current registration API (`registerTool` vs `tool()`) against official docs / Context7 — the SDK has changed signatures over time.
- Zod for input schemas (SDK ships/pairs with it). No other runtime deps: Node built-ins (`child_process.spawn`, fs) only. **Do not use ssh2/js-based SSH libs** — requirement is local OpenSSH client.
- pnpm, Node ≥ 20, `src/` + `tests/`. Build a single stdio MCP server; entrypoint just wires transport to the session/file layer (transport-independent core, so Streamable HTTP can be added later without touching it).

## 2. Architecture

```
core/
  sessions.ts     # SessionRegistry: name -> live ssh process + framing engine
  framing.ts      # parse sentinel-delimited stdout/stderr/exitcode from a byte stream
  commands.ts     # pure builders: exec / view / create / edit / grep / glob command text
  mock_runner.ts  # test double for sessions (feeds canned streams) — used by unit tests
server/
  index.ts        # MCP server, registers tools, maps tool args -> core calls
```

### Persistent session = one long-lived ssh process

`ssh_connect(host, port, user, identity?, name?)` spawns:

```ts
spawn("ssh", [
  "-o", "BatchMode=yes",                 // never prompt; fail fast if auth broken (password-fallback sessions omit this flag — §8)
  "-o", "ConnectTimeout=10",
  ...(identity ? ["-i", identity] : []),
  // ssh stops option parsing at first non-option arg: ALL flags before destination.
  "-p", String(port),
  `${user}@${host}`,
  // remote side: plain bash reading commands from stdin. NO -t / no PTY needed;
  // bash executes each command as it arrives on the still-open pipe, keeping cd/env state.
  "bash --no-interactive-login"           // fallback chain in impl: try `bash`, then `sh`
])
```

Commands are written to child stdin as text; output is read from stdout/stderr pipes with a **sentinel framing protocol** (below). One process per session ⇒ stateful shell (`cd`, env, background procs) persists across tool calls for free, and file tools ride the same authenticated connection. Performance requirement met: zero re-auth after first connect.

Registry in-memory `Map<string, Session>`; also persisted as JSON of *target specs* (name → host/port/user/identity) under `{userData}/ssh-mcp/sessions.json` so a fresh server process can transparently reconnect a named session (with a warning that shell state was lost). This satisfies "agent finds the same session after context reset while MCP server keeps running" — in-process map already covers it; disk persistence only covers full server restarts.

### Framing protocol (the one piece to get right)

Per session generate one random token `TOK` (hex) at spawn. Each command sent to stdin is exactly:

```sh
{ cmd; } 2>&1 ; __rc=$? ; printf '\001E%s\001rc=%d\n' "$TOK" "$__rc"
```

Parser (`framing.ts`): accumulate bytes from stdout; scan for `\x01E<TOK>\x01rc=(\d+)\n`; everything before it is the command's output, remove token on buffer. Stderr of *ssh itself* (auth errors etc.) goes to child stderr — surface as structured error. `printf` with `%s` avoids quoting issues; user cmd is sent verbatim as a line(s) — bash reads raw text from stdin so arbitrary quotes/heredocs in the command are fine (they're not going through a local shell). Multi-line commands allowed: send all lines then sentinel line, and only match on the framed terminator.

Edge cases parser must handle (and tests cover):
- token bytes split across chunk boundaries → keep unflushable tail
- user output containing `\001E<TOK>` — impossible in practice; `shortcut:` hex token 24-bit collision negligible, upgrade to per-command nonce if ever paranoid
- rc extraction: never trust absence of sentinel ⇒ treat "no sentinel within timeout" as failure/timeout error with partial output
- consecutive back-to-back sends (agent fires tools fast): buffer may hold two sentinels — parser must pop results one-per-command in FIFO order, keeping later commands' payloads intact

### Timeouts & caps (all tools)

- default exec timeout 30s (`timeout_ms` arg), on expiry write a `kill -0`-free approach: send `\x18`(^X)? No — can't interrupt bash reliably. `shortcut:` kill the whole session process on hard timeout and mark session dead + auto-reconnect; upgrade path = per-command subshell backgrounding if needed later.
- output cap 64 KB, return head+tail with `[truncated N bytes]` marker (agents page via grep/view offsets).

## 3. Tool surface (schemas concise — zod)

| tool | args | impl on session's shell |
|---|---|---|
| `ssh_connect` | host(ip), port, user, identity?, name? → returns session_name | spawn process; probe remote shell once (`printf ok`) and record detected interpreter bash/sh for command dialects below |
| `ssh_disconnect` | name? (default last) | kill child, drop from registry + sessions.json |
| `ssh_list_sessions` | — | dump registry incl. liveness check (`kill -0 $remote_pid`? simpler: track local process alive flag) |
| `ssh_exec` | session_name?, command, timeout_ms? (default last session) | send verbatim; return `{stdout+stderr combined, rc}` |
| `ssh_view` | path, offset?(1-based line), limit?(lines) | **window remotely**, never full-file cat: no-offset → head 2000 lines via `awk 'NR<=2000'`; with offset/limit → `sed -n '<start>,<end>p'`. Number lines locally like the local Read tool. Also fetch `sha256sum <path>` as a second send right after and cache it per path for the edit guard (§4). Missing file / empty window → rc + "file not found" style msg |
| `ssh_create` | path, content | write via heredoc with unique delimiter: `cat > 'p' <<'__MK_<TOK>__'\n...\n__MK_<TOK>__\n`; refuse if content contains the delim line (regenerate token) |
| `ssh_edit` | path, old_string, new_string, replace_all? | view → apply exact-match replacement **locally** (same semantics as local Edit tool: fail on not-found / multiple matches w/o replace_all) → rewrite whole file via create-heredoc. Before write-back re-check `sha256sum` still equals the cached one; mismatch ⇒ remote file changed since read → structured error telling agent to re-view (`shortcut:` full-file rewrite; upgrade = remote patch for >2 MB files). |
| `ssh_grep` | pattern, path?, glob?(include), context?, max_results? | prefer `rg` if probe (`command -v rg`) succeeded at connect: `rg -n --json` else fallback `grep -rnH --include=...`; **rc=1 from grep/rg means "no matches", not an error** — map to empty result set; cap results server-side; return file:line:match like local Grep |
| `ssh_glob` | pattern, path?(remote dir), limit? | `find <dir> \( -name '<pat>' \) -print 2>/dev/null | head -n <limit>` — translate simple glob (`**/*.ts` → `-name '*.ts'` + prune note); document limitation in tool description: basename-style matching only, upgrade = remote python one-liner for full glob semantics |

Notes:
- `ssh_edit`/`ssh_view` path safety: paths are on the **remote** FS — no local-fs guard needed; still quote all interpolated paths with single-quote escaping (`'p'\''q'`) in every command builder. Central helper `shq()` in commands.ts, unit-tested.
- Remote paths are POSIX regardless of where the agent runs: tool descriptions say "use / not \\"; builders reject any path containing a backslash with that hint (backslashes on Windows-local agents come from local tools and would otherwise silently become literal `\` chars remote-side). Relative paths resolve against the session's current remote cwd — usually desirable after `ssh_exec cd`.
- grep/glob output goes through same framing as exec; parse line-oriented.

## 4. Session lifecycle details

- Dead-session recovery: before any tool call, if process exited (nonzero or closed), attempt reconnect from persisted spec once; prepend warning `[session reconnected — shell state lost]` to result. If reconnect fails → structured error telling agent to `ssh_connect`.
- Multiple concurrent sessions per target allowed (different names); commands within one session are serialized by design (single pipe) — document that parallel tool calls on the same session just queue, which is correct bash behavior.
- `ssh_connect` with a name that already exists and is alive → return the existing session idempotently (agents retry safely). If dead → reconnect from spec.
- Wrong-host hazard: "default last session" can silently target the wrong machine when 2+ sessions are alive. Mitigate cheaply: every result starts with a `[session=compiler_ssh]` header line so agents see which host answered; tool description tells agents to pass `session_name` explicitly whenever more than one session exists.
- Auth: key-based at runtime (`BatchMode=yes`), plus one-time bootstrap tool `ssh_setup_key(host, port, user, password)`: generates/reuses local `id_ed25519(.pub)` under `{userData}/ssh-mcp/`, makes a single throwaway ssh connection with the password (spawn ssh WITHOUT BatchMode; feed password via an askpass helper script + SSH_ASKPASS env since no tty is available — verify behavior on both POSIX and Windows OpenSSH at implementation time), then appends the pubkey to remote `~/.ssh/authorized_keys` (`mkdir -p ~/.ssh; chmod 700 .ssh; cat >> ...`, set perms best-effort) and kills that process. Subsequent `ssh_connect` uses `-i <that key>` by default → fast, no password in any later call or persisted session spec (2026-10-20 exception: accepted runtime fallback, see §8). If bootstrap fails (passwordless login disabled), return structured error pointing at the identity-file path so the user can add it manually.

## 5. Tests (small but real — framing is non-trivial logic)

1. **Unit, no network** against `mock_runner.ts` + canned byte streams:
   - sentinel split across chunks; output containing `%`, quotes, CRLF, NUL-ish noise → correct payload/rc extraction
   - timeout path returns partial output + error shape
   - `shq()` round-trips `'a' "b" $(x) \`y\`` into a command that echoes it identically (run through local bash on POSIX; skip on win32 with env guard — the *remote* dialect is what matters, mock runner uses canned outputs cross-platform)
   - edit semantics: not-found error, ambiguous-match error, replace_all happy path (pure local function — trivial to test); checksum-mismatch guard returns "file changed since read" and does NOT write back
2. **Integration, opt-in** via `SSH_IT_HOST/PORT/USER` env vars (skip silently if unset): connect → `cd /tmp; mkdir ssh_it` → view/create/edit/grep/glob roundtrip on a scratch file tree → cleanup + disconnect. Run with `node --test tests/integration.test.ts`.
3. Manual smoke: wire into opencode (`opencode.json`: `"mcp": {"ssh-jmcp": {"type":"local","command":["pnpm","dist:ssh-mcp"]}}` or stdio shim) and drive one connect/exec/view cycle from the agent.

## 6. Known risks / honest limits (surface in README + tool descriptions)

- Windows local client works — we spawn `ssh` with argv directly (no cmd.exe), no PTY, so ControlMaster's absence on OpenSSH-for-Windows is irrelevant to this design.
- Combined stdout+stderr (not separated per stream); agents and shell semantics tolerate it; upgrade = remote temp-file capture if ever needed.
- Hard timeout kills the session process (`shortcut:` above). Remote orphan children of killed sessions may linger — acceptable, document.
- `find` glob is basename approximation; rg fallback grep slower on huge trees (cap results).
- **No interactive remote programs**: anything that reads stdin from the pipe (`vim`, nested `ssh`, a REPL) swallows subsequent framed command lines → session desyncs, then framing breaks. Tool description must warn agents: use non-interactive invocations only (`sed -i` for edits, batch flags everywhere).
- Remote dialect drift beyond bash/sh (BSD grep lacks `--include`/`-H`, busybox `find` lacks some flags): probe at connect like rg-probe; on missing flag fall back to portable forms. Documented, not exhaustively solved.

## 7. Deliverables checklist for implementing agent

1. repo scaffold: package.json (pinned SDK), tsconfig, pnpm layout
2. core/ modules per §2–3 with framing + shq exactly as specced
3. server/index.ts registering the 9 tools (incl. `ssh_setup_key`); stdio transport only
4. tests per §5 green (`node --test`)
5. README: usage, opencode/Claude wiring snippet, limits list

## 8. Accepted deviations (post-spec, user-requested — keep code and spec aligned)

- **2026-10-20 runtime password fallback** (`ssh_connect` optional `password=`): for hosts where key bootstrap is impossible because the account can't write `~/.ssh/authorized_keys` (test host: `.ssh` symlink → infra-owned dir). Mechanism: omit `-o BatchMode=yes`, feed password via a per-session temp askpass script + `SSH_ASKPASS_REQUIRE=force` (no tty; verified on Windows OpenSSH 2026-10-20). Plaintext password persists in that session's spec until disconnect and lives in the temp script during process lifetime (unlinked on child exit; orphaned only if the server itself is SIGKILLed). §4 lines 31/93 "keys-only at runtime" applies to the default path only; prefer keys wherever possible, rotate test-host passwords when done.
