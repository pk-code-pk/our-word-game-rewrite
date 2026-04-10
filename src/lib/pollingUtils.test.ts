import { describe, expect, it } from "vitest";
import { deepEqualJson, stabilizeJsonValue } from "./pollingUtils";

describe("deepEqualJson", () => {
  it("treats matching JSON-like values as equal", () => {
    expect(
      deepEqualJson(
        {
          id: "game-1",
          players: [
            { id: "p1", guesses: ["ABCD", "EFGH"] },
            { id: "p2", guesses: [] },
          ],
        },
        {
          id: "game-1",
          players: [
            { id: "p1", guesses: ["ABCD", "EFGH"] },
            { id: "p2", guesses: [] },
          ],
        }
      )
    ).toBe(true);
  });

  it("detects nested differences", () => {
    expect(
      deepEqualJson(
        {
          id: "game-1",
          players: [{ id: "p1", guesses: ["ABCD"] }],
        },
        {
          id: "game-1",
          players: [{ id: "p1", guesses: ["WXYZ"] }],
        }
      )
    ).toBe(false);
  });
});

describe("stabilizeJsonValue", () => {
  it("reuses the previous reference when payloads are equal", () => {
    const previous = {
      game: {
        id: "game-1",
        status: "active",
      },
      guesses: [
        {
          id: "guess-1",
          text: "WORD",
        },
      ],
    };
    const next = {
      game: {
        id: "game-1",
        status: "active",
      },
      guesses: [
        {
          id: "guess-1",
          text: "WORD",
        },
      ],
    };

    const stabilized = stabilizeJsonValue(previous, next);

    expect(stabilized).toBe(previous);
  });

  it("returns the new reference when payloads change", () => {
    const previous = { value: 1 };
    const next = { value: 2 };

    expect(stabilizeJsonValue(previous, next)).toBe(next);
  });
});
