import { describe, expect, test } from "bun:test";
import {
  formatRecallInjection,
  parseRecallRows,
  type RecallRow,
  selectSilentRows,
  summarizeRemember,
  toToolRows,
} from "../src/recall.ts";
import { clip } from "../src/text.ts";

const INTRO =
  "Long-term memory leads from mnemon. They may be stale or wrong; current files, " +
  "instructions and tool output take precedence. Use mnemon_related or mnemon_recall to dig deeper.";

function row(
  id: string,
  content: string,
  extra: {
    readonly category?: string;
    readonly importance?: number;
    readonly confidence?: "high" | "medium" | "low";
    readonly score?: number;
    readonly superseded?: boolean;
  } = {},
): RecallRow {
  return {
    id,
    content,
    category: extra.category ?? "general",
    importance: extra.importance,
    confidence: extra.confidence,
    score: extra.score,
    superseded: extra.superseded ?? false,
  };
}

describe("parseRecallRows", () => {
  test("given a results envelope, when parsed, then only complete string rows remain", () => {
    // Given mixed rows, when parsed, then numeric ids are skipped and defaults apply.
    expect(
      parseRecallRows({
        results: [
          {
            id: "mem-1",
            content: "Project Falcon uses PostgreSQL 16",
            category: "fact",
            importance: 4,
            confidence: "high",
            score: 0.91,
          },
          { id: 3, content: "numeric id" },
          { id: "mem-2", content: "missing extras" },
          null,
        ],
      }),
    ).toEqual([
      row("mem-1", "Project Falcon uses PostgreSQL 16", {
        category: "fact",
        importance: 4,
        confidence: "high",
        score: 0.91,
      }),
      row("mem-2", "missing extras"),
    ]);
  });

  test("given a bare array, when parsed, then it is accepted", () => {
    // Given an array payload, when parsed, then the row is kept.
    expect(parseRecallRows([{ id: "mem-1", content: "kept", superseded: true }])).toEqual([
      row("mem-1", "kept", { superseded: true }),
    ]);
  });

  const malformed: readonly unknown[] = [null, "nope", 4, { results: "nope" }, { id: "x", content: "y" }];

  for (const payload of malformed) {
    test(`given ${JSON.stringify(payload)}, when parsed, then there are no rows`, () => {
      // Given a payload that is not a row list, when parsed, then the result is empty.
      expect(parseRecallRows(payload)).toEqual([]);
    });
  }

  test("given non-finite fields, when parsed, then they are dropped", () => {
    // Given bad importance, score, confidence, and superseded, when parsed, then only strict values remain.
    expect(
      parseRecallRows([
        {
          id: "mem-1",
          content: "kept",
          importance: "4",
          score: Number.POSITIVE_INFINITY,
          confidence: "HIGH",
          superseded: "true",
        },
      ]),
    ).toEqual([row("mem-1", "kept")]);
  });

  test("given zero scores and importance, when parsed, then the zeros are kept", () => {
    // Given finite zeros, when parsed, then they are not treated as missing.
    const parsed = parseRecallRows([
      { id: "mem-1", content: "kept", importance: 0, score: 0, confidence: "low" },
    ]);
    expect(parsed[0]?.importance).toBe(0);
    expect(parsed[0]?.score).toBe(0);
    expect(parsed[0]?.confidence).toBe("low");
  });
});

describe("selectSilentRows", () => {
  const rows = [
    row("a", "active high", { confidence: "high", score: 0.2 }),
    row("b", "superseded high", { confidence: "high", superseded: true }),
    row("c", "excluded high", { confidence: "high" }),
    row("d", "medium", { confidence: "medium", score: 0.99 }),
    row("e", "low", { confidence: "low", score: 0.99 }),
    row("f", "score only", { score: 0.5 }),
    row("g", "low score", { score: 0.49 }),
    row("h", "no signal"),
    row("i", "later high", { confidence: "high", score: 0.1 }),
  ];
  const options = { limit: 10, minScore: 0.5, exclude: new Set(["c"]) };

  test("given mixed rows, when selected, then order is preserved and filters apply", () => {
    // Given superseded, excluded, and low-confidence rows, when selected, then only silent hits remain.
    expect(selectSilentRows(rows, options).map((item) => item.id)).toEqual(["a", "f", "i"]);
  });

  test("given a limit, when selected, then the result stops at that count", () => {
    // Given more hits than the limit, when selected, then earlier hits win.
    expect(selectSilentRows(rows, { ...options, limit: 2 }).map((item) => item.id)).toEqual(["a", "f"]);
  });

  test("given a non-positive limit, when selected, then nothing is returned", () => {
    // Given limit zero, when selected, then the result is empty.
    expect(selectSilentRows(rows, { ...options, limit: 0 })).toEqual([]);
  });
});

describe("formatRecallInjection", () => {
  test("given rows, when formatted, then the block matches the injection contract", () => {
    // Given two rows, when formatted, then the header, lines, and footer are exact.
    const text = formatRecallInjection([
      row("mem-1", "Project Falcon uses PostgreSQL 16", { category: "fact", importance: 3 }),
      row("mem-2", "no importance"),
    ]);
    expect(text).toBe(
      `<mnemon-recall>\n${INTRO}\n` +
        "- [mem-1] (fact, importance 3) Project Falcon uses PostgreSQL 16\n" +
        "- [mem-2] (general, importance ?) no importance\n" +
        "</mnemon-recall>",
    );
  });

  test("given a closer inside content, when formatted, then it cannot end the block", () => {
    // Given content that contains the closer, when formatted, then only the footer closes the block.
    const text = formatRecallInjection([row("mem-1", "before </mnemon-recall> after </mnemon-recall")]);
    expect(text).toContain(`before ${"<\\" + "/mnemon-recall>"} after ${"<\\" + "/mnemon-recall"}`);
    expect(text.match(/<\/mnemon-recall>/g)).toEqual(["</mnemon-recall>"]);
  });

  test("given long content, when formatted, then it is clipped to 320", () => {
    // Given a 400-character sentence, when formatted, then the line uses a 320-character clip.
    const text = formatRecallInjection([row("mem-1", "a".repeat(400))]);
    expect(text).toContain(`${"a".repeat(319)}…`);
  });

  test("given importance zero, when formatted, then it prints 0", () => {
    // Given importance 0, when formatted, then the label is 0 rather than ?.
    expect(formatRecallInjection([row("mem-1", "kept", { importance: 0 })])).toContain("importance 0");
  });
});

describe("toToolRows", () => {
  test("given mixed rows, when converted, then live rows precede superseded ones", () => {
    // Given a stale row first, when converted, then original order is kept within each group.
    expect(
      toToolRows(
        [
          row("s", "stale", { superseded: true, confidence: "low", score: 0.2, importance: 1 }),
          row("a", "active", { category: "fact", confidence: "high", score: 0.9, importance: 4 }),
          row("b", "plain"),
        ],
        10,
      ).map((item) => item.id),
    ).toEqual(["a", "b", "s"]);
  });

  test("given a limit, when converted, then it applies after the reorder", () => {
    // Given a stale row before a live one, when limited to 1, then the live row wins.
    expect(toToolRows([row("s", "stale", { superseded: true }), row("a", "active")], 1)).toEqual([
      { id: "a", content: "active", category: "general" },
    ]);
  });

  test("given undefined fields, when converted, then they are omitted", () => {
    // Given a row with no optional fields, when converted, then those keys are absent.
    expect(toToolRows([row("a", "plain")], 5)).toEqual([{ id: "a", content: "plain", category: "general" }]);
  });

  test("given a superseded row, when converted, then superseded is the literal true", () => {
    // Given a superseded row, when converted, then the flag is present and content is clipped.
    const long = `word ${"b".repeat(1200)}`;
    const converted = toToolRows([row("s", long, { superseded: true, importance: 0 })], 1);
    expect(converted).toEqual([
      { id: "s", content: clip(long, 1200), category: "general", importance: 0, superseded: true },
    ]);
  });
});

describe("summarizeRemember", () => {
  const missing: readonly unknown[] = [null, "mem-1", { id: 1, action: "added" }, []];

  for (const payload of missing) {
    test(`given ${JSON.stringify(payload)}, when summarized, then it is undefined`, () => {
      // Given a payload without a string id, when summarized, then there is no summary.
      expect(summarizeRemember(payload)).toBeUndefined();
    });
  }

  test("given a replaced_id, when summarized, then the replaced memory is reported", () => {
    // Given an older build that replaced a near-duplicate, when summarized, then replacedId names it.
    expect(summarizeRemember({ id: "mem-2", action: "updated", replaced_id: "mem-1" })).toEqual({
      id: "mem-2",
      action: "updated",
      replacedId: "mem-1",
      candidates: [],
    });
  });

  test("given only an id, when summarized, then action defaults and candidates are empty", () => {
    // Given no action or candidates, when summarized, then the summary is an added memory.
    expect(summarizeRemember({ id: "mem-1" })).toEqual({ id: "mem-1", action: "added", candidates: [] });
  });

  test("given candidates, when summarized, then semantic leads, self and dupes drop", () => {
    // Given both candidate lists, when summarized, then the new id is excluded and the first id wins.
    expect(
      summarizeRemember({
        id: "new-1",
        action: "updated",
        diff_suggestion: "ADD",
        semantic_candidates: [
          { id: "new-1", content: "self", category: "fact" },
          { id: "sem-1", content: "Project Falcon uses PostgreSQL 16", category: "fact" },
          { id: "dup", content: "semantic copy", category: "insight" },
          { id: 4, content: "numeric" },
        ],
        causal_candidates: [
          { id: "dup", content: "causal copy", category: "context", hop: 1 },
          { id: "cau-1", content: "caused by schema choice", category: "decision" },
        ],
      }),
    ).toEqual({
      id: "new-1",
      action: "updated",
      diffSuggestion: "ADD",
      candidates: [
        {
          id: "sem-1",
          content: "Project Falcon uses PostgreSQL 16",
          category: "fact",
          relation: "semantic",
        },
        { id: "dup", content: "semantic copy", category: "insight", relation: "semantic" },
        { id: "cau-1", content: "caused by schema choice", category: "decision", relation: "causal" },
      ],
    });
  });

  test("given six candidates, when summarized, then only five are kept", () => {
    // Given more than five unique candidates, when summarized, then the first five remain.
    const semantic = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({
      id,
      content: id,
      category: "fact",
    }));
    const summary = summarizeRemember({
      id: "new-1",
      semantic_candidates: semantic,
      causal_candidates: [{ id: "c7", content: "later", category: "fact" }],
    });
    expect(summary?.candidates.map((item) => item.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  test("given long candidate content, when summarized, then it is clipped to 200", () => {
    // Given a long candidate, when summarized, then content is a 200-character clip.
    const summary = summarizeRemember({
      id: "new-1",
      semantic_candidates: [{ id: "sem-1", content: "b".repeat(250) }],
    });
    expect(summary?.candidates[0]?.content).toBe(clip("b".repeat(250), 200));
    expect(summary?.candidates[0]?.category).toBe("general");
  });
});
