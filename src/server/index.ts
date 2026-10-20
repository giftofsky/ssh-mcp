// MCP stdio entrypoint (PLAN.md §2 server/ tree + §7 line 118): registers the tools, maps tool args -> core calls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"; // v1.32.1 pinned; registerTool is current API, tool() deprecated (§ lines 9-10 verified against dist typings)
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // stdio transport only (§7 line 118); core is transport-independent so Streamable HTTP can be added later without touching it (§1 line 11)
import { z } from "zod"; // zod v3 pairs with the pinned SDK (package.json pins exact versions per PLAN.md §1/§7 line 116)

import * as sess from "../core/sessions";
import * as cm from "../core/commands";

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] }); // §5 test3 manual smoke expects plain text results
const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] }); // structured errors the model can interpret

// shared description warnings agents must see (PLAN.md §6 line 111 + §4 line 92 + §3 lines 84-85):
const W_PATH = "Remote paths are POSIX: use / not \\; relative paths resolve against the session's current remote cwd."; // builders reject backslashes with this hint (§3 line 84)
const W_NI = "Never run interactive remote programs (vim/REPL/nested ssh swallow the piped stdin and desync the session); non-interactive invocations only."; // §6 line 111: tool description must warn agents
const W_SESS = "Every result starts with [session=...]; pass session_name explicitly whenever more than one session is alive."; // §4 line 92 wrong-host mitigation

const hdr = (nm: string, warn: string[]): string => `[session=${nm}]\n${warn.map((w) => `${w}\n`).join("")}`.trimEnd(); // same header convention as sess.formatSend (§4 line 92), for success/rejection messages

async function live(name?: string): Promise<{ s: sess.Session; warn: string[] }> { // dead-session recovery before any tool call (PLAN.md §4 line 89)
  const r = await sess.ensureLive(name); return { s: r.session, warn: r.reconnected ? ["[session reconnected — shell state lost]"] : [] };
}

async function wire(server: McpServer): Promise<void> { // §7 line 118: register the tool surface (§3 table + ssh_setup_key)

  server.registerTool("ssh_connect", { description: `Connect a persistent SSH session through the local OpenSSH client (one long-lived process; cd/env/background state persists across later tools). Key-based auth at runtime by default — use ssh_setup_key first if you need password bootstrap; password= is an accepted fallback (SSH_ASKPASS force, no tty) for hosts where ~/.ssh isn't writable: the password is persisted in that session's spec until disconnect. Idempotent: an alive name returns the existing session. ${W_SESS}`, inputSchema: z.object({ host: z.string().describe("remote host or ip"), port: z.number().int().min(1).max(65535), user: z.string(), identity: z.string().optional().describe("absolute local path to an identity key file (defaults to ssh-mcp/id_ed25519 under userData when present)"), name: z.string().optional().describe("session name (defaults to user@host)"), password: z.string().optional().describe("password auth fallback — only if key auth is unavailable on the host") }) },
    async ({ host, port, user, identity, name, password }) => { try { const nm = await sess.connect(host, port, user ?? "", identity, name, password); return ok(`[session=${nm}] connected — ${user}@${host}:${port} (shell state persists across tools)\n${sess.capsLine(nm)}`); } catch (e) { return fail(sess.errText(e)); } }); // caps line: issue #1/#2 capability visibility right after connect

  server.registerTool("ssh_disconnect", { description: "Disconnect an SSH session: kill the child process and drop it from the registry + persisted specs. Default target: last connected session.", inputSchema: z.object({ name: z.string().optional() }) },
    async ({ name }) => { const nm = sess.disconnect(name); return nm ? ok(`[session=${nm}] disconnected`) : fail("no active session to disconnect"); });

  server.registerTool("ssh_list_sessions", { description: "List known sessions: in-memory liveness plus persisted specs (after a full server restart, ssh_connect by the same name transparently reconnects; shell state is lost).", inputSchema: z.object({}) },
    async () => { const rows = sess.listSessions().map((r) => `${r.name}  ${r.host}:${r.port} user=${r.user}  ${r.alive ? "alive" : "persisted-only (ssh_connect to reconnect)"}`); return ok(rows.length > 0 ? rows.join("\n") : "no sessions known"); });

  server.registerTool("ssh_capabilities", { description: `Probe remote utilities once per session (rg/grep/find/awk/sed/sha256sum/shasum/openssl) and report which exist — ssh_grep auto-uses rg when present, ssh_view needs awk, ssh_edit's checksum uses sha256sum or shasum. refresh=true re-probes after infra installs new binaries. ${W_SESS}`, inputSchema: z.object({ session_name: z.string().optional(), refresh: z.boolean().optional() }) },
    async ({ session_name, refresh }) => { try { const l = await live(session_name); if (refresh) sess.setCapsFromText(l.s, (await l.s.send(cm.buildCaps())).text); // re-probe on demand after infra changes
      const known = ["rg", "grep", "find", "awk", "sed", "sha256sum", "shasum", "openssl"]; const rows = known.map((k) => `${k}: ${l.s.caps.has(k) ? l.s.caps.get(k)! : (refresh ? "NOT PRESENT" : "not probed/absent")}`); return ok(`${hdr(l.s.name, l.warn)}\nshell=${l.s.detectedShell}\n${rows.join("\n")}${sess.capsLine(l.s.name)}`); } catch (e) { return fail(sess.errText(e)); } }); // issues #1/#2: capability surface so agents can decide rg-vs-grep explicitly

  server.registerTool("ssh_exec", { description: `Run a shell command on the session's persistent remote shell; stdout+stderr combined, returns exit rc. Multi-line commands OK. ${W_NI} Default timeout 30s (timeout_ms override); hard timeouts kill the session and it auto-reconnects next call.`, inputSchema: z.object({ session_name: z.string().optional(), command: z.string(), timeout_ms: z.number().int().min(1000).max(600_000).optional() }) },
    async ({ session_name, command, timeout_ms }) => { try { const l = await live(session_name); const res = await l.s.send(command, timeout_ms); // optional pass-through: number|undefined -> param?: legal; Session.send frames per §2 line 53 and clamps to [1s,600s]
      let out = sess.formatSend(l.s.name, res, l.warn); if (!res.timedOut && !res.connLost) out += `\n[rc=${res.rc}]`; // §3 line 75 combined streams + rc (§6 line 108 honest limit)
      return ok(out); } catch (e) { return fail(sess.errText(e)); } });

  server.registerTool("ssh_view", { description: `Windowed read of a remote file — never a full-file cat: no offset = first 2000 lines, with offset/limit a sliding window; lines numbered locally like the local Read tool. ${W_PATH} Also caches the file's sha256 for ssh_edit's change guard.`, inputSchema: z.object({ path: z.string(), offset: z.number().int().min(1).optional().describe("1-based first line"), limit: z.number().int().min(1).max(2000).optional(), session_name: z.string().optional() }) },
    async ({ path, offset, limit, session_name }) => { try { const l = await live(session_name); const res = await l.s.send(cm.buildView(path, offset, limit)); // awk window both cases (POSIX-portable; §3 line 76)
      const chk = await l.s.send(cm.buildChecksum(path)); const h = cm.parseChecksum(chk.text); if (h !== null) l.s.setChecksum(path, h); // second send right after: cache sha256 per path for the edit guard (§3 line 76 / §4)
      if (res.rc !== null && res.rc !== 0) return fail(sess.formatSend(l.s.name, res, l.warn)); // missing file / empty window -> rc + "file not found" style msg (§3 line 76)
      let body = res.text; if (body.endsWith("\n")) body = body.slice(0, -1); const base = offset ?? 1; const numbered = body.length === 0 ? "[empty window]" : body.split("\n").map((ln, i) => `${base + i}\t${ln}`).join("\n"); // number lines locally like local Read (§3 line 76)
      return ok(sess.formatSend(l.s.name, res, l.warn, numbered)); } catch (e) { return fail(sess.errText(e)); } });

  server.registerTool("ssh_create", { description: `Create or overwrite a remote file with exact content (heredoc write, no shell expansion in the body; trailing newline normalized to exactly one). ${W_PATH}`, inputSchema: z.object({ path: z.string(), content: z.string(), session_name: z.string().optional() }) },
    async ({ path, content, session_name }) => { try { const l = await live(session_name); const res = await sess.createHeredoc(l.s, path, content); // fresh delimiter token per attempt (§3 line 77 regenerate-on-collision loop)
      if (res.rc !== null && res.rc !== 0) return fail(sess.formatSend(l.s.name, res, l.warn)); // heredoc write failure -> structured error showing raw output (§3 line 77)
      return ok(`${hdr(l.s.name, l.warn)}\nwrote ${Buffer.byteLength(content)} bytes to ${path}`); } catch (e) { return fail(sess.errText(e)); } });

  server.registerTool("ssh_edit", { description: `Exact-match edit of a remote file with the same semantics as the local Edit tool: fails on not-found or multiple matches without replace_all. Reads full content + sha256 change guard, then rewrites whole file via heredoc (PLAN.md §3 line 78 shortcut; upgrade = remote patch for >2 MB files). ${W_PATH}`, inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional(), session_name: z.string().optional() }) },
    async ({ path, old_string, new_string, replace_all, session_name }) => { try { const l = await live(session_name); const r = await sess.editGuarded(l.s, path, old_string, new_string, replace_all ?? false); // §3 lines 78-79 + §4 guard — core flow (mock-tested per §5 line 101)
      return (r.ok ? ok : fail)(`${hdr(l.s.name, l.warn)}\n${r.message}`); } catch (e) { return fail(sess.errText(e)); } });

  server.registerTool("ssh_grep", { description: `Search remote files by regex; prefers rg when detected at connect, else grep with portable fallback. Use ssh_capabilities to see whether rg exists on the server (rg is much faster on big trees); grep form runs automatically when it doesn't. Returns file:line:text like the local Grep tool; results capped server-side. ${W_PATH}`, inputSchema: z.object({ pattern: z.string(), path: z.string().optional().describe("remote dir or file (default .)"), glob: z.string().optional().describe("include-glob filter e.g. *.ts (rg --glob / grep --include)"), context: z.number().int().min(0).max(20).optional(), max_results: z.number().int().min(1).max(1000).optional(), session_name: z.string().optional() }) },
    async ({ pattern, path, glob, context, max_results, session_name }) => { try { const l = await live(session_name); // optional pass-through everywhere below (string|undefined -> param? is legal TS)
      let res = await l.s.send(cm.buildGrep(pattern, path, { rg: l.s.hasRg, includeGlob: glob, context })); // §3 line 79 rg or grep -rnH --include=...
      if (!l.s.hasRg && res.rc !== null && res.rc >= 2) { const r2 = await l.s.send(cm.buildGrep(pattern, path, { rg: false, portable: true })); // §6 line 112 dialect drift retry (BSD/busybox lack -H/--include/-C; context dropped in this fallback form — documented limitation)
        if (r2.rc === null || r2.rc >= 2) return fail(sess.formatSend(l.s.name, res, l.warn)); // structured error showing raw grep usage/err output (§79 shape)
        res = r2; }
      if (res.connLost) return fail(sess.formatSend(l.s.name, res, l.warn)); const maxN = Math.max(1, Math.min(1000, max_results ?? 200)); // §3 line 79 cap results server-side (~local-Grep default)
      const lines = res.text.split("\n").map((x) => x.trimEnd()).filter((x) => x.length > 0); if (lines.length === 0 || res.rc === 1) return ok(`${hdr(l.s.name, l.warn)}\n[no matches]`); // §3 line 79: rc=1 from grep/rg means "no matches" — empty result set, NOT an error
      const shown = lines.slice(0, maxN); const more = lines.length - shown.length; return ok(sess.formatSend(l.s.name, { text: shown.join("\n"), rc: null }, l.warn) + (more > 0 ? `\n[+${more} results truncated]` : "")); } catch (e) { return fail(sess.errText(e)); } });

  server.registerTool("ssh_glob", { description: `Find remote files by name glob — basename approximation only (** pruned to -name '<basename>'; upgrade = remote python one-liner for full glob semantics per PLAN.md §3 line 80). Output capped by limit (default 500). ${W_PATH}`, inputSchema: z.object({ pattern: z.string().describe("glob like **/*.ts — matched on basename"), path: z.string().optional().describe("remote dir to search under (default .)"), limit: z.number().int().min(1).max(5000).optional(), session_name: z.string().optional() }) },
    async ({ pattern, path, limit, session_name }) => { try { const l = await live(session_name); const res = await l.s.send(cm.buildGlob(pattern, path, limit)); // find ( -name '<pat>' ) -print 2>/dev/null | head (§3 line 80)
      if (res.connLost) return fail(sess.formatSend(l.s.name, res, l.warn)); const files = res.text.split("\n").map((x) => x.trimEnd()).filter((x) => x.length > 0); if (files.length === 0) return ok(`${hdr(l.s.name, l.warn)}\n[no matches]`);
      return ok(sess.formatSend(l.s.name, { text: files.join("\n"), rc: null }, l.warn)); } catch (e) { return fail(sess.errText(e)); } });

  server.registerTool("ssh_setup_key", { description: "One-time password bootstrap for key-based sessions later: generate/reuse local id_ed25519 under userData ssh-mcp/, single throwaway ssh connection with SSH_ASKPASS feeding the password (no tty), append pubkey to remote ~/.ssh/authorized_keys. Subsequent ssh_connect uses that key automatically — no password in any later call or persisted spec.", inputSchema: z.object({ host: z.string(), port: z.number().int().min(1).max(65535), user: z.string(), password: z.string() }) },
    async ({ host, port, user, password }) => { try { const key = await sess.setupKey(host, port, user ?? "", password); return ok(`identity ready at ${key} — ssh_connect will use it by default`); } catch (e) { return fail(`${sess.errText(e)}\n[if password auth is disabled: add the printed .pub file to ~/.ssh/authorized_keys manually, then ssh_connect with identity=<that path>]`); } }); // §4 line 93 structured error pointing at the identity-file path
}

async function main(): Promise<void> { // §5 test3 wiring: opencode/Claude spawn this via stdio (opencode.json mcp entry)
  const server = new McpServer({ name: "ssh-mcp", version: "0.1.0" }); await wire(server); await server.connect(new StdioServerTransport()); // §7 line 118 stdio transport only
}

main().catch((e) => { console.error(`ssh-mcp startup failed: ${sess.errText(e)}`); }); // stderr only — stdout is reserved for MCP framing
