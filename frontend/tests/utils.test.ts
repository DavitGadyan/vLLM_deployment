import { describe, expect, it } from "vitest";

import { diffLines } from "@/components/config/version-history";
import { formatBytes, segmentAnswer } from "@/lib/utils";

describe("segmentAnswer", () => {
  it("splits citation markers out of the answer text", () => {
    const segments = segmentAnswer("Refunds take 30 days [1] and shipping is fast [2].");
    expect(segments).toEqual([
      { kind: "text", value: "Refunds take 30 days " },
      { kind: "citation", marker: 1 },
      { kind: "text", value: " and shipping is fast " },
      { kind: "citation", marker: 2 },
      { kind: "text", value: "." },
    ]);
  });

  it("leaves text without markers untouched", () => {
    expect(segmentAnswer("No citations here.")).toEqual([
      { kind: "text", value: "No citations here." },
    ]);
  });

  it("handles a marker at the very start", () => {
    const segments = segmentAnswer("[1] says refunds take 30 days.");
    expect(segments[0]).toEqual({ kind: "citation", marker: 1 });
  });

  it("does not treat bracketed non-numbers as citations", () => {
    expect(segmentAnswer("Use the [settings] menu")).toEqual([
      { kind: "text", value: "Use the [settings] menu" },
    ]);
  });
});

describe("diffLines", () => {
  it("reports no changes for identical prompts", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((row) => row.kind === "same")).toBe(true);
  });

  it("marks an inserted line as added", () => {
    const rows = diffLines("a\nc", "a\nb\nc");
    expect(rows).toEqual([
      { kind: "same", text: "a" },
      { kind: "added", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("marks a deleted line as removed", () => {
    const rows = diffLines("a\nb\nc", "a\nc");
    expect(rows.filter((row) => row.kind === "removed")).toEqual([
      { kind: "removed", text: "b" },
    ]);
  });

  it("represents a modified line as a removal plus an addition", () => {
    const rows = diffLines("refunds within 30 days", "refunds within 60 days");
    expect(rows).toEqual([
      { kind: "removed", text: "refunds within 30 days" },
      { kind: "added", text: "refunds within 60 days" },
    ]);
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
