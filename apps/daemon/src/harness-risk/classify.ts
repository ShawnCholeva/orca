import type { RiskClass, PermissionTier } from "@orca/contracts";

export type Classification = {
  riskClass: RiskClass;
  permissionTier: PermissionTier;
  reasons: string[];
  hardConstraintViolations: string[];
};

const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

// Bash command patterns, cheapest checks first. Order matters: a critical match wins.
const CRITICAL_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, reason: "destructive recursive delete (rm -rf)" },
  { re: /\b(mkfs|dd\s+if=|:\(\)\s*\{)/, reason: "destructive disk/forkbomb operation" },
  { re: /(^|\s)(>|>>)\s*\/(etc|dev|sys|proc)\b/, reason: "write to a protected system path" },
  { re: /(?:^|\s)~\/\.ssh\b|\/\.aws\/credentials\b|\.env\b|\bid_rsa\b/, reason: "access to a secret/credential file" },
];
const FULL_ACCESS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/, reason: "network access" },
  { re: /\bgit\s+push\b/, reason: "git history / remote mutation" },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, reason: "package publish" },
  { re: /\b(docker\s+push|kubectl|terraform\s+apply|gcloud|aws)\b/, reason: "deployment / cloud control" },
  { re: /\bsudo\b/, reason: "privilege escalation" },
];

function classifyBash(command: string): Classification {
  const cmd = command.trim();
  for (const p of CRITICAL_PATTERNS) {
    if (p.re.test(cmd)) {
      return { riskClass: "critical", permissionTier: "full_access", reasons: [`bash: ${p.reason}`], hardConstraintViolations: [`bash: ${p.reason}`] };
    }
  }
  const reasons: string[] = [];
  for (const p of FULL_ACCESS_PATTERNS) {
    if (p.re.test(cmd)) reasons.push(`bash: ${p.reason}`);
  }
  if (reasons.length > 0) {
    return { riskClass: "high", permissionTier: "full_access", reasons, hardConstraintViolations: [] };
  }
  return { riskClass: "medium", permissionTier: "sandbox_edit", reasons: ["bash: local command"], hardConstraintViolations: [] };
}

export function classifyToolAction(input: { toolName: string; toolInput: unknown }): Classification {
  const { toolName } = input;
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { riskClass: "low", permissionTier: "read_only", reasons: [`${toolName}: read-only`], hardConstraintViolations: [] };
  }
  if (toolName === "Bash") {
    const command =
      input.toolInput && typeof input.toolInput === "object" && "command" in input.toolInput
        ? String((input.toolInput as { command: unknown }).command ?? "")
        : "";
    return classifyBash(command);
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { riskClass: "medium", permissionTier: "sandbox_edit", reasons: [`${toolName}: workspace edit`], hardConstraintViolations: [] };
  }
  // Unknown / MCP / other tools: conservative middle tier.
  return { riskClass: "medium", permissionTier: "sandbox_edit", reasons: [`${toolName}: unclassified tool`], hardConstraintViolations: [] };
}
