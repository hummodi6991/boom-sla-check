import crypto from "node:crypto";
import { signResolve } from "../apps/shared/lib/resolveSign.js";

const RESOLVE_BASE_URL = process.env.RESOLVE_BASE_URL || process.env.APP_URL || "https://app.boomnow.com";
const RESOLVE_SECRET = process.env.RESOLVE_SECRET || "";

export async function resolveViaInternalEndpoint(idOrSlug) {
  if (!RESOLVE_SECRET) return null;
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const id = String(idOrSlug);
  const params = new URLSearchParams({ id, ts: String(ts), nonce });
  const sig = signResolve(id, ts, nonce, RESOLVE_SECRET);
  params.set("sig", sig);
  const base = RESOLVE_BASE_URL.endsWith("/") ? RESOLVE_BASE_URL.slice(0, -1) : RESOLVE_BASE_URL;
  const url = `${base}/api/internal/resolve-conversation?${params.toString()}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const { uuid } = await res.json();
    return /^[0-9a-f-]{36}$/i.test(uuid) ? uuid.toLowerCase() : null;
  } catch {
    return null;
  }
}
