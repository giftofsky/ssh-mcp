// Pure command builders (PLAN.md §3). Remote FS is POSIX: all interpolated paths go through shq().

export function shq(s: string): string {
  return "'" + s.replace("'", "'\\''") + "'"; // 'p'\''q' style escaping, PLAN.md line 83
}

export function rejectWinPath(p: string, what: string): void {
  if (p.includes("\\")) throw new Error(`${what} must be a POSIX remote path — use / not \\`);
}

function qpath(p: string): string { rejectWinPath(p, "path"); return shq(p); }

export function buildExec(token: string, cmd: string): string {
  const c = cmd.length > 0 ? cmd : ":";
  // PLAN.md framing line, verbatim shape; token inlined so reconnects need no shell var setup.
  return `{\n${c}\n} 2>&1 ; __rc=$? ; printf '\\001E%s\\001rc=%d\\n' '${token}' "$__rc"\n`;
}

// Windowed read (PLAN.md §3 ssh_view). POSIX awk for both windows — GNU-only `sed -n` breaks on BSD/macOS.
export function buildView(path: string, offset?: number, limit?: number): string {
  const q = qpath(path);
  if (offset === undefined) return `awk 'NR<=2000' ${q}`; // head window, never full cat
  const s = Math.max(1, Math.floor(offset));
  const l = Math.max(1, Math.floor(limit ?? 500));
  return `awk 'NR>=${s} && NR<${s + l} {print} NR>=${s + l}{exit}' ${q}`;
}

export function buildCat(path: string): string { // full read for ssh_edit rewrite-back
  return `cat ${qpath(path)}`;
}

export function createDelim(token: string): string { return `__MK_${token}__`; }

export function contentCollidesWithDelim(content: string, token: string): boolean {
  const d = createDelim(token);
  for (const line of content.split("\n")) if (line.trimEnd() === d) return true; // also catches CRLF tails
  return false;
}

export function buildCreate(token: string, path: string, content: string): string { // §9 atomic write: heredoc into <path>.<tok>.tmp then same-fs mv -f (rename) — partial file never observable mid-write; cross-fs mv degrades to copy atomically=false (documented floor behavior unchanged otherwise)
  const d = createDelim(token);
  const nl = content.length === 0 || content.endsWith("\n") ? "" : "\n"; // don't add a trailing newline twice (shortcut: CRLF content stays CRLF remote-side)
  const q = qpath(path); const t = qpath(`${path}.${token}.tmp`);
  return `cat > ${t} <<'${d}'\n${content}${nl}${d}\nmv -f ${t} ${q}`; // tmp name carries token so parallel creates on same path never collide (§4 line 92 multi-session safety)
}

export function buildChecksum(path: string): string {
  const q = qpath(path);
  return `sha256sum ${q} 2>/dev/null || shasum -a 256 ${q} 2>/dev/null`; // GNU then BSD fallback
}

export function parseChecksum(line: string): string | null {
  const m = /^\s*([0-9a-f]{40,128})\s?\*?(\s|$)/m.exec(line);
  return m ? m[1] : null;
}

// remote utility capability probe (repo issues #1/#2 + §9 ladder): POSIX loop, one name=path line per present binary — inner shell is bash/sh from attachSession so $(...) + command -v are safe.
export function buildCaps(): string { return "for b in rg ag ugrep grep sed patch diff stat wc find awk python3 sha256sum shasum openssl; do p=$(command -v $b) && printf '%s=%s\\n' \"$b\" \"$p\"; done"; }

// §9 size/guard probe: GNU stat tuple (size + mtime epoch); BSD hosts lack -c so callers gate on caps.has("stat") and fall back to wc/`wc -c < f` or checksum.
export function buildStat(path: string): string { return `stat -c '%s %Y' ${qpath(path)}`; }
export function parseStatTuple(line: string): [number, number] | null { const m = /^\s*(\d+)\s+(\d{6,})/.exec(line); return m ? [Number(m[1]), Number(m[2])] : null; }

// §9 size probe when stat absent (wc is coreutils-everywhere; stdin form avoids filename noise)
export function buildSizeProbe(path: string): string { return `wc -c < ${qpath(path)}`; }

// grep builders — §9 engine ladder decided server-side (sessions pickEngine from caps); builder just emits the per-form line contract file:line:text. opts.portable stays for GNU→portable dialect retry (§6 line 112).
export function buildGrep(pattern: string, path?: string, opts?: { engine?: "rg" | "ag" | "ugrep" | "grep"; includeGlob?: string; context?: number; portable?: boolean }): string {
  const p = shq(pattern); const target = path === undefined ? "." : qpath(path); const o = opts ?? {}; // narrow once so strictNullChecks-friendly below
  const e = o.engine ?? "grep";
  if (e === "rg") { // ripgrep: skips hidden/VCS dirs by default, multithreaded — the fast tier (§3 line 79)
    let f = "--no-heading -n"; if (o.includeGlob) f += ` --glob ${shq(o.includeGlob!)}`; if (o.context) f += ` -C ${Math.floor(o.context!)}`;
    return `rg ${f} ${p} ${target}`;
  }
  if (e === "ag") { // --nogroup -n keeps the file:line:text contract; glob filter omitted — shortcut: ag's -G is regex not filename-glob, upgrade = translate when needed (§9)
    let f = "--nogroup -n"; if (o.context) f += ` -C ${Math.floor(o.context!)}`;
    return `ag ${f} ${p} ${target}`;
  }
  if (e === "ugrep") { // ugrep: -r recursive, line form default with -n; include via --glob= when given (§9 ladder tier)
    let f = "-r -n"; if (o.includeGlob) f += ` --glob=${shq(o.includeGlob!)}`; if (o.context) f += ` -C ${Math.floor(o.context!)}`;
    return `ugrep ${f} ${p} ${target}`;
  }
  let f = "-rnH"; // PLAN.md fallback form (line 79-80) — GNU grep only
  const port = o.portable === true; // BSD/busybox lack -H/--include/-C → server retries this portable form (§6 line 112)
  if (!port && o.context) f += ` -C ${Math.floor(o.context!)}`;
  let exc = ""; if (!port) for (const d of [".svn", ".git"]) exc += ` --exclude-dir=${shq(d)}`; // rg skips VCS dirs by default (hidden); GNU grep descends them — perf win on file-server trees, unsupported in portable/busybox form so omitted there
  const inc = !port && o.includeGlob ? ` --include=${shq(o.includeGlob!)}` : ""; // grep fallback uses --include= per spec (rg uses --glob above)
  return `grep ${f}${exc}${inc} ${p} ${target}`;
}

// find-based glob: basename approximation (PLAN.md line 80); ** pruned to -name '<basename>'.
export function buildGlob(pattern: string, dir?: string, limit?: number): string {
  rejectWinPath(pattern, "glob pattern");
  const base = shq(pattern.split("/").pop() || "*"); // shortcut: basename match only; upgrade = remote python one-liner for full glob semantics
  return `find ${dir === undefined ? "." : qpath(dir)} \\( -name ${base} \\) -print 2>/dev/null | head -n ${limit ?? 500}`;
}

// local Edit-tool semantics (PLAN.md §3 ssh_edit): exact-match, fail on not-found / multiple matches.
export function applyEdit(content: string, oldString: string, newString: string, replaceAll?: boolean): { ok: true; content: string } | { ok: false; error: string } {
  if (oldString.length === 0) return { ok: false, error: "empty old_string" };
  const count = content.split(oldString).length - 1;
  if (count === 0) return { ok: false, error: "old_string not found in file" };
  if (!replaceAll && count > 1) return { ok: false, error: `old_string matches ${count} times — pass replace_all or add more context` };
  const parts = content.split(oldString);
  return { ok: true, content: parts.join(newString) };
}
