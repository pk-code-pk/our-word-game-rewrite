import { describe, expect, it } from "vitest";
import { resolvePreferredAuthIdentifier } from "./SignInForm";

describe("resolvePreferredAuthIdentifier", () => {
  it("keeps the remembered identifier for the standard flow", () => {
    expect(resolvePreferredAuthIdentifier(false, "alice")).toBe("alice");
  });

  it("starts the guest-upgrade flow with a blank identifier", () => {
    expect(resolvePreferredAuthIdentifier(true, "guest-player")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(resolvePreferredAuthIdentifier(false, "  alice  ")).toBe("alice");
  });
});
