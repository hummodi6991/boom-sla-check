import crypto from "node:crypto";
import { signResolve } from "../apps/shared/lib/resolveSign.js";

const cleanBase = (u) =>
  String(u || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/\/+$/, "");
export async function resolveViaInternalEndpoint(idOrSlug) {
  const secret = process.env.RESOLVE_SECRET || "";
  if (!secret) return null;
  const base = cleanBase(process.env.RESOLVE_BASE_URL || process.env.APP_URL || "https://app.boomnow.com");
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const id = String(idOrSlug);
  const params = new URLSearchParams({ id, ts: String(ts), nonce });
  const sig = signResolve(id, ts, nonce, secret);
  params.set("sig", sig);
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
