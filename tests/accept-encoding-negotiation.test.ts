/**
 * Tests for q-value-aware Accept-Encoding negotiation.
 *
 * Regression coverage for cloudflare/vinext#1981: the previous substring
 * `includes()` checks ignored RFC 9110 q-values, so an explicitly refused
 * codec (`br;q=0`) could still be served. These tests pin the q-aware behavior
 * of both parseAcceptedEncodings and negotiateEncoding.
 */
import { describe, it, expect } from "vite-plus/test";
import type { IncomingMessage } from "node:http";
import zlib from "node:zlib";
import {
  parseAcceptedEncodings,
  negotiateEncoding,
} from "../packages/vinext/src/server/prod-server.js";

const HAS_ZSTD = typeof zlib.createZstdCompress === "function";

function reqWith(acceptEncoding?: string): IncomingMessage {
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  return { headers } as unknown as IncomingMessage;
}

describe("parseAcceptedEncodings", () => {
  it("parses a plain comma-separated list", () => {
    const accepted = parseAcceptedEncodings("gzip, deflate, br");
    expect(accepted.has("gzip")).toBe(true);
    expect(accepted.has("deflate")).toBe(true);
    expect(accepted.has("br")).toBe(true);
  });

  it("excludes tokens explicitly refused with q=0", () => {
    const accepted = parseAcceptedEncodings("gzip, br;q=0");
    expect(accepted.has("gzip")).toBe(true);
    expect(accepted.has("br")).toBe(false);
  });

  it("treats q=0.0 and q=0.000 as refusals", () => {
    expect(parseAcceptedEncodings("br;q=0.0").has("br")).toBe(false);
    expect(parseAcceptedEncodings("br;q=0.000").has("br")).toBe(false);
  });

  it("keeps tokens with a positive q-value", () => {
    const accepted = parseAcceptedEncodings("gzip;q=0.5, br;q=0.8");
    expect(accepted.has("gzip")).toBe(true);
    expect(accepted.has("br")).toBe(true);
  });

  it("tolerates whitespace around tokens and q params", () => {
    const accepted = parseAcceptedEncodings("  gzip ;  q = 0.5 , br ; q=0 ");
    expect(accepted.has("gzip")).toBe(true);
    expect(accepted.has("br")).toBe(false);
  });

  it("matches tokens exactly, not by substring", () => {
    // "br" must not be implied by an unrelated token.
    const accepted = parseAcceptedEncodings("brotli-future");
    expect(accepted.has("br")).toBe(false);
    expect(accepted.has("brotli-future")).toBe(true);
  });

  it("drops tokens with malformed q-values", () => {
    expect(parseAcceptedEncodings("gzip;q=abc").has("gzip")).toBe(false);
    expect(parseAcceptedEncodings("gzip;q=1.5").has("gzip")).toBe(false);
    expect(parseAcceptedEncodings("gzip;q=0.1.2").has("gzip")).toBe(false);
  });

  it("honors q=0 when followed by another ;param", () => {
    // q=0 is a refusal even when other params trail it.
    expect(parseAcceptedEncodings("br;q=0;foo=bar").has("br")).toBe(false);
  });

  it("honors q=0 when preceded by another ;param", () => {
    // q=0 at the end of multi-param list is still a refusal.
    expect(parseAcceptedEncodings("br;foo=bar;q=0").has("br")).toBe(false);
  });

  it("accepts when no q param is present among other params", () => {
    // Absence of any q= param defaults to q=1.
    expect(parseAcceptedEncodings("br;foo=bar").has("br")).toBe(true);
  });

  it("honors last q when multiple q params appear", () => {
    // Last q wins (per RFC 9110 weight parameter semantics).
    expect(parseAcceptedEncodings("br;q=0.5;q=0").has("br")).toBe(false);
    expect(parseAcceptedEncodings("gzip;q=0;q=0.5").has("gzip")).toBe(true);
  });

  it("preserves the wildcard token", () => {
    expect(parseAcceptedEncodings("*").has("*")).toBe(true);
    expect(parseAcceptedEncodings("*;q=0").has("*")).toBe(false);
  });
});

describe("negotiateEncoding", () => {
  it("returns null when no Accept-Encoding header is present", () => {
    expect(negotiateEncoding(reqWith(undefined))).toBe(null);
  });

  it("returns gzip for `gzip, br;q=0` (br explicitly refused)", () => {
    expect(negotiateEncoding(reqWith("gzip, br;q=0"))).toBe("gzip");
  });

  it("returns gzip for `*;q=0, gzip` (wildcard refusal does not suppress explicit gzip)", () => {
    expect(negotiateEncoding(reqWith("*;q=0, gzip"))).toBe("gzip");
  });

  it("honors the zstd > br > gzip > deflate preference order", () => {
    expect(negotiateEncoding(reqWith("gzip, deflate, br"))).toBe("br");
    expect(negotiateEncoding(reqWith("gzip, deflate"))).toBe("gzip");
    expect(negotiateEncoding(reqWith("deflate"))).toBe("deflate");
  });

  it("falls back past a refused higher-preference codec", () => {
    // br refused → next acceptable is gzip even though br appears in the header.
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
