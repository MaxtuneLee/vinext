import zlib from "node:zlib";
import { type IncomingMessage } from "node:http";

/**
 * Result of parsing an Accept-Encoding header.
 *
 * Matches Next.js's negotiator semantics: an explicit q=0 refusal beats a
 * wildcard `*` acceptance for the same token.  Calling code uses
 * `isEncodingAccepted(parsed, token)` to resolve the interplay.
 */
type ParsedAcceptEncoding = {
  /** Tokens the client explicitly accepts (no params, q>0, or q absent). */
  accepted: Set<string>;
  /** Tokens the client explicitly refused with q=0. */
  refused: Set<string>;
  /** True if the header contains `*` with q>0 (or q absent). */
  wildcard: boolean;
};

/**
 * Parse an Accept-Encoding header, honoring RFC 9110 q-values.
 *
 * - No parameters or no q param → default q=1 (accepted).
 * - `q=0` → explicit refusal (stored in `refused`).
 * - `*` wildcard tracked separately so explicit refusals can override it.
 * - Malformed q-values cause the token to be dropped (treated as not accepted),
 *   matching the conservative behavior of Next.js's negotiator-based pipeline.
 *
 * @param accept original Accept-Encoding header value from the client request
 */
export function parseAcceptedEncodings(accept: string): ParsedAcceptEncoding {
  const result: ParsedAcceptEncoding = {
    accepted: new Set(),
    refused: new Set(),
    wildcard: false,
  };
  for (const part of accept.toLowerCase().split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const semi = trimmed.indexOf(";");
    const token = (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
    if (token.length === 0) continue;

    // No parameters → default q=1.
    if (semi === -1) {
      if (token === "*") result.wildcard = true;
      else result.accepted.add(token);
      continue;
    }

    // Scan all `;`-separated params for a q param.  Per RFC 9110 the q param
    // can appear anywhere among the params (e.g. `br;foo=bar;q=0`).  Last q
    // wins if repeated.
    let qStr: string | undefined;
    for (const param of trimmed.slice(semi + 1).split(";")) {
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      if (param.slice(0, eq).trim() !== "q") continue;
      qStr = param.slice(eq + 1).trim();
    }

    // No q param present → default q=1.
    if (qStr === undefined) {
      if (token === "*") result.wildcard = true;
      else result.accepted.add(token);
      continue;
    }

    // Valid q-value is 0-1 with up to 3 decimals; reject anything malformed.
    if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(qStr)) continue;

    if (parseFloat(qStr) === 0) {
      // Explicit refusal.  Even if `*` is also present, this token is out.
      result.refused.add(token);
    } else if (token === "*") {
      result.wildcard = true;
    } else {
      result.accepted.add(token);
    }
  }
  return result;
}

/**
 * Test whether a specific encoding token is accepted, respecting the interplay
 * between wildcard and explicit refusals — same semantics as Next.js's
 * negotiator `specify` + `isQuality` pipeline:
 *
 * 1. Explicit acceptance wins (q>0 on the exact token).
 * 2. Explicit refusal wins over the wildcard (q=0 on the exact token).
 * 3. Wildcard `*` with q>0 accepts any unmentioned token.
 * 4. Otherwise the token is not accepted.
 */
export function isEncodingAccepted(parsed: ParsedAcceptEncoding, encoding: string): boolean {
  const enc = encoding.toLowerCase();
  if (parsed.accepted.has(enc)) return true; // explicit q>0
  if (parsed.refused.has(enc)) return false; // explicit q=0 beats wildcard
  return parsed.wildcard; // no explicit mention → wildcard
}

/**
 * Parse the Accept-Encoding header and return the best supported encoding.
 * Preference order: zstd > br > gzip > deflate > identity.
 *
 * zstd decompresses ~3-5x faster than brotli at similar compression ratios.
 * Supported in Chrome 123+, Firefox 126+. Safari can decompress but doesn't
 * send zstd in Accept-Encoding, so it transparently falls back to br/gzip.
 */
export const HAS_ZSTD = typeof zlib.createZstdCompress === "function";

export function negotiateEncoding(req: IncomingMessage): "zstd" | "br" | "gzip" | "deflate" | null {
  const accept = req.headers["accept-encoding"];
  if (!accept || typeof accept !== "string") return null;
  const parsed = parseAcceptedEncodings(accept);
  // Preference order: zstd > br > gzip > deflate.
  if (HAS_ZSTD && isEncodingAccepted(parsed, "zstd")) return "zstd";
  if (isEncodingAccepted(parsed, "br")) return "br";
  if (isEncodingAccepted(parsed, "gzip")) return "gzip";
  if (isEncodingAccepted(parsed, "deflate")) return "deflate";
  return null;
}
