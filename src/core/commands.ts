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

export function buildCreate(token: string, path: string, content: string): string {
  const d = createDelim(token);
  const nl = content.length === 0 || content.endsWith("\n") ? "" : "\n"; // don't add a trailing newline twice (shortcut: CRLF content stays CRLF remote-side)
  return `cat > ${qpath(path)} <<'${d}'\n${content}${nl}${d}\n`; // quoted delim => no expansion in body
}

export function buildChecksum(path: string): string {
  const q = qpath(path);
  return `sha256sum ${q} 2>/dev/null || shasum -a 256 ${q} 2>/dev/null`; // GNU then BSD fallback
}

export function parseChecksum(line: string): string | null {
  const m = /^\s*([0-9a-f]{40,128})\s?\*?(\s|$)/m.exec(line);
  return m ? m[1] : null;
}

// grep builders. opts.rg picks ripgrep form; portable drops GNU-only flags (PLAN.md §6 dialect drift line 112).
export function buildGrep(pattern: string, path?: string, opts?: { rg?: boolean; includeGlob?: string; context?: number; portable?: boolean }): string {
  const p = shq(pattern);
  const target = path === undefined ? "." : qpath(path);
  if (opts?.rg) {
    let f = "--no-heading -n"; // line form matches the local-Grep contract (file:line:text); rg --json not needed for our parser
    if (opts.includeGlob) f += ` --glob ${shq(opts.includeGlob)}`;
    if (opts.context) f += ` -C ${Math.floor(opts.context!)}`;
    return `rg ${f} ${p} ${target}`;
  }
  let f = "-rnH"; // PLAN.md fallback form (line 79-80) — GNU grep only
  const port = opts?.portable === true; // BSD/busybox lack -H/--include/-C → server retries this portable form (§6 line 112)
  if (!port && opts?.context) f += ` -C ${Math.floor(opts.context!)}`;
  const inc = !port && opts?.includeGlob ? ` --include=${shq(opts.includeGlob!)}` : ""; // grep fallback uses --include= per spec (rg uses --glob above)
  return `grep ${f}${inc} ${p} ${target}`;
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
