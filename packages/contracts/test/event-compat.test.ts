import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EvieEvent } from "../src/events.ts";

/**
 * An event that was written once has to decode forever.
 *
 * The event log is append-only and permanent, and the code that reads it keeps
 * changing. That makes every required field added to an existing event type a
 * time bomb, and one went off: `CheckpointWritten` gained `files`,
 * `insertions` and `deletions`, so every checkpoint recorded before that day
 * stopped decoding.
 *
 * What made it severe was where the read happens. Folding an aggregate decodes
 * its whole history, so one unreadable row from January meant every command
 * touching that aggregate failed -- and the org aggregate held every product
 * event in the organization, so no bot could be created at all. The user's
 * report was "I can't create new instances, and I can only talk to one of my
 * agents".
 *
 * The rule this file defends: a new field on an existing event is optional on
 * decode, with a default that is honest about not having been measured.
 */

const decode = Schema.decodeUnknownSync(EvieEvent);

describe("events written by an older build", () => {
  it("decodes a checkpoint from before the diff stats existed", () => {
    // Copied verbatim from a real row, written 2026-08-15.
    const stored = {
      _tag: "CheckpointWritten",
      threadId: "01M01A6NDV8D5F798BDR3HDFHP",
      turnId: "5GSGYQN5SP7XVT5C29CCG9RNDH",
      sha: "92c774aa5ce8e6ba7525a8a7b1bc63bd84ae6fce",
    };

    const event = decode(stored) as {
      files: number;
      insertions: number;
      deletions: number;
    };
    // Zero, which is what the `checkpoint` table's own migration chose for the
    // same rows: "we did not measure this one".
    expect(event.files).toBe(0);
    expect(event.insertions).toBe(0);
    expect(event.deletions).toBe(0);
  });

  it("keeps the stats a newer row does carry", () => {
    const event = decode({
      _tag: "CheckpointWritten",
      threadId: "01M01C46ZKX9GT28EFXEEK73ME",
      turnId: "6S458DVXN30G5E0YCBVENYEGP9",
      sha: "98c2fba396699ba7edec6037bb99ea440af29afd",
      files: 8,
      insertions: 1630,
      deletions: 0,
    }) as { files: number; insertions: number };

    expect(event.files).toBe(8);
    expect(event.insertions).toBe(1630);
  });

  it("still refuses a row that is wrong rather than merely old", () => {
    // Tolerance is for absent fields, not for nonsense in present ones.
    expect(() =>
      decode({
        _tag: "CheckpointWritten",
        threadId: "01M01C46ZKX9GT28EFXEEK73ME",
        turnId: "6S458DVXN30G5E0YCBVENYEGP9",
        sha: "98c2fba",
        files: "eight",
      }),
    ).toThrow();
  });
});
