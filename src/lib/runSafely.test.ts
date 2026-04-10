import { describe, expect, it, vi } from "vitest";
import { runSafely } from "./runSafely";

describe("runSafely", () => {
  it("returns the action result when it succeeds", async () => {
    await expect(runSafely(async () => "ok", vi.fn())).resolves.toBe("ok");
  });

  it("swallows errors and notifies the caller", async () => {
    const onError = vi.fn();
    const result = await runSafely(async () => {
      throw new Error("boom");
    }, onError);

    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not rethrow if the error handler fails", async () => {
    const result = await runSafely(async () => {
      throw new Error("boom");
    }, () => {
      throw new Error("toast failed");
    });

    expect(result).toBeUndefined();
  });
});
