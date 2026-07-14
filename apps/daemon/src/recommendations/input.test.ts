import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../db.js';
import { EventBus } from '../events.js';
import { createGoal } from '../goals.js';
import { runMigrations, defaultMigrationsDir } from '../migrations.js';
import type { Config } from '../config.js';
import { SkillRegistry } from '../registry/skill-registry.js';
import { quickGoalSkill } from '../skills/quick-goal.js';
import { buildRecommendationInput, resetPreparedStatements } from './input.js';
import { ModelProviderRegistry } from '../llm/registry.js';

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: 'silent',
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => 'test-token',
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-rec-input-'));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

async function seedGoal(
  db: Database.Database,
  intent = 'Build an authentication system'
): Promise<string> {
  const bus = new EventBus();
  const skills = new SkillRegistry();
  skills.register(quickGoalSkill);
  const inspectWorkspace = () => Promise.reject(new Error('not expected'));
  const goal = await createGoal(
    { title: 'Test Goal', intent },
    { db, bus, skills, modelProviderRegistry: new ModelProviderRegistry(), inspectWorkspace }
  );
  return goal.id;
}

afterEach(() => {
  resetPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    try {
      openDatabase(createConfig(dir));
      closeDatabase();
    } catch { /* already closed */ }
  }
});

describe('buildRecommendationInput', () => {
  it('returns valid input for an empty goal', async () => {
    const db = freshDb();
    const goalId = await seedGoal(db);

    const input = buildRecommendationInput({ db, goalId });

    expect(input.goalId).toBe(goalId);
    expect(input.objective).toBeDefined();
    expect(input.refinement).toBeNull();
    expect(input.workspaces).toEqual([]);
    expect(input.tasks).toEqual([]);
    expect(input.sessions).toEqual([]);
    expect(input.sessionSummaries).toEqual([]);
    expect(input.decisions).toEqual([]);
    expect(input.memoryItems).toEqual([]);
    expect(input.latestContextPackageId).toBeNull();
    expect(input.activeRecommendations).toEqual([]);
    expect(input.activeConflicts).toEqual([]);
    expect(input.recentFeedback).toEqual([]);
    expect(typeof input.inputFingerprint).toBe('string');
    expect(input.inputFingerprint.length).toBe(64); // sha256 hex
  });

  it('produces deterministic fingerprint for same state', async () => {
    const db = freshDb();
    const goalId = await seedGoal(db);

    const a = buildRecommendationInput({ db, goalId });
    const b = buildRecommendationInput({ db, goalId });

    expect(a.inputFingerprint).toBe(b.inputFingerprint);
  });

  it('fingerprint changes when trigger changes', async () => {
    const db = freshDb();
    const goalId = await seedGoal(db);

    const a = buildRecommendationInput({ db, goalId, trigger: 'manual' });
    const b = buildRecommendationInput({ db, goalId, trigger: 'session_completed' });

    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
  });

  it('throws GoalNotFoundError for unknown goal', () => {
    const db = freshDb();
    expect(() => buildRecommendationInput({ db, goalId: 'nonexistent' })).toThrow();
  });

  it('caps session summary body at 1024 chars', async () => {
    const db = freshDb();
    const goalId = await seedGoal(db);

    // Insert a long session summary directly (bypassing normal flow; FK off for fake IDs)
    const longText = 'x'.repeat(5000);
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO session_summaries (id, session_id, goal_id, extraction_id, headline, summary_text, truncated, source_offset_first, source_offset_last, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`
    ).run('sum-1', 'sess-fake', goalId, 'ext-fake', 'headline', longText, new Date().toISOString());
    db.pragma('foreign_keys = ON');

    const input = buildRecommendationInput({ db, goalId });
    for (const s of input.sessionSummaries) {
      expect(s.summaryText.length).toBeLessThanOrEqual(1024);
    }
  });

  it('does not include output-store or transcript references', async () => {
    // Static check: verify input.ts doesn't import forbidden modules
    const fs = await import('node:fs');
    const srcPath = new URL('./input.ts', import.meta.url).pathname;
    const src = fs.readFileSync(srcPath, 'utf8');
    expect(src).not.toContain('output-store');
    expect(src).not.toContain('transcript');
    expect(src).not.toContain('output_store');
  });
});

describe('tail isolation: recommendations modules do not import session output tails', () => {
  it('no output-store import in recommendations, orchestrator, tasks, conflicts', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const pathMod = require('node:path') as typeof import('node:path');
    const srcDir = new URL('..', import.meta.url).pathname;

    const dirsToCheck = ['recommendations', 'orchestrator', 'tasks', 'conflicts'];
    const forbidden = ['output-store', 'output_store', 'transcript'];

    for (const dir of dirsToCheck) {
      const dirPath = pathMod.join(srcDir, dir);
      let files: string[];
      try {
        files = (fs.readdirSync(dirPath) as string[]).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
      } catch {
        continue; // dir may not exist yet
      }
      for (const file of files) {
        const content = fs.readFileSync(pathMod.join(dirPath, file), 'utf8');
        for (const term of forbidden) {
          expect(content, `${dir}/${file} must not import ${term}`).not.toContain(term);
        }
      }
    }
  });
});
