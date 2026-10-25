// Gallery Thing — cross-device state sync
//
// One function backing the "saved / seen / hidden" state Josh's devices
// share. State lives in a single Netlify Blobs key ("josh") in a site-wide
// store, guarded by a personal key (GALLERY_KEY env var) that never touches
// Git. See gallery/PROJECT_BRIEF.md and the Build 2 handoff for the design.
//
// `handleRequest` takes the store as a parameter so it can be unit-tested
// with a fake in-memory store (no live Netlify Blobs access needed) — the
// default export below is the only place that calls the real getStore().

import { getStore } from "@netlify/blobs";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

export const config = { path: "/gallery/api/state" };

const STORE_NAME = "gallery-state";
const STATE_KEY = "josh";
const MAX_OPS = 100;
const MAX_STRING_LEN = 200;
const VALID_OPS = new Set(["save", "unsave", "seen", "unseen", "hide", "unhide"]);

function emptyState() {
  return { saved: [], seen: [], hidden: [], updatedAt: null };
}

function isValidKeyString(v) {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING_LEN;
}

// Validates the whole ops array up front so a bad op never partially
// mutates state. Returns an error string, or null if everything is valid.
function validateOps(ops) {
  if (!Array.isArray(ops)) return "ops must be an array";
  if (ops.length > MAX_OPS) return `ops exceeds max of ${MAX_OPS}`;
  for (const op of ops) {
    if (!op || typeof op !== "object") return "each op must be an object";
    if (!VALID_OPS.has(op.op)) return `invalid op "${op.op}"`;
    if (!isValidKeyString(op.key)) return "op.key must be a string ≤ 200 chars";
    if (op.op === "hide") {
      if (!isValidKeyString(op.gallery)) return "hide op.gallery must be a string ≤ 200 chars";
      if (!isValidKeyString(op.title)) return "hide op.title must be a string ≤ 200 chars";
    }
  }
  return null;
}

// Applies ops in order to state. Pure and idempotent — safe to re-run the
// same op twice (e.g. a retried flush after a dropped response).
function applyOps(state, ops) {
  const saved = new Set(state.saved);
  const seen = new Set(state.seen);
  const hidden = new Map(state.hidden.map((h) => [h.key, h]));

  for (const op of ops) {
    switch (op.op) {
      case "save":
        saved.add(op.key);
        break;
      case "unsave":
        saved.delete(op.key);
        break;
      case "seen":
        seen.add(op.key);
        break;
      case "unseen":
        seen.delete(op.key);
        break;
      case "hide":
        hidden.set(op.key, { key: op.key, gallery: op.gallery, title: op.title, at: new Date().toISOString() });
        break;
      case "unhide":
        hidden.delete(op.key);
        break;
    }
  }

  return {
    saved: [...saved],
    seen: [...seen],
    hidden: [...hidden.values()],
    updatedAt: new Date().toISOString(),
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Constant-time string compare so a wrong key can't be brute-forced via
// response-timing differences.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still compare against something of bufA's length so the failure
    // path takes comparable time regardless of the guess's length.
    nodeTimingSafeEqual(bufA, bufA);
    return false;
  }
  return nodeTimingSafeEqual(bufA, bufB);
}

async function handleRequest(request, { store, galleryKey }) {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  if (!galleryKey) {
    return jsonResponse({ error: "not configured" }, 503);
  }

  const providedKey = request.headers.get("X-Gallery-Key") || "";
  if (!providedKey || !timingSafeEqual(providedKey, galleryKey)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    const state = (await store.get(STATE_KEY, { type: "json" })) || emptyState();
    return jsonResponse(state, 200);
  }

  // POST
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const validationError = validateOps(body && body.ops);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  // Read-modify-write. @netlify/blobs has no conditional-write (only-if-match)
  // primitive on set/setJSON in this version, so this is last-write-wins —
  // acceptable per the Build 2 plan since Josh's devices don't write in the
  // same second.
  const current = (await store.get(STATE_KEY, { type: "json" })) || emptyState();
  const next = applyOps(current, body.ops);
  await store.setJSON(STATE_KEY, next);

  return jsonResponse(next, 200);
}

export default async (request) => {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  return handleRequest(request, { store, galleryKey: process.env.GALLERY_KEY });
};

export { handleRequest, applyOps, validateOps, emptyState };
