import { describe, expect, it } from "vitest";
import { sanitizeOutput } from "./sanitize.js";

describe("sanitizeOutput", () => {
  it("returns empty string for null/undefined input", () => {
    expect(sanitizeOutput(undefined)).toBe("");
    expect(sanitizeOutput(null)).toBe("");
  });

  it("strips ANSI escape sequences", () => {
    expect(sanitizeOutput("\u001b[31mERROR\u001b[0m message")).toBe("ERROR message");
  });

  it("truncates output to 4 KB", () => {
    const big = "a".repeat(5000);
    const out = sanitizeOutput(big);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("redacts Anthropic sk- keys", () => {
    expect(sanitizeOutput("token=sk-ant-api03-AbCdEfGhIjKlMnOpQrSt")).toContain("<redacted>");
  });

  it("redacts generic sk- keys", () => {
    expect(sanitizeOutput("key=sk-1234567890ABCDEFGH")).toContain("<redacted>");
  });

  it("redacts GitHub PATs (ghp_/gho_/ghs_)", () => {
    expect(sanitizeOutput("ghp_AAAAAAAAAAAAAAAAAAAA1234")).toContain("<redacted>");
    expect(sanitizeOutput("gho_AAAAAAAAAAAAAAAAAAAA1234")).toContain("<redacted>");
    expect(sanitizeOutput("ghs_AAAAAAAAAAAAAAAAAAAA1234")).toContain("<redacted>");
  });

  it("redacts Google OAuth (ya29.) and API keys (AIza...)", () => {
    expect(sanitizeOutput("ya29.A0AfH6SMABCDEFG")).toContain("<redacted>");
    expect(sanitizeOutput("AIzaSyA1234567890ABCDEFGHIJ")).toContain("<redacted>");
  });

  it("redacts Bearer tokens", () => {
    expect(sanitizeOutput("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")).toContain(
      "<redacted>",
    );
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----";
    expect(sanitizeOutput(pem)).toContain("<redacted>");
    expect(sanitizeOutput(pem)).not.toContain("ABC");
  });

  it("redacts URL auth query params", () => {
    expect(sanitizeOutput("https://api.example/path?access_token=xyz&foo=bar")).toContain(
      "<redacted>",
    );
  });

  it("redacts email addresses", () => {
    expect(sanitizeOutput("Hello user@example.com today")).toContain("<redacted>");
    expect(sanitizeOutput("Hello user@example.com today")).not.toContain("user@example.com");
  });

  it("redacts high-entropy 32+ char tokens", () => {
    expect(sanitizeOutput("token=abcdefghijklmnopqrstuvwxyz12345678")).toContain("<redacted>");
  });

  it("does not redact normal short words", () => {
    const text = "Codex is not logged in. Please run codex login.";
    expect(sanitizeOutput(text)).toBe(text);
  });
});
