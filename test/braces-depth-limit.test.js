import test from 'node:test';
import assert from 'node:assert/strict';
import braces from '../vendor/braces/index.js';

test('bounded braces parser preserves normal compile and expand behavior', () => {
  assert.deepEqual(braces('{a,b,c}'), ['(a|b|c)']);
  assert.deepEqual(braces('{a,b,c}', { expand: true }), ['a', 'b', 'c']);
  assert.doesNotThrow(() => braces.compile(`${'{'.repeat(100)}x${'}'.repeat(100)}`));
});

test('brace and parenthesis AST nesting above 100 fails before recursive walkers', () => {
  const nestedBraces = `${'{'.repeat(101)}x${'}'.repeat(101)}`;
  const nestedParens = `${'('.repeat(101)}x${')'.repeat(101)}`;
  for (const pattern of [nestedBraces, nestedParens]) {
    assert.throws(() => braces.compile(pattern), {
      name: 'SyntaxError',
      message: 'Input nesting exceeds maximum depth (100)',
    });
    assert.throws(() => braces.expand(pattern), {
      name: 'SyntaxError',
      message: 'Input nesting exceeds maximum depth (100)',
    });
  }
});
