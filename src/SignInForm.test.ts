import { describe, expect, it } from "vitest";
import { resolvePreferredAuthIdentifier } from "./SignInForm";

describe("resolvePreferredAuthIdentifier", () => {
  it("trims surrounding whitespace", () => {
    expect(resolvePreferredAuthIdentifier("  alice  ")).toBe("alice");
  });

  it("keeps the remembered identifier when one exists", () => {
    expect(resolvePreferredAuthIdentifier("guest-player")).toBe("guest-player");
  });

  it("returns an empty string when nothing is remembered", () => {
    expect(resolvePreferredAuthIdentifier("")).toBe("");
  });
});
