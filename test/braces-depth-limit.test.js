import test from 'node:test';
import assert from 'node:assert/strict';
import braces from 'braces';

test('installed braces preserves normal expansion and the nesting boundary', () => {
  assert.deepEqual(braces('{a,b,c}'), ['(a|b|c)']);
  assert.deepEqual(braces('{a,b,c}', { expand: true }), ['a', 'b', 'c']);
  assert.doesNotThrow(() => braces.compile(`${'{'.repeat(100)}x${'}'.repeat(100)}`));
});

test('installed braces rejects deep brace and parenthesis ASTs before recursion', () => {
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    for (const depth of [101, 4900]) {
      const pattern = `${open.repeat(depth)}x${close.repeat(depth)}`;
      assert.throws(() => braces.compile(pattern), { name: 'SyntaxError' });
      assert.throws(() => braces.expand(pattern), { name: 'SyntaxError' });
    }
  }
});
