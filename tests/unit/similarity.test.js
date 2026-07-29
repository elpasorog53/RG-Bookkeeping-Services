import test from 'node:test';
import assert from 'node:assert/strict';
import { captionSimilarity } from '../../src/lib/similarity.js';

test('identical captions score 1.0', () => {
  const text = 'Quarterly estimated taxes are coming up soon for small business owners.';
  assert.equal(captionSimilarity(text, text), 1);
});

test('completely unrelated captions score 0 (or very close to it)', () => {
  const a = 'Quarterly estimated taxes are coming up soon for small business owners.';
  const b = 'Happy holidays from our whole bookkeeping team to yours this season.';
  assert.ok(captionSimilarity(a, b) < 0.15);
});

test('partial word overlap lands in the middle, not at the extremes', () => {
  const a = 'Reminder that quarterly estimated tax payments are due soon.';
  const b = 'Reminder that quarterly estimated tax payments are due next week.';
  const score = captionSimilarity(a, b);
  assert.ok(score > 0.5, `expected high overlap, got ${score}`);
  assert.ok(score < 1, 'not literally identical');
});

test('is case- and punctuation-insensitive', () => {
  const a = 'Quarterly Estimated Taxes are due soon!!!';
  const b = 'quarterly estimated taxes are due soon';
  assert.equal(captionSimilarity(a, b), 1);
});

test('short filler words do not inflate similarity between unrelated captions', () => {
  const a = 'The tax the for and are is';
  const b = 'The and for are is the tax';
  // All words are below the 4-char threshold and get filtered out entirely,
  // so there is nothing left to compare -- similarity must be 0, not 1.
  assert.equal(captionSimilarity(a, b), 0);
});

test('blank or missing captions score 0 rather than throwing', () => {
  assert.equal(captionSimilarity('', 'something here'), 0);
  assert.equal(captionSimilarity(null, undefined), 0);
});
