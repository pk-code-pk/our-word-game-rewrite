import { beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { db, initDb } from "./db.js";
import {
  checkAuthRouteThrottle,
  resetAuthThrottleState,
  type AuthThrottleOptions,
  type AuthThrottleAction,
} from "./authRateLimit.js";

function createMockRequest({
  ip,
  headers,
}: {
  ip?: string;
  headers?: Request["headers"];
} = {}) {
  return {
    ip,
    headers: headers ?? {},
    socket: {
      remoteAddress: ip,
    },
  } as Request;
}

function getThrottleRow(action: AuthThrottleAction, ip: string) {
  return db
    .prepare(
      `SELECT action, ip, window_started_at, attempts, blocked_until, updated_at
       FROM auth_route_throttle
       WHERE action = ? AND ip = ?`
    )
    .get(action, ip) as
    | {
        action: AuthThrottleAction;
        ip: string;
        window_started_at: number;
        attempts: number;
        blocked_until: number;
        updated_at: number;
      }
    | undefined;
}

describe("auth rate limits", () => {
  beforeEach(() => {
    initDb();
    resetAuthThrottleState();
  });

  it("allows requests up to the configured limit and then blocks with a retry hint", () => {
    let now = 1_000;
    const request = createMockRequest({ ip: "198.51.100.10" });
    const options: AuthThrottleOptions = {
      now: () => now,
      overrides: { signup: { limit: 2, windowMs: 1_000, blockMs: 2_000 } },
    };

    const first = checkAuthRouteThrottle(request, "signup", options);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(first.attempts).toBe(1);
    expect(first.resetAt).toBe(2_000);
    expect(getThrottleRow("signup", "198.51.100.10")?.attempts).toBe(1);

    now += 100;
    const second = checkAuthRouteThrottle(request, "signup", options);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(second.attempts).toBe(2);
    expect(getThrottleRow("signup", "198.51.100.10")?.attempts).toBe(2);

    now += 100;
    const third = checkAuthRouteThrottle(request, "signup", options);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBe(2_000);
    expect(third.retryAfterSeconds).toBe(2);
    expect(third.message).toContain("sign up");
    expect(third.message).toContain("Try again");

    now = 2_500;
    const stillBlocked = checkAuthRouteThrottle(request, "signup", options);
    expect(stillBlocked.allowed).toBe(false);
    expect(stillBlocked.retryAfterMs).toBe(700);

    now = 3_300;
    const afterCooldown = checkAuthRouteThrottle(request, "signup", options);
    expect(afterCooldown.allowed).toBe(true);
    expect(afterCooldown.remaining).toBe(1);
    expect(afterCooldown.attempts).toBe(1);
  });

  it("keeps signup, signin, and anonymous buckets isolated for the same IP", () => {
    const request = createMockRequest({ ip: "203.0.113.8" });
    const options: AuthThrottleOptions = {
      now: () => 10_000,
      overrides: {
        signup: { limit: 1, windowMs: 10_000, blockMs: 20_000 },
        signin: { limit: 1, windowMs: 10_000, blockMs: 20_000 },
        anonymous: { limit: 1, windowMs: 10_000, blockMs: 20_000 },
      },
    };

    expect(checkAuthRouteThrottle(request, "signup", options).allowed).toBe(true);
    expect(checkAuthRouteThrottle(request, "signin", options).allowed).toBe(true);
    expect(checkAuthRouteThrottle(request, "anonymous", options).allowed).toBe(true);

    expect(checkAuthRouteThrottle(request, "signup", options).allowed).toBe(false);
    expect(checkAuthRouteThrottle(request, "signin", options).allowed).toBe(false);
    expect(checkAuthRouteThrottle(request, "anonymous", options).allowed).toBe(false);

    expect(getThrottleRow("signup", "203.0.113.8")?.attempts).toBe(1);
    expect(getThrottleRow("signin", "203.0.113.8")?.attempts).toBe(1);
    expect(getThrottleRow("anonymous", "203.0.113.8")?.attempts).toBe(1);
  });

  it("resolves the client IP from x-forwarded-for before falling back to req.ip", () => {
    const request = createMockRequest({
      ip: "127.0.0.1",
      headers: {
        "x-forwarded-for": "198.51.100.25, 10.0.0.7",
      },
    });

    const decision = checkAuthRouteThrottle(request, "signin", {
      now: () => 50_000,
      overrides: { signin: { limit: 1, windowMs: 10_000, blockMs: 20_000 } },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.ip).toBe("198.51.100.25");
    expect(getThrottleRow("signin", "198.51.100.25")?.attempts).toBe(1);
    expect(getThrottleRow("signin", "127.0.0.1")).toBeUndefined();
  });
});
