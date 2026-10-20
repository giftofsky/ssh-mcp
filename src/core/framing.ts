// Sentinel-delimited framing over a byte stream (PLAN.md §2). One result per framed command, FIFO.

export class FramingParser {
  token: string; // hex, generated per session at spawn (PLAN.md line 49)
  private buf = Buffer.alloc(0);
  private searchFrom = 0; // rescan window keeps the unflushable tail across chunk splits (§2 lines 57-58)

  constructor(token: string) { this.token = token }

  feed(chunk: Buffer): void { if (chunk.length > 0) this.buf = Buffer.concat([this.buf, chunk]) } // accumulate bytes; decode only at pop time so multibyte chars split across chunks stay safe (§2 payload edge cases lines 57-63)

  private matchAt(s: number, marker: Buffer): boolean { for (let k = 0; k < marker.length; k++) if (this.buf[s + k] !== marker[k]) return false; return true } // byte-level scan — regex can't run on Buffers

  // Pop next complete result or null while terminator hasn't fully arrived.
  tryPop(): { text: string; rc: number } | null {
    const marker = Buffer.from(`\x01E${this.token}\x01rc=`, "utf8"); // terminator prefix per PLAN.md line 52 framing (hex token => fixed ASCII bytes)
    let from = Math.min(this.searchFrom, this.buf.length); const maxStart = this.buf.length - marker.length - 2; // need at least one digit + \n after the marker (§2 lines 60-61: never trust absence of sentinel)
    for (let s = from; s <= maxStart; s++) { if (!this.matchAt(s, marker)) continue; let d = s + marker.length; while (d < this.buf.length && this.buf[d] >= 0x30 && this.buf[d] <= 0x39) d++; // digit run after rc= (§2 line 52 printf %d => decimal digits only)
      if (d > s + marker.length && d < this.buf.length && this.buf[d] === 0x0a) { const rc = parseInt(this.buf.slice(s + marker.length, d).toString("ascii"), 10); // rc extraction from terminator's own digits (§2 line 55 printf '\001E%s\001rc=%d\n')
        const text = this.buf.slice(0, s).toString("utf8"); // everything before it is the command's output; full bytes -> multibyte/CRLF/NUL noise preserved (lines 57-63)
        this.buf = this.buf.slice(d + 1); this.searchFrom = 0; return { text, rc }; // remove token on buffer (§2 line 55)
      } else if (d >= this.buf.length && d > s + marker.length) break; // digit run hit stream end: terminator may continue in next feed — searchFrom below keeps that tail rescannable (§2 line 59)
    }
    this.searchFrom = Math.max(from, this.buf.length - marker.length - 16); // keep unflushable tail: next scan restarts where a sentinel could straddle across chunk boundaries (PLAN.md lines 58-59)
    return null; // no terminator yet — sessions.ts timeout path turns "no sentinel within timeout" into failure + partial output (§2 line 60 / §5 test bullet)
  }

  partialText(): string { return this.buf.toString("utf8") } // for timeout partial output (PLAN.md line 63)
}
