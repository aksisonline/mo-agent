export const IP_BURST_ATTEMPTS = 30;
export const IP_BURST_WINDOW_MS = 60000;
export const IP_BURST_MAX_KEYS = 4096;

function normalizedIp(value: string | null): string | undefined {
  if (!value || value.length > 45) return;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split(".");
    if (parts.every((part) => Number(part) <= 255 && String(Number(part)) === part)) return value;
    return;
  }
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return;
  try {
    // URL parsing validates and canonicalizes IPv6, including equivalent compressed forms.
    return new URL(`http://[${value}]/`).hostname;
  } catch {
    return;
  }
}

export function burstKey(request: Request): string {
  // cf is runtime metadata, not a browser header. Direct/non-Cloudflare requests share a bucket.
  // Never trust XFF, user-agent, location or an arbitrary CF-Connecting-IP on a direct route.
  if (new URL(request.url).protocol === "https:" && "cf" in request && request.cf)
    return normalizedIp(request.headers.get("CF-Connecting-IP")) ?? "anonymous";
  return "anonymous";
}

// Operational burst protection only: isolates do not share state and eviction resets this map.
// ACCESS is the sole durable authority for quota and concurrency. At capacity fail closed,
// rather than evicting active buckets and allowing attackers to reset them.
export function createIpBurstLimiter(now: () => number = Date.now, maxKeys = IP_BURST_MAX_KEYS) {
  const attempts = new Map<string, number[]>();
  return (key: string): boolean => {
    const time = now();
    for (const [ip, stamps] of attempts) {
      const live = stamps.filter((stamp) => stamp > time - IP_BURST_WINDOW_MS);
      if (live.length) attempts.set(ip, live);
      else attempts.delete(ip);
    }
    const stamps = attempts.get(key);
    if (!stamps && attempts.size >= maxKeys) return false;
    const live = stamps ?? [];
    if (live.length >= IP_BURST_ATTEMPTS) return false;
    live.push(time);
    attempts.set(key, live);
    return true;
  };
}
