import { describe, expect, it } from "vitest";
import { resolveInviteJoinDisplayName } from "./SocialInbox";

describe("resolveInviteJoinDisplayName", () => {
  it("prefers the saved game display name when accepting an invite", () => {
    expect(resolveInviteJoinDisplayName("  ArenaNick  ", "AccountName")).toBe("ArenaNick");
  });

  it("falls back to the signed-in account username when the saved name is empty", () => {
    expect(resolveInviteJoinDisplayName("   ", "AccountName")).toBe("AccountName");
  });
});
