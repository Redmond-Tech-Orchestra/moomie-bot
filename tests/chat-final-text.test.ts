import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseRepeatedFinalText } from '../src/features/chat/final-text.js';

test('collapses exact duplicated final replies', () => {
  const reply = 'Sure thing - which action item do you want me to update? If you mean the one we were just discussing, I can move its target date to Oct 26 right away.';

  assert.equal(collapseRepeatedFinalText(`${reply}${reply}`), reply);
});

test('collapses paragraph-level duplicated final replies', () => {
  const reply = [
    'I can do that - I just need to know which item IDs you mean by "those items."',
    'Paste the IDs and I will move them to the 11-1 event.',
  ].join('\n\n');

  assert.equal(collapseRepeatedFinalText(`${reply}\n\n${reply}`), reply);
});

test('preserves non-global repetition inside normal replies', () => {
  const reply = 'Done - I moved items 198-208 to Origins.\n\nSummary:\n- Moved 11 items to Origins: #198-#208\n\nMoo!';

  assert.equal(collapseRepeatedFinalText(reply), reply);
});
