/**
 * Tests for q-value-aware Accept-Encoding negotiation.
 *
 * Regression coverage for cloudflare/vinext#1981: the previous substring
 * `includes()` checks ignored RFC 9110 q-values, so an explicitly refused
 * codec (`br;q=0`) could still be served. These tests pin the q-aware behavior
 * of parseAcceptedEncodings, isEncodingAccepted, and negotiateEncoding.
 *
 * Wildcard semantics match Next.js's negotiator pipeline: an explicit q=0
 * refusal beats a wildcard `*` acceptance for the same token.
 */
import { describe, it, expect } from "vite-plus/test";
import type { IncomingMessage } from "node:http";
import {
  parseAcceptedEncodings,
  isEncodingAccepted,
  negotiateEncoding,
  HAS_ZSTD,
} from "../packages/vinext/src/server/accept-encoding.js";

function reqWith(acceptEncoding?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  return { headers } as unknown as IncomingMessage;
}

describe("parseAcceptedEncodings", () => {
  it("parses a plain comma-separated list", () => {
    const parsed = parseAcceptedEncodings("gzip, deflate, br");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
    expect(isEncodingAccepted(parsed, "deflate")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(true);
    expect(parsed.wildcard).toBe(false);
  });

  it("tracks explicit q=0 refusals", () => {
    const parsed = parseAcceptedEncodings("gzip, br;q=0");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
  });

  it("treats q=0.0 and q=0.000 as refusals", () => {
    expect(isEncodingAccepted(parseAcceptedEncodings("br;q=0.0"), "br")).toBe(false);
    expect(isEncodingAccepted(parseAcceptedEncodings("br;q=0.000"), "br")).toBe(false);
  });

  it("keeps tokens with a positive q-value", () => {
    const parsed = parseAcceptedEncodings("gzip;q=0.5, br;q=0.8");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(true);
  });

  it("tolerates whitespace around tokens and q params", () => {
    const parsed = parseAcceptedEncodings("  gzip ;  q = 0.5 , br ; q=0 ");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
  });

  it("matches tokens exactly, not by substring", () => {
    const parsed = parseAcceptedEncodings("brotli-future");
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
    expect(isEncodingAccepted(parsed, "brotli-future")).toBe(true);
  });

  it("drops tokens with malformed q-values", () => {
    expect(isEncodingAccepted(parseAcceptedEncodings("gzip;q=abc"), "gzip")).toBe(false);
    expect(isEncodingAccepted(parseAcceptedEncodings("gzip;q=1.5"), "gzip")).toBe(false);
    expect(isEncodingAccepted(parseAcceptedEncodings("gzip;q=0.1.2"), "gzip")).toBe(false);
  });

  it("tracks wildcard presence", () => {
    expect(parseAcceptedEncodings("*").wildcard).toBe(true);
    expect(parseAcceptedEncodings("gzip").wildcard).toBe(false);
    // Wildcard with q=0 is not a wildcard.
    expect(parseAcceptedEncodings("*;q=0").wildcard).toBe(false);
  });

  it("honors q=0 when followed by another ;param", () => {
    expect(isEncodingAccepted(parseAcceptedEncodings("br;q=0;foo=bar"), "br")).toBe(false);
  });

  it("honors q=0 when preceded by another ;param", () => {
    expect(isEncodingAccepted(parseAcceptedEncodings("br;foo=bar;q=0"), "br")).toBe(false);
  });

  it("accepts when no q param is present among other params", () => {
    expect(isEncodingAccepted(parseAcceptedEncodings("br;foo=bar"), "br")).toBe(true);
  });

  it("honors last q when multiple q params appear", () => {
    expect(isEncodingAccepted(parseAcceptedEncodings("br;q=0.5;q=0"), "br")).toBe(false);
    expect(isEncodingAccepted(parseAcceptedEncodings("gzip;q=0;q=0.5"), "gzip")).toBe(true);
  });
});

describe("isEncodingAccepted — wildcard interplay (matches Next.js negotiator)", () => {
  it("explicit refusal beats wildcard: *, br;q=0 → br is NOT accepted", () => {
    const parsed = parseAcceptedEncodings("*, br;q=0");
    expect(parsed.wildcard).toBe(true);
    expect(parsed.refused.has("br")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
  });

  it("wildcard accepts unmentioned tokens", () => {
    const parsed = parseAcceptedEncodings("*");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
    expect(isEncodingAccepted(parsed, "br")).toBe(true);
    expect(isEncodingAccepted(parsed, "deflate")).toBe(true);
  });

  it("explicit acceptance takes precedence over wildcard (redundant but safe)", () => {
    const parsed = parseAcceptedEncodings("*, gzip");
    expect(isEncodingAccepted(parsed, "gzip")).toBe(true);
  });

  it("returns false for tokens neither mentioned nor covered by wildcard", () => {
    const parsed = parseAcceptedEncodings("gzip");
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
  });

  it("explicit q=0 without wildcard keeps the token refused", () => {
    const parsed = parseAcceptedEncodings("br;q=0");
    expect(isEncodingAccepted(parsed, "br")).toBe(false);
  });
});

describe("negotiateEncoding", () => {
  it("returns null when no Accept-Encoding header is present", () => {
    expect(negotiateEncoding(reqWith(undefined))).toBe(null);
  });

  it("returns gzip for `gzip, br;q=0` (br explicitly refused)", () => {
    expect(negotiateEncoding(reqWith("gzip, br;q=0"))).toBe("gzip");
  });

  it("honors wildcard: `*` → picks highest available preference", () => {
    expect(negotiateEncoding(reqWith("*"))).toBe(HAS_ZSTD ? "zstd" : "br");
  });

  it("explicit refusal overrides wildcard: `*, br;q=0` → falls back to next preference", () => {
    expect(negotiateEncoding(reqWith("*, br;q=0"))).toBe(HAS_ZSTD ? "zstd" : "gzip");
  });

  it("returns gzip for `*;q=0, gzip` (wildcard refusal, explicit gzip)", () => {
    expect(negotiateEncoding(reqWith("*;q=0, gzip"))).toBe("gzip");
  });

  it("honors the zstd > br > gzip > deflate preference order", () => {
    expect(negotiateEncoding(reqWith("gzip, deflate, br"))).toBe("br");
    expect(negotiateEncoding(reqWith("gzip, deflate"))).toBe("gzip");
    expect(negotiateEncoding(reqWith("deflate"))).toBe("deflate");
  });

  it("falls back past a refused higher-preference codec", () => {
    expect(negotiateEncoding(reqWith("br;q=0, gzip, deflate"))).toBe("gzip");
  });

  it("returns null when every codec is refused", () => {
    expect(negotiateEncoding(reqWith("gzip;q=0, br;q=0, deflate;q=0"))).toBe(null);
  });

  it("does not false-match identity-only headers", () => {
    expect(negotiateEncoding(reqWith("identity"))).toBe(null);
    expect(negotiateEncoding(reqWith("identity;q=0"))).toBe(null);
  });

  if (HAS_ZSTD) {
    it("prefers zstd when accepted and supported", () => {
      expect(negotiateEncoding(reqWith("zstd, br, gzip"))).toBe("zstd");
    });

    it("skips refused zstd and picks br", () => {
      expect(negotiateEncoding(reqWith("zstd;q=0, br, gzip"))).toBe("br");
    });
  }
});
