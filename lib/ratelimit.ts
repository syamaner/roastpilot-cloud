import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export type AbuseReason = "rate_limited" | "honeypot" | "fail_closed";

export type AbuseDecision =
  | { allowed: true }
  | { allowed: false; reason: AbuseReason; retryAfterSeconds?: number };

function failClosed(reason: string): AbuseDecision {
  console.error(JSON.stringify({ event: "ratelimit_fail_closed", reason }));
  return { allowed: false, reason: "fail_closed" };
}

export function checkHoneypot(
  honeypot: string | undefined,
): AbuseDecision {
  if (honeypot !== undefined && honeypot !== "") {
    return { allowed: false, reason: "honeypot" };
  }
  return { allowed: true };
}

export async function checkRateLimit(
  clientIp: string,
): Promise<AbuseDecision> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (
    redisUrl === undefined ||
    redisUrl.trim() === "" ||
    redisToken === undefined ||
    redisToken.trim() === ""
  ) {
    return failClosed("missing_upstash_config");
  }

  const pepper = process.env.REVIEW_IP_HASH_PEPPER;
  if (pepper === undefined || pepper.trim() === "") {
    return failClosed("missing_ip_hash_pepper");
  }

  try {
    const normalized = clientIp.trim().toLowerCase();
    if (isIP(normalized) === 0) {
      return failClosed("invalid_client_ip");
    }
    const identifier = createHmac("sha256", pepper)
      .update("ratelimit:v1:" + normalized)
      .digest("hex");
    const redis = Redis.fromEnv();
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, "10 m"),
      prefix: "rl:review",
    });
    const result = await ratelimit.limit(identifier);
    void result.pending?.catch(() => {});

    if (result.success) {
      // Only a genuine Redis-backed allow carries no reason; any success-shaped
      // library fallback (timeout today, or an unknown future fail-open reason)
      // must fail closed — the denial-of-wallet gate never admits on a fallback.
      if (result.reason !== undefined) {
        return failClosed(
          result.reason === "timeout"
            ? "upstash_timeout"
            : "upstash_unexpected_success",
        );
      }
      return { allowed: true };
    }

    const retryAfterSeconds = Math.max(
      0,
      Math.ceil((result.reset - Date.now()) / 1_000),
    );
    return { allowed: false, reason: "rate_limited", retryAfterSeconds };
  } catch {
    return failClosed("upstash_error");
  }
}
