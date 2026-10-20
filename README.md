# ssh-mcp — persistent SSH sessions for coding agents

MCP server (stdio) keeping one long-lived local-OpenSSH process per session; tools behave like their local equivalents on the remote machine: `ssh_exec`, `ssh_view`, `ssh_create`, `ssh_edit`, `ssh_grep`, `ssh_glob` + lifecycle (`ssh_connect`, `ssh_disconnect`, `ssh_list_sessions`), bootstrap (`ssh_setup_key`) and capability probe (`ssh_capabilities`). Zero re-auth after first connect — stateful shell (cd/env) persists across calls. See PLAN.md for the settled design; comments in every file cite it by line.

## Target use

Built for coding agents doing file operations from a **Windows client against Unix file servers** — the motivating case being project files under a Samba/CIFS network drive whose SMB mount is slow or flaky (UNC paths, stale caches, long round-trips). ssh-mcp bypasses SMB entirely: one persistent SSH session per server means `view/create/edit/grep/glob/exec` run at native speed with POSIX paths and state (`cd`, env) persisting across every agent call — no remount or drive letter involved.

## Warning & disclaimer — use entirely at your own risk

- `ssh_exec` runs **arbitrary commands on the real server** with no undo, rollback, or confirmation layer between agent and filesystem; a bad agent command can overwrite/delete what it likes. Verify targets (`ssh_view`, dry-run `ls`) before destructive ops.
- Multi-session mixups edit the wrong host: every result echoes `[session=...]` — always pass `session_name` when more than one session is alive, and re-check which server you're on before writes.
- The `password=` fallback keeps plaintext credentials in a local persisted spec while sessions run; require explicit consent and rotate passwords on production file servers (details under Honest limits).
- MIT licensed: the software is provided "as is"; **all damages, costs or losses from using it are fully on the user, not the author** — see `LICENSE` for the exact terms.

## Build & run

```
pnpm install                      # needs pnpm + recent Node (developed/tested on v24)
pnpm build          # tsc -> dist/
node --test "dist/tests/*.test.js"   # unit tests (no network); integration auto-skips without SSH_IT_* env
```

Prerequisites: the local machine must have an OpenSSH `ssh` binary on PATH (Windows OpenSSH client verified working); remote hosts need POSIX shells (`bash`/`sh`) — Windows-remote is unsupported by design.

### Wire into opencode / Claude Desktop (stdio MCP)

Build once first (`pnpm build`), then point the harness at the compiled entrypoint using **absolute paths** — MCP servers are launched with an arbitrary cwd and a different PATH, so relative/PATH-resolved commands break. Get the absolute node path with `node -e "console.log(process.execPath)"`.

opencode (`opencode.json`) — `<REPO>` = this repo's absolute root:

```json
{ "mcp": { "ssh-jmcp": { "type": "local", "command": ["<ABS node.exe>", "<REPO>/dist/src/server/index.js"] } } }
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "ssh-jmcp": { "command": "<ABS node.exe>", "args": ["<REPO>/dist/src/server/index.js"] } } }
```

## Usage flow

1. Password host? `ssh_setup_key(host, port, user, password)` — one-time bootstrap; later connects use the generated key automatically (no password in any later call or persisted spec). If that account can't write `~/.ssh/authorized_keys` (infra perms), fall back to `ssh_connect ... password=` instead — see deviation note below. On servers where `.ssh` is **permanently read-only** (file-server setups like ours), skip bootstrap entirely: it can never succeed, use `password=` directly every connect.
2. `ssh_connect(host, port, user[, identity, name, password])` → session name (`user@host` default); idempotent for an alive name.
3. Then exec/view/create/edit/grep/glob freely — pass `session_name` whenever more than one session is alive (every result starts with `[session=...]`).

Remote paths are POSIX: use `/`, never `\` (builders reject backslashes with that hint); relative paths resolve against the session's current remote cwd.

## Integration test on a real host

```bash
export SSH_IT_HOST=<host> SSH_IT_PORT=22 SSH_IT_USER=<user>   # + optional SSH_IT_IDENTITY or SSH_IT_PASSWORD (accepted fallback, see limits)
pnpm test                                                     # connect -> scratch tree roundtrip -> cleanup + disconnect
# PowerShell: $env:SSH_IT_HOST="<host>"; $env:SSH_IT_PORT="22"; ... — the vars are plain env, any shell works.
```

Runs only when those env vars are set; skips silently otherwise. The test touches **only** `/tmp/ssh_it_mcp*` on the target (create/edit/read/cleanup of that scratch dir) — require explicit user consent before pointing it at a non-test host.

## Honest limits (PLAN.md §6, surfaced in tool descriptions too)

- No interactive remote programs — anything reading stdin (`vim`, REPLs, nested ssh) desyncs the session pipe; use non-interactive invocations (`sed -i`, batch flags).
- Hard command timeout kills the whole session process (`shortcut:` upgrade = per-command subshell backgrounding); remote orphan children of killed sessions may linger. Remote reconnects with a `[session reconnected — shell state lost]` warning.
- stdout+stderr combined (not separated streams); `find` glob is basename approximation; rg/grep dialect fallback verified on GNU-class hosts only — BSD/busybox flag drift documented, not exhaustively solved. Modern grep form skips `.svn`/`.git` dirs (`--exclude-dir`, matching rg's default hidden-dir skip) for file-server tree speed; portable retry form omits those flags.
- `ssh_edit` rewrites whole files via heredoc (`shortcut:` upgrade = remote patch for >2 MB files); sha256 guard covers within-call races (and stale-view detection where the checksum tool exists).
- Windows *local* client is fine (argv spawn, no PTY); CRLF content from a Windows agent stays CRLF on the remote file.
- `ssh_setup_key` uses SSH_ASKPASS_REQUIRE=force — OpenSSH builds lacking it can't use this flow; the structured error tells you to add the printed `.pub` manually. Askpass path **verified working on Windows OpenSSH** (2026-10-20 LAN test host: password auth reached remote, `stty` stderr noise harmless); pubkey *append* success depends on the account's `~/.ssh` perms — where it is permanently read-only, bootstrap can never succeed; use the `password=` fallback rather than retrying. Bootstrap only creates/extends (`mkdir -p`, `chmod 700 ~/.ssh`, pubkey append) — it never overwrites or deletes remote files.
- Accepted deviation (user request 2026-10-20): `ssh_connect password=` runtime fallback for hosts where authorized_keys can't be written — BatchMode is omitted and the password is fed via a temp askpass script + `SSH_ASKPASS_REQUIRE=force` with no tty. Plaintext password lives in that session's persisted spec + a temp askpass script while the session runs (deleted on process exit; orphaned if the server itself is SIGKILLed). Enable only with explicit user consent outside test hosts; prefer keys wherever possible; rotate any test-host password when done.
- Session specs persist at `{homedir}/.config/ssh-mcp/sessions.json`, shared by *any* running ssh-mcp server: two harnesses both holding servers for the same target race on reconnect (last connect wins) — keep one instance per host/user pair.
