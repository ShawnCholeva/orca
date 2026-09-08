/**
 * Quoting for the single command string tmux hands to `sh -c`.
 *
 * Shared on purpose: worker sessions and the orchestrator's shadow sessions
 * both build that string, and a security fix copied into two files is a fix
 * that gets missed in one of them next time.
 */

/**
 * Tokens that need no quoting at all. Deliberately narrow: a 1m model id like
 * "claude-opus-5[1m]" carries glob metacharacters ([ ]) that `sh -c` would try
 * to expand against the cwd, so anything outside this set gets quoted.
 */
const SAFE_UNQUOTED = /^[A-Za-z0-9_.:=/-]+$/;

/**
 * `sh` expands $(...) and backticks inside DOUBLE quotes, so JSON.stringify is
 * not shell quoting. Single quotes suppress every expansion; the only character
 * that needs care is a single quote itself, which is closed, escaped, reopened.
 */
function shellQuote(token: string): string {
  return SAFE_UNQUOTED.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Join tokens into one `sh -c` command string, each quoted as needed. */
export function shellCommand(tokens: string[]): string {
  return tokens.map(shellQuote).join(" ");
}
