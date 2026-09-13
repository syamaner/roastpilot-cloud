import { isIP } from "node:net";

// Vercel overwrites both headers rather than forwarding client-supplied values,
// so x-real-ip and the leftmost x-forwarded-for entry identify the connecting
// client here. This depends on Vercel (or an equivalent header-overwriting
// proxy); a future non-Vercel or appending-proxy deployment must revisit this,
// because either value could then be attacker-controlled.
export function extractClientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp !== undefined && isIP(realIp) !== 0) {
    return realIp;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  const leftmost = forwardedFor?.split(",", 1)[0]?.trim();
  if (leftmost !== undefined && isIP(leftmost) !== 0) {
    return leftmost;
  }

  return "";
}
