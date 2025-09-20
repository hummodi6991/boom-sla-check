import crypto from "node:crypto";
import { signResolve } from "../apps/shared/lib/resolveSign.js";

function cleanBase(u) {
  return String(u || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/\/+$/, "");
}

function getResolveSecret() {
  return process.env.RESOLVE_SECRET || "";
}

function getResolveBaseUrl() {
  return cleanBase(
    process.env.RESOLVE_BASE_URL ||
      process.env.APP_URL ||
      "https://app.boomnow.com"
  );
}

export async function resolveViaInternalEndpoint(idOrSlug) {
  const secret = getResolveSecret();
  if (!secret) return null;
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const id = String(idOrSlug);
  const params = new URLSearchParams({ id, ts: String(ts), nonce });
  const sig = signResolve(id, ts, nonce, secret);
  params.set("sig", sig);
  const baseUrl = getResolveBaseUrl();
  const url = `${baseUrl}/api/internal/resolve-conversation?${params.toString()}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const { uuid } = await res.json();
    return /^[0-9a-f-]{36}$/i.test(uuid) ? uuid.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Detailed variant – returns { uuid, minted } so callers can avoid deep-linking to minted UUIDs.
export async function resolveViaInternalEndpointWithDetails(idOrSlug) {
  const secret = getResolveSecret();
  if (!secret) return null;
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const id = String(idOrSlug);
  const params = new URLSearchParams({ id, ts: String(ts), nonce });
  const sig = signResolve(id, ts, nonce, secret);
  params.set("sig", sig);
  const baseUrl = getResolveBaseUrl();
  const url = `${baseUrl}/api/internal/resolve-conversation?${params.toString()}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const json = await res.json();
    const uuid = /^[0-9a-f-]{36}$/i.test(json?.uuid)
      ? String(json.uuid).toLowerCase()
      : null;
    if (!uuid) return null;
    return { uuid, minted: Boolean(json?.minted) };
  } catch {
    return null;
  }
}
