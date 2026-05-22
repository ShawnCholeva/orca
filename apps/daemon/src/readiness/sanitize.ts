const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const REDACTIONS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{16,}/g,
  /sk-[A-Za-z0-9_\-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /ya29\.[A-Za-z0-9_\-]+/g,
  /AIza[A-Za-z0-9_\-]{20,}/g,
  /Bearer\s+[A-Za-z0-9_\-\.]+/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /([\?&#])(?:access_token|id_token|api_key|token|key|password)=[^\s&#]+/g,
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
  /\b[A-Za-z0-9_\-]{32,}\b/g,
];

const MAX_BYTES = 4096;
const TRUNC_SUFFIX = "…[truncated]";

export function sanitizeOutput(input: string | null | undefined): string {
  if (!input) return "";
  let out = input.replace(ANSI, "");
  if (Buffer.byteLength(out, "utf8") > MAX_BYTES) {
    const limitBytes = MAX_BYTES - Buffer.byteLength(TRUNC_SUFFIX, "utf8");
    const buf = Buffer.from(out, "utf8").subarray(0, limitBytes);
    // Decode with 'replacement' substitution so a half multi-byte char at the boundary
    // becomes U+FFFD instead of producing invalid output.
    out = new TextDecoder("utf-8", { fatal: false }).decode(buf) + TRUNC_SUFFIX;
  }
  for (const rx of REDACTIONS) {
    out = out.replace(rx, (match, p1) => {
      // Preserve the leading delimiter for URL-param patterns so the URL stays readable.
      if (p1 && (p1 === "?" || p1 === "&" || p1 === "#")) return `${p1}<redacted>`;
      return "<redacted>";
    });
  }
  return out;
}
