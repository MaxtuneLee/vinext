import zlib from "node:zlib";
import { type IncomingMessage } from "node:http";

type ContentEncoding = "zstd" | "br" | "gzip" | "deflate";
export type NegotiatedEncoding = ContentEncoding | "identity" | null;

/** Parsed explicit coding qualities plus the wildcard quality, when present. */
export type ParsedAcceptEncoding = {
  qualities: Map<string, number>;
  wildcardQuality: number | null;
  implicitIdentityQuality: number;
};

const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Parse an Accept-Encoding header into exact-token numeric qualities. */
export function parseAcceptedEncodings(accept: string): ParsedAcceptEncoding {
  const qualities = new Map<string, number>();
  let wildcardQuality: number | null = null;
  let implicitIdentityQuality = 1;

  for (const part of accept.toLowerCase().split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const semi = trimmed.indexOf(";");
    const token = (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
    if (token.length === 0) continue;

    let quality = 1;
    if (semi !== -1) {
      let qStr: string | undefined;
      for (const param of trimmed.slice(semi + 1).split(";")) {
        const eq = param.indexOf("=");
        if (eq === -1 || param.slice(0, eq).trim() !== "q") continue;
        qStr = param.slice(eq + 1).trim();
      }
      if (qStr !== undefined) {
        if (!Q_VALUE.test(qStr)) continue;
        quality = Number.parseFloat(qStr);
      }
    }

    if (token === "*") {
      wildcardQuality = Math.max(wildcardQuality ?? 0, quality);
    } else {
      qualities.set(token, Math.max(qualities.get(token) ?? 0, quality));
    }
    implicitIdentityQuality = Math.min(implicitIdentityQuality, quality || 1);
  }

  return { qualities, wildcardQuality, implicitIdentityQuality };
}

/** Return the effective quality for a coding, including wildcard/identity rules. */
export function getEncodingQuality(parsed: ParsedAcceptEncoding, encoding: string): number {
  const normalized = encoding.toLowerCase();
  const explicit = parsed.qualities.get(normalized);
  if (explicit !== undefined) return explicit;
  if (parsed.wildcardQuality !== null) return parsed.wildcardQuality;
  if (normalized === "identity") return parsed.implicitIdentityQuality;
  return 0;
}

export function isEncodingAccepted(parsed: ParsedAcceptEncoding, encoding: string): boolean {
  return getEncodingQuality(parsed, encoding) > 0;
}

/** Choose the highest-quality available coding, using array order as the tie-breaker. */
export function selectAcceptedEncoding<T extends string>(
  parsed: ParsedAcceptEncoding,
  available: readonly T[],
): T | null {
  let selected: T | null = null;
  let selectedQuality = 0;
  for (const encoding of available) {
    const quality = getEncodingQuality(parsed, encoding);
    if (quality > selectedQuality) {
      selected = encoding;
      selectedQuality = quality;
    }
  }
  return selected;
}

export const HAS_ZSTD = typeof zlib.createZstdCompress === "function";

/** Select by client q-value first, then zstd > br > gzip > deflate > identity. */
export function negotiateEncoding(req: IncomingMessage): NegotiatedEncoding {
  const accept = req.headers["accept-encoding"];
  if (typeof accept !== "string") return "identity";
  const parsed = parseAcceptedEncodings(accept);
  return selectAcceptedEncoding(parsed, [
    ...(HAS_ZSTD ? (["zstd"] as const) : []),
    "br",
    "gzip",
    "deflate",
    "identity",
  ]);
}
