import { describe, expect, it } from "vitest";
import { resolvePreferredAuthIdentifier } from "./SignInForm";

describe("resolvePreferredAuthIdentifier", () => {
  it("prefers the remembered email when upgrading a guest session", () => {
    expect(resolvePreferredAuthIdentifier(true, "alice", "alice@example.com")).toBe("alice@example.com");
  });

  it("keeps the last typed identifier for regular sign-in flows", () => {
    expect(resolvePreferredAuthIdentifier(false, "alice", "alice@example.com")).toBe("alice");
  });

  it("falls back to whichever remembered value exists", () => {
    expect(resolvePreferredAuthIdentifier(true, "", "alice@example.com")).toBe("alice@example.com");
    expect(resolvePreferredAuthIdentifier(false, "", "alice@example.com")).toBe("alice@example.com");
    expect(resolvePreferredAuthIdentifier(true, "alice", "")).toBe("alice");
  });
});
