// Test double for a live ssh process (PLAN.md §2 core/ tree): feeds canned byte streams through the Proc interface.
export class MockRunner {
  private perSendChunks: string[][]; // stdout chunks per send — tests pre-split them to straddle sentinels
  private stderrChunks: string[]; // ssh-client stderr noise, replayed on first write (auth errors etc.)
  private exitAfterWrites: number | undefined; // simulates process death after N writes (undefined = never)
  private exitCodeValue: number;

  private stdoutCbs: Array<(b: Buffer) => void> = [];
  private stderrCbs: Array<(b: Buffer) => void> = [];
  private exitCbs: Array<(code: number | null) => void> = [];
  private writes = 0;

  constructor(perSendChunks?: string[][], stderrChunks?: string[], exitAfterWrites?: number, exitCode?: number) {
    this.perSendChunks = perSendChunks ?? [];
    this.stderrChunks = stderrChunks ?? [];
    this.exitAfterWrites = exitAfterWrites;
    this.exitCodeValue = exitCode ?? 1;
  }

  write(s: string): void { // framed text ignored — the mock replays canned output by send index (mock_runner.ts role)
    const chunks = this.perSendChunks[this.writes] ?? [];
    this.writes++;
    if (this.writes === 1) for (const c of this.stderrChunks) for (const cb of this.stderrCbs) cb(Buffer.from(c, "utf8"));
    // utf8 re-encoding is safe here: \x01 control bytes encode 1:1; mid-multibyte chunk splits are covered by payload round-trip instead
    for (const c of chunks) for (const cb of this.stdoutCbs) cb(Buffer.from(c, "utf8"));
    if (this.exitAfterWrites !== undefined && this.writes >= this.exitAfterWrites) // exit fires after output so pending resolves before failPending
      for (const cb of this.exitCbs) cb(this.exitCodeValue);
  }

  kill(): void { /* no-op — session layer marks dead on hard timeout (PLAN.md §2 shortcut) */ }

  writeCount(): number { return this.writes; } // lets tests assert "does NOT write back" (§5 line 101 edit guard)

  onStdout(cb: (b: Buffer) => void): void { this.stdoutCbs.push(cb) }
  onStderr(cb: (b: Buffer) => void): void { this.stderrCbs.push(cb) }
  onExit(cb: (code: number | null) => void): void { this.exitCbs.push(cb) }
}
