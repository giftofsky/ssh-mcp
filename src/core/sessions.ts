// SessionRegistry: name -> live ssh process + framing engine (PLAN.md §2/§4).
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as pathMod from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

// sibling core modules (compiled into dist/src/core/ alongside this file)
import * as cm from "./commands";
import { FramingParser } from "./framing";

export type TargetSpec = { host: string; port: number; user: string; identity?: string; password?: string };// Transport-agnostic process handle so mock_runner.ts can stand in for spawn("ssh", ...).
export interface Proc {
  write(s: string): void;
  kill(): void;
  onStdout(cb: (b: Buffer) => void): void;
  onStderr(cb: (b: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface SendResult { text: string; rc: number | null; timedOut?: boolean; connLost?: boolean };
interface PendingEntry { done: boolean; resolve: (r: SendResult) => void }

export const DEFAULT_TIMEOUT_MS = 30_000; // PLAN.md §2 timeouts & caps (default exec timeout, line 64)
const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_CAP = 64 * 1024;
export const MAX_EDIT_BYTES = 2 * 1024 * 1024; // §9 size preflight default for cat-based edit path (tool arg max_bytes overrides)

export function hexToken(): string { return randomBytes(6).toString("hex"); } // shortcut: 24-bit collision negligible (PLAN.md line 59) — also used for heredoc delimiter tokens (§3 line 77 regenerate-token loop)

export function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); } // strict-TS catch param is not guaranteed Error in ES2023 target — shared with index handlers via sess.errText

export function userDataDir(): string { return pathMod.join(os.homedir(), ".config"); }
const sessionsJsonPath = () => pathMod.join(userDataDir(), "ssh-mcp", "sessions.json");

function loadSpecs(): Record<string, TargetSpec> { // persisted *target specs* only (PLAN.md line 45)
  try { return JSON.parse(fs.readFileSync(sessionsJsonPath(), "utf8")); } catch { return {}; }
}

function saveSpecs(specs: Record<string, TargetSpec>): void {
  const f = sessionsJsonPath();
  fs.mkdirSync(pathMod.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(specs));
}

export function identityHint(): string { return pathMod.join(userDataDir(), "ssh-mcp", "id_ed25519"); } // surfaced in error messages (PLAN.md §4)
function defaultIdentityPath(): string | null { const p = identityHint(); return fs.existsSync(p) ? p : null; }

const registry = new Map<string, Session>(); // covers "same session after context reset" while server runs
let lastConnectedName: string | null = null;

export class Session { // exported: mock-driven unit tests construct sessions directly (PLAN.md §5 lines 95-101); server types them via sess.Session (§7 line 118)
  name: string; spec: TargetSpec; token: string; parser: FramingParser;
  procRef: Proc | null = null; dead = true; sshErr = ""; exitCode: number | null = null; detectedShell = "bash"; hasRg = false; grepEngine: "rg" | "ag" | "ugrep" | "grep" = "grep"; caps = new Map<string, string>(); // probed remote utilities (issue #1/#2 capability surface); grepEngine from §9 ladder pick
  checksumCache: Map<string, string> = new Map(); // path -> sha256 at last view (PLAN.md §3 edit guard)

  constructor(name: string, spec: TargetSpec, token?: string) {
    this.name = name; this.spec = spec;
    this.token = token ?? hexToken();
    this.parser = new FramingParser(this.token); // PLAN.md framing protocol §2
  }

  private pending: PendingEntry[] = [];

  attach(proc: Proc): void { // wire the framing engine to a process handle
    this.procRef = proc; this.dead = false;
    proc.onStdout((b) => { this.parser.feed(b); this.drain(); });
    proc.onStderr((b) => { this.sshErr += b.toString("utf8"); }); // ssh-client stderr kept separate (PLAN.md line 56)
    proc.onExit((code) => { if (this.dead) return; this.exitCode = code; this.dead = true; this.failPending(); });
  }

  send(cmdText: string, timeoutMs?: number): Promise<SendResult> { // one framed command per call; commands serialize on the single pipe (§4 line 90)
    if (this.dead || !this.procRef) throw new Error("session closed"); // caller reconnects via ensureLive()
    const self = this;
    return new Promise<SendResult>((resolve) => {
      const entry: PendingEntry = { done: false, resolve };
      this.pending.push(entry); // push BEFORE write so mock's synchronous drain sees it
      try { self.procRef!.write(cm.buildExec(self.token, cmdText)); } // framed send per PLAN.md line 53
      catch (e) { self.dead = true; self.failPending(); throw new Error(`session write failed: ${errText(e)}`); } // PLAN.md line 43 pipes / §4 recovery: post-death writes surface as structured errors, never silent corruption — see framing.ts for the send shape
      const ms = Math.max(1_000, Math.min(600_000, timeoutMs ?? DEFAULT_TIMEOUT_MS)); // clamp; default 30s per §2
      setTimeout(() => self.timeoutHandler(entry), ms); // stale timers after resolve are guarded by entry.done
    });
  }

  private drain(): void { // FIFO pop one-per-command (PLAN.md line 61: back-to-back sends may stack sentinels)
    while (this.pending.length > 0) { const r = this.parser.tryPop(); if (!r) break; const p = this.pending.shift()!; if (!p.done) p.resolve({ text: r.text, rc: r.rc }); }
  }

  private failPending(): void { // process died mid-flight → lost connection (PLAN.md line 63 / §4 recovery)
    while (this.pending.length > 0) { const p = this.pending.shift()!; if (!p.done) { p.done = true; p.resolve({ text: "", rc: null, connLost: true }); } }
  }

  timeoutHandler(e: PendingEntry): void { // hard timeout kills the whole session process (PLAN.md §2 shortcut line 65)
    if (e.done) return; e.done = true; this.dead = true;
    try { const p = this.procRef; if (p) p.kill(); } catch { /* already gone */ }
    e.resolve({ text: this.parser.partialText(), rc: null, timedOut: true }); // partial output + error shape (PLAN.md line 63)
    this.failPending(); // remaining in-flight commands die with the session (§4 auto-reconnects next call)
  }

  setChecksum(p: string, h: string): void { this.checksumCache.set(p, h); }
  getChecksum(p: string): string | null { return this.checksumCache.get(p) ?? null; } // cached per path for the edit guard (§4)
}

function spawnSsh(spec: TargetSpec, token: string, remoteCmd: string): Proc { // argv per PLAN.md §2 block; local OpenSSH client only (line 10)
  const identity = spec.identity ?? defaultIdentityPath(); // ssh_setup_key output reused by default (§4 line 93)
  let askpassScript: string | null = null; const env = { ...process.env };
  if (spec.password) { // deviation accepted 2026-10-20 at user request: runtime password auth via SSH_ASKPASS force. shortcut: plaintext password lives in persisted spec + temp script while the session lives — upgrade = OS keychain or keys-capable host when reported
    const dir = pathMod.join(userDataDir(), "ssh-mcp"); fs.mkdirSync(dir, { recursive: true }); const win = os.platform() === "win32"; askpassScript = pathMod.join(dir, `askpass-${token}${win ? ".cmd" : ".sh"}`);
    if (win) { fs.writeFileSync(askpassScript, `@echo off\r\necho ${escCmd(spec.password)}\r\n`); } else { fs.writeFileSync(askpassScript, `#!/bin/sh\nprintf '%s' ${cm.shq(spec.password)}\n`); fs.chmodSync(askpassScript, 0o755); } // POSIX script must be executable for ssh to invoke it
    env.SSH_ASKPASS = askpassScript; env.SSH_ASKPASS_REQUIRE = "force"; // force askpass even without tty (verified working on Windows OpenSSH at impl time)
  }
  const args = [
    ...(spec.password ? [] : ["-o", "BatchMode=yes"]), // never prompt; fail fast if auth broken (PLAN.md line 31) — password sessions omit it so the force-askpass path can run, still no tty/stdin prompting
    "-o", "ConnectTimeout=10", // PLAN.md line 32
    ...(identity ? ["-i", identity] : []), // PLAN.md line 33 — ALL flags before destination: ssh stops option parsing at first non-opt arg (line 34 comment)
    "-p", String(spec.port), // PLAN.md line 35-36
    `${spec.user}@${spec.host}`,
    remoteCmd, // plain shell reading commands from stdin; NO -t / no PTY (lines 37-39); `bash --no-interactive-login` isn't a real bash flag so impl passes bare "bash" then "sh" fallback (line 39 note)
  ];
  const child = spawn("ssh", args, { env }); // password sessions carry askpass env; key-only sessions unchanged from §2 argv exactly
  if (askpassScript) child.on("exit", () => { try { fs.unlinkSync(askpassScript!); } catch { /* best effort */ } }); // no password left on disk once the session process ends (§4 line 93 hygiene extended to runtime auth)
  child.stdin.on("error", () => { /* swallow EPIPE; send() surfaces the death */ }); // PLAN.md line 43: output read from stdout/stderr pipes
  const stdout = child.stdout, stderr = child.stderr;
  return {
    write: (s: string) => { child.stdin.write(s); },
    kill: () => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, // hard-timeout kill path (§2 shortcut line 65)
    onStdout: (cb: (b: Buffer) => void) => { stdout.on("data", cb); },
    onStderr: (cb: (b: Buffer) => void) => { stderr.on("data", cb); },
    onExit: (cb: (code: number | null) => void) => { child.on("exit", (evCode: unknown) => { cb(typeof evCode === "number" ? evCode : null); }); } // PLAN.md line 56: ssh's own errors surface separately via sshErr
  };
}

export function setCapsFromText(s: Session, text: string): void { // parse name=path probe lines (issues #1/#2) — shared by connect probe + ssh_capabilities refresh; §9 grep ladder decided here once per session/refresh
  for (const ln of text.split("\n")) { const eq = ln.indexOf("="); if (eq > 0) s.caps.set(ln.slice(0, eq), ln.slice(eq + 1)); } s.hasRg = s.caps.has("rg"); // rg presence kept as quick flag; engine choice below is authoritative
  const ladder: Array<"rg" | "ag" | "ugrep"> = ["rg", "ag", "ugrep"]; let eng: "rg" | "ag" | "ugrep" | "grep" = "grep"; for (const e of ladder) if (s.caps.has(e)) { eng = e; break; } s.grepEngine = eng; }

async function attachSession(name: string, spec: TargetSpec): Promise<{ session?: Session; errorHint: string }> { // fallback chain bash→sh (PLAN.md line 39)
  let hint = "";
  for (const shell of ["bash", "sh"]) {
    const s = new Session(name, spec);
    s.attach(spawnSsh(spec, s.token, shell)); // probe remote shell once (`printf ok`) and record interpreter (§3 line 72)
    try {
      const r = await s.send("printf ok", PROBE_TIMEOUT_MS);
      if (!r.connLost && !r.timedOut && r.rc === 0) { // remote shell live + framing works end-to-end
        s.detectedShell = shell;
        try { const rg = await s.send(cm.buildCaps(), PROBE_TIMEOUT_MS); setCapsFromText(s, rg.text); } catch { /* probe failed: empty caps means "unknown", tools still fall back */ } // capability probe at connect (issues #1/#2)
        registry.set(name, s); lastConnectedName = name;
        const sp = loadSpecs(); sp[name] = spec; saveSpecs(sp); // persisted so a fresh server process can reconnect by name (line 45)
        return { session: s, errorHint: "" };
      }
    } catch { /* dead shell/auth — try next interpreter */ }
    hint = s.sshErr.length > 0 ? s.sshErr : hint; // auth/connection stderr from failed attempt → structured error upstream (§4 line 93 note)
  }
  return { errorHint: hint };
}

export async function connect(host: string, port: number, user: string, identity?: string, name?: string, password?: string): Promise<string> { // §3 ssh_connect row; returns session name (password = accepted runtime deviation, see spawnSsh)
  const nm = name ?? `${user}@${host}`;
  const existing = registry.get(nm);
  if (existing && !existing.dead) return nm; // same name alive → idempotent reuse, agents retry safely (§4 line 91)
  const spec: TargetSpec = { host, port, user }; if (identity) spec.identity = identity; if (password) spec.password = password;
  const a = await attachSession(nm, spec);
  if (!a.session) throw new Error(`ssh_connect failed for ${nm}: ${a.errorHint || "no remote shell or auth rejected"} — key-based at runtime; use ssh_setup_key(host,port,user,password) to bootstrap, or pass password= (SSH_ASKPASS fallback)`); // §4 auth note line 93
  return nm;
}

export function capsLine(nm?: string): string { const s = registry.get(nm ?? lastConnectedName ?? ""); if (!s || s.caps.size === 0) return "[caps] probe unavailable — tools auto-fallback"; const known = ["rg", "ag", "ugrep", "grep", "sed", "patch", "diff", "stat", "wc", "find", "awk", "python3", "sha256sum", "shasum"]; return `[caps] ${known.map((k) => `${k}=${s.caps.has(k) ? s.caps.get(k)! : "no"}`).join(" ")} [engine=${s.grepEngine}]`; } // issue #1/#2 + §9: capability visibility and chosen grep engine surfaced to agents at connect

export async function ensureLive(name?: string): Promise<{ session: Session; reconnected: boolean }> { // dead-session recovery before any tool call (PLAN.md §4 line 89)
  let nm = name ?? lastConnectedName;
  if (!nm) { const known = Object.keys(loadSpecs()); throw new Error(`no active session${known.length ? ` — persisted specs: ${known.join(", ")}; ssh_connect by name` : " — run ssh_connect"}`); } // §45 disk persistence covers server restarts via named reconnect
  let s = registry.get(nm);
  if (!s || s.dead) { // attempt reconnect from persisted spec once (§4 lines 89-91)
    const spec = loadSpecs()[nm] ?? (s ? s.spec : undefined); if (!spec) throw new Error(`no session '${nm}' known here — ssh_connect first`);
    registry.delete(nm);
    const a = await attachSession(nm, spec as TargetSpec); // attachSession re-registers + persists on success
    if (!a.session) throw new Error(`session '${nm}' is dead and reconnect failed (${a.errorHint}) — run ssh_connect`); // §4 line 89 structured error
    return { session: a.session, reconnected: true }; // caller prepends "[session reconnected — shell state lost]" (§4 line 89)
  }
  return { session: s, reconnected: false };
}

export function disconnect(name?: string): string | null { // kill child + drop from registry + sessions.json (§3 line 73)
  const nm = name ?? lastConnectedName; if (!nm) throw new Error("no active session to disconnect");
  const s = registry.get(nm); if (s?.procRef) try { s.procRef.kill(); } catch { /* already dead */ } // §4: hard-kill semantics, remote orphan children may linger (§6 line 109)
  registry.delete(nm);
  const sp = loadSpecs(); delete sp[nm]; saveSpecs(sp); if (lastConnectedName === nm) lastConnectedName = null;
  return nm;
}

export function listSessions(): Array<{ name: string; host: string; port: number; user: string; alive: boolean }> { // §3 line 74-75: local process-alive flag, not remote kill -0
  const out = []; for (const [nm, s] of registry) out.push({ name: nm, host: s.spec.host, port: s.spec.port, user: s.spec.user, alive: !s.dead });
  const seen = new Set(registry.keys()); for (const [nm, spec] of Object.entries(loadSpecs())) if (!seen.has(nm)) out.push({ name: nm, host: spec.host, port: spec.port, user: spec.user, alive: false }); // persisted-only entries so agents can reconnect by name (§4 line 45)
  return out;
}

export async function createHeredoc(s: Session, path: string, content: string): Promise<SendResult> { // ssh_create write-back core (§3 line 77): fresh delimiter token per attempt; regenerate on collision with content lines
  for (let i = 0; i < 5; i++) { const tok = hexToken(); if (!cm.contentCollidesWithDelim(content, tok)) return await s.send(cm.buildCreate(tok, path, content)); }
  throw new Error("delimiter collision persists after 5 regenerations"); // §6 honest limit — never observed with hex tokens in practice (§3 line 77)
}

export async function editGuarded(s: Session, path: string, oldString: string, newString: string, replaceAll?: boolean, maxBytes?: number): Promise<{ ok: boolean; message: string }> { // ssh_edit file-flow core (§3 lines 78-79 + §4 guard) — mock-testable per §5 line 101; §9 adds size preflight (stat/wc gated) + O(1) stat-tuple race guard with checksum floor
  const mb = Math.max(1_024, maxBytes ?? MAX_EDIT_BYTES); let tuple: [number, number] | null = null; let wcSize: number | null = null;
  if (s.caps.has("stat")) { // O(1) guard tier (§9): one stat send doubles as size preflight AND race detector — no full-file hashing when GNU stat present
    const st1 = await s.send(cm.buildStat(path)); tuple = cm.parseStatTuple(st1.text); if (!tuple && st1.rc !== null && st1.rc !== 0) return { ok: false, message: `stat probe failed:\n${st1.text}` }; // missing/unreadable file caught early cheaply
    if (tuple && tuple[0] > mb) return { ok: false, message: `[file too large (${tuple[0]} bytes > ${mb}) — use ssh_view offset/limit windows or pass max_bytes]` }; }
  else if (s.caps.has("wc")) { const wc0 = await s.send(cm.buildSizeProbe(path)); const mw = /^\s*(\d+)/.exec(wc0.text); if (mw) wcSize = Number(mw[1]); if (wcSize !== null && wcSize > mb) return { ok: false, message: `[file too large (${wcSize} bytes > ${mb}) — use ssh_view offset/limit windows or pass max_bytes]` }; }
  const statMode = tuple !== null; let h1: string | null = null; if (!statMode) { const chk1 = await s.send(cm.buildChecksum(path)); h1 = cm.parseChecksum(chk1.text); } // checksum floor for hosts without GNU stat (§3 line 78 chain)
  const cat = await s.send(cm.buildCat(path)); if (cat.connLost || (cat.rc !== null && cat.rc !== 0)) return { ok: false, message: `file not found or unreadable:\n${cat.text}` }; // §3 lines 76-78 style msg; rc surfaced by caller's format
  const ed = cm.applyEdit(cat.text, oldString, newString, replaceAll); if (!ed.ok) return { ok: false, message: `edit rejected (no write performed): ${ed.error}` }; // §3 line 79 semantics — pure local function so no write-back happens here
  let raced = false; if (statMode) { const st2 = await s.send(cm.buildStat(path)); const t2 = cm.parseStatTuple(st2.text); raced = tuple !== null && t2 !== null && (t2[0] !== tuple[0] || t2[1] !== tuple[1]); } // §9 mtime+size compare, O(1)
  else { const chk2 = await s.send(cm.buildChecksum(path)); const h2 = cm.parseChecksum(chk2.text); raced = h1 !== null && h2 !== null && h1 !== h2; } // §3 line 78 mismatch guard returns structured error, does NOT write back ✓
  if (raced) return { ok: false, message: "[file changed between read and write-back — modified remotely during this call; re-view and retry]" }; // unified race shape covering both guard tiers (§4 edit-guard freshness)
  try { const wr = await createHeredoc(s, path, ed.content); if (wr.rc !== null && wr.rc !== 0) return { ok: false, message: `write-back failed:\n${wr.text}` }; } catch (e) { return { ok: false, message: errText(e) }; } // §3 line 78 heredoc failure shape — now atomic tmp+mv inside builder (§9)
  s.checksumCache.delete(path); // invalidate cached view hash after rewrite (§4 edit-guard freshness)
    return { ok: true, message: `updated ${path} (${Buffer.byteLength(ed.content)} bytes)` }; }

export function formatSend(
name: string, res: SendResult, warnings?: string[], bodyText?: string): string { // every result starts with [session=...] header (§4 line 92); caps per §2; bodyText lets view/edit supply locally-numbered text instead of raw
  const src = bodyText ?? res.text; let t = src; if (t.length > OUTPUT_CAP) { const half = Math.floor(OUTPUT_CAP / 2); t = `${t.slice(0, half)}\n[truncated ${src.length - OUTPUT_CAP} bytes]\n${t.slice(src.length - half)}`; } // head+tail with marker: agents page via grep/view offsets
  let out = `[session=${name}]\n`; for (const w of warnings ?? []) out += `${w}\n`; // warning lines after the header, before body (§4 reconnect note)
  const notes: string[] = []; if (res.timedOut) notes.push("[timed out — session killed; it will auto-reconnect on the next call]"); if (res.connLost) notes.push("[connection closed — auth/connection lost; ssh_connect to re-establish]"); // structured error shape (§2 line 63 / §4 recovery)
  return out + t + (notes.length > 0 ? `\n${notes.join("\n")}\n` : "");
}

function escCmd(pw: string): string { return pw.replace("%", "%%").replace(/([&^|<>()!])/g, "^$1"); } // shortcut: cmd.exe escaping edge cases (delayedexpansion); upgrade = tiny helper exe if reported broken (§6 honest limits)

export async function setupKey(host: string, port: number, user: string, password: string): Promise<string> { // one-time bootstrap (§4 line 93); returns identity path for later ssh_connect
  const dir = pathMod.join(userDataDir(), "ssh-mcp"); fs.mkdirSync(dir, { recursive: true });
  const key = identityHint();
  if (!fs.existsSync(key)) { // generate/reuse local id_ed25519(.pub) under userData (§4 line 93) — ssh-keygen ships with the OpenSSH client anyway (line 10 constraint is about SSH *libs*)
    const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", key, "-N", ""]); if (!(r.status === 0)) throw new Error(`ssh-keygen failed: ${String(r.stderr ?? "")}${String(r.error?.message ?? "")}`); } // @types/node v24 SpawnSyncReturns field is .status
  const pubPath = `${key}.pub`; if (!fs.existsSync(pubPath)) throw new Error(`private key at ${key} has no .pub — regenerate manually or add your own pubkey to the remote authorized_keys`); // §4 structured error pointing at identity path
  const pub = fs.readFileSync(pubPath, "utf8").trimEnd() + "\n";

  const win = os.platform() === "win32"; const script = pathMod.join(dir, win ? "askpass.cmd" : "askpass.sh"); // password fed via SSH_ASKPASS helper since no tty is available (§4 line 93)
  let body: string; if (win) { body = `@echo off\r\necho ${escCmd(password)}\r\n`; } else { body = `#!/bin/sh\nprintf '%s' ${cm.shq(password)}\n`; fs.chmodSync(script, 0o755); } // POSIX script must be executable for ssh to invoke it
  fs.writeFileSync(script, body);

  const args = ["-o", "ConnectTimeout=15", "-p", String(port), `${user}@${host}`, // single throwaway ssh connection WITHOUT BatchMode so the password path can run (§4 line 93)
    "mkdir -p ~/.ssh; chmod 700 ~/.ssh; cat >> ~/.ssh/authorized_keys"]; // append pubkey, set perms best-effort (§4 line 93)
  const env = { ...process.env, SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: "force" }; // force askpass even without tty; OpenSSH builds lacking REQUIRE can't use this flow → structured error below (verified at impl time per §4 note)
  try {
    const child = spawn("ssh", args, { env }); let err = "";
    child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    try { child.stdin.write(pub); child.stdin.end(); } catch { /* ssh may die early */ } // pubkey line streamed into remote `cat >> authorized_keys`
    const code = await new Promise<number>((done) => { child.on("exit", (evCode: unknown) => done(typeof evCode === "number" ? evCode : -1)); setTimeout(() => { try { child.kill(); } catch {} }, 25_000); }); // kill that process (§4 line 93)
    if (code !== 0 || err.includes("denied")) throw new Error(`password bootstrap failed (exit ${code}): ${err.trim() || "password auth disabled?"} — add ${pubPath} to ~/.ssh/authorized_keys manually, then ssh_connect with identity=<that path>`); // §4: structured error pointing at the identity file
    return key;
  } finally { try { fs.unlinkSync(script); } catch { /* best effort */ } } // no password left on disk beyond this temp script (§4: not in any later call or persisted spec)
}
