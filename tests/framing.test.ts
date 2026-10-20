// Unit tests for framing (PLAN.md §5 lines 97-98): sentinel split across chunks, noise payloads, FIFO stacking. No network.
import { test } from "node:test";
import * as a from "node:assert";

import { FramingParser } from "../src/core/framing"; // module URI resolves to source; compiled layout keeps dist/tests -> dist/src/core ✓

const TOK = "ab12cd34";

test("sentinel split across chunk boundaries keeps unflushable tail", () => {
  const p = new FramingParser(TOK); // PLAN.md framing protocol §2 lines 56-59
  p.feed(Buffer.from("hello wor", "utf8")); if (p.tryPop() !== null) throw new Error("premature pop before terminator complete"); // line 58: token bytes split across chunk boundaries -> keep unflushable tail
  p.feed(Buffer.from("ld\x01Eab", "utf8")); if (p.tryPop() !== null) throw new Error("still incomplete mid-terminator");
  p.feed(Buffer.from("12cd34\x01rc=7\ntrailing-next", "utf8")); const r = p.tryPop(); a.ok(r !== null && r.text === "hello world" && r.rc === 7, `got ${JSON.stringify(r)}`); // everything before terminator is the command's output
  a.ok(p.partialText() === "trailing-next", "bytes after terminator kept for next pop");
});

test("payload noise: %s quotes CRLF tabs survive verbatim", () => {
  const canned = `a%sb 'q' "d"\r\ntab\t!\x01E${TOK}\x01rc=0\n`; // §5 line 98: output containing %, quotes, CRLF -> correct payload/rc extraction
  const p = new FramingParser(TOK); p.feed(Buffer.from(canned, "utf8")); const r = p.tryPop(); a.ok(r !== null && r.text === canned.split("\x01")[0] && r.rc === 0, `noise round-trip: ${JSON.stringify(r)}`);
});

test("back-to-back sentinels FIFO one-per-command", () => { // §2 line 61 edge case: consecutive sends -> buffer may hold two terminators; pop results in FIFO order keeping later payloads intact
  const p = new FramingParser(TOK); p.feed(Buffer.from(`first\x01E${TOK}\x01rc=0\nsecond\x01E${TOK}\x01rc=3\ntail`, "utf8"));
  const r1 = p.tryPop(); a.ok(r1 !== null && r1.text === "first" && r1.rc === 0, JSON.stringify(r1)); // §2 line 55: everything before it is the command's output; remove terminator on buffer
  const r2 = p.tryPop(); a.ok(r2 !== null && r2.text === "second" && r2.rc === 3, `FIFO order: ${JSON.stringify(r2)}`); a.ok(p.partialText() === "tail");
});

test("no terminator => null + partial grows for timeout shape", () => { // §2 line 60-61: never trust absence of sentinel; no-sentinel-within-timeout = failure with partial output (tested at session level in sessions_mock.test.ts)
  const p = new FramingParser(TOK); p.feed(Buffer.from("just output\x01Epartial", "utf8")); if (p.tryPop() !== null) throw new Error("false positive on incomplete terminator"); a.ok(p.partialText().indexOf("just output") === 0, "partial retrievable");
});
