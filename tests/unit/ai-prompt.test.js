import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBrandVoiceBlock,
  platformGuidanceLine,
  parseAiJson,
  parseAiJsonArray,
} from '../../src/lib/ai-prompt.js';

test('buildBrandVoiceBlock includes only the fields that are actually set', () => {
  const block = buildBrandVoiceBlock({ business_name: 'RG Bookkeeping', tone: 'warm and direct' });
  assert.match(block, /Business name: RG Bookkeeping/);
  assert.match(block, /Preferred tone\/voice: warm and direct/);
  assert.doesNotMatch(block, /Services offered/);
});

test('buildBrandVoiceBlock falls back to a generic instruction when nothing is configured', () => {
  const block = buildBrandVoiceBlock(null);
  assert.match(block, /No brand voice details are configured yet/);
});

test('platformGuidanceLine summarizes character limits, or returns null with no platforms', () => {
  assert.equal(platformGuidanceLine([]), null);
  const line = platformGuidanceLine([{ label: 'Facebook', char_soft_limit: 480, char_hard_limit: 63206 }]);
  assert.match(line, /Facebook \(soft ~480, hard 63206\)/);
});

test('parseAiJson accepts a plain JSON object and normalizes missing fields', () => {
  const result = parseAiJson('{"caption": "hi"}');
  assert.equal(result.caption, 'hi');
  assert.equal(result.hashtags, '');
  assert.equal(result.cta, null);
  assert.equal(result.needsReview, false);
});

test('parseAiJson strips a ```json code fence some models add despite instructions', () => {
  const result = parseAiJson('```json\n{"caption": "fenced"}\n```');
  assert.equal(result.caption, 'fenced');
});

test('parseAiJson rejects garbage and a bare array', () => {
  assert.throws(() => parseAiJson('not json'), /could not be parsed/);
  assert.throws(() => parseAiJson('[1,2,3]'), /could not be parsed/);
});

test('parseAiJsonArray parses and truncates to the expected count', () => {
  const arr = JSON.stringify([{ caption: 'a' }, { caption: 'b' }, { caption: 'c' }]);
  const result = parseAiJsonArray(arr, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].caption, 'a');
});

test('parseAiJsonArray rejects a bare object and an empty array', () => {
  assert.throws(() => parseAiJsonArray('{"caption":"a"}', 3), /could not be parsed/);
  assert.throws(() => parseAiJsonArray('[]', 3), /could not be parsed/);
});
