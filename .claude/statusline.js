#!/usr/bin/env node

const fs = require("fs");

const input = fs.readFileSync(0, "utf8");
let data = {};
try {
  data = input.trim() ? JSON.parse(input) : {};
} catch {
  data = {};
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(100, number(value)));
}

function colorForUsage(value) {
  const pct = clamp(value);
  if (pct >= 90) return RED;
  if (pct >= 80) return ORANGE;
  if (pct >= 60) return YELLOW;
  return GREEN;
}

function paint(text, color) {
  return `${color}${text}${RESET}`;
}

function usage(label, value) {
  const pct = clamp(value);
  return `${label} ${paint(`${Math.round(pct)}%`, colorForUsage(pct))}`;
}

function resetIn(value) {
  if (!value) return "";
  const ms = value * 1000 - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return " now";

  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return ` ${hours}h${minutes.toString().padStart(2, "0")}m`;
  return ` ${minutes}m`;
}

const contextPct = clamp(data.context_window?.used_percentage);
const fiveHourPct = clamp(data.rate_limits?.five_hour?.used_percentage);
const weeklyPct = clamp(data.rate_limits?.seven_day?.used_percentage);
const pressure = Math.max(contextPct, fiveHourPct, weeklyPct);

const model = data.model?.display_name || data.model?.id || "unknown model";
const effort = data.effort?.level || "no effort";
const cwd = data.workspace?.current_dir || data.cwd || "";
const dir = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : "";

const modelLabel = paint(model, `${BOLD}${colorForUsage(pressure)}`);
const effortLabel = paint(`effort ${effort}`, colorForUsage(pressure));

const parts = [
  modelLabel,
  effortLabel,
  usage("ctx", contextPct),
  `${usage("5h", fiveHourPct)}${paint(resetIn(data.rate_limits?.five_hour?.resets_at), DIM)}`,
  `${usage("week", weeklyPct)}${paint(resetIn(data.rate_limits?.seven_day?.resets_at), DIM)}`,
];

if (dir) {
  parts.push(paint(dir, CYAN));
}

console.log(parts.join(paint(" | ", DIM)));
