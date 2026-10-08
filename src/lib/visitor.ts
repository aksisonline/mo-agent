// A fixed, signed lifetime: reading the cookie never extends its expiry.
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 90 * 86400;
export const HTTPS_VISITOR_COOKIE = "__Host-mo-visitor";
export const LOCAL_VISITOR_COOKIE = "mo-visitor";
export const MAX_COOKIE_HEADER_BYTES = 8192;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function visitorIdentity(request: Request, env: Env, now = Date.now()) {
  const secret: unknown = "VISITOR_COOKIE_SECRET" in env ? env.VISITOR_COOKIE_SECRET : undefined;
  if (typeof secret !== "string" || encoder.encode(secret).length < 32 || secret.length > 4096)
    throw new Error("Visitor secret unavailable");
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const localDevSetting: unknown = env.ACCESS_LOCAL_DEV;
  const localDev = localDevSetting === true || localDevSetting === "true";
  if (!secure && !(localDev && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("Insecure visitor transport");
  const name = secure ? HTTPS_VISITOR_COOKIE : LOCAL_VISITOR_COOKIE;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const raw = request.headers.get("Cookie") ?? "";
  const values =
    raw.length <= MAX_COOKIE_HEADER_BYTES && encoder.encode(raw).length <= MAX_COOKIE_HEADER_BYTES
      ? raw
          .split(";")
          .filter((part) => part.trim().startsWith(`${name}=`))
          .map((part) => part.trim().slice(name.length + 1))
      : [];
  if (values.length === 1 && values[0].length <= 180) {
    const [version, visitorId, expiry, signature, extra] = values[0].split(".");
    const expiresAt = Number(expiry);
    if (
      version === "v1" &&
      uuid.test(visitorId ?? "") &&
      /^\d{10,13}$/.test(expiry ?? "") &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > now &&
      expiresAt <= now + VISITOR_COOKIE_MAX_AGE_SECONDS * 1000 &&
      /^[0-9a-f]{64}$/.test(signature ?? "") &&
      extra === undefined
    ) {
      const bytes = Uint8Array.from(signature.match(/../g)!, (byte) => parseInt(byte, 16));
      if (
        await crypto.subtle.verify(
          "HMAC",
          key,
          bytes,
          encoder.encode(`${name}:v1.${visitorId}.${expiry}`),
        )
      )
        return { visitorId, cookie: undefined };
    }
  }
  const visitorId = crypto.randomUUID();
  const payload = `v1.${visitorId}.${now + VISITOR_COOKIE_MAX_AGE_SECONDS * 1000}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${name}:${payload}`)),
  );
  const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    visitorId,
    cookie: `${name}=${payload}.${hex}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  };
}
