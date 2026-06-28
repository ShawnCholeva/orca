import { test, expect } from 'vitest';
import { uuidv7 } from './ids.js';

test('v7 ids sort in creation order, even within one millisecond', () => {
  const ids = Array.from({ length: 5000 }, () => uuidv7(1_700_000_000_000));
  expect([...ids].sort()).toEqual(ids); // lexical sort == mint order
  expect(new Set(ids).size).toBe(ids.length); // still unique
});

test('later milliseconds always sort after earlier ones', () => {
  const early = uuidv7(1_700_000_000_000);
  const late = uuidv7(1_700_000_000_001);
  expect(early < late).toBe(true);
});

test('shape is a valid version-7 variant-2 uuid', () => {
  expect(uuidv7(1_700_000_000_000)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
