import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal } from '../src/cart';

const items = [
  { sku: 'mug', price: 12, qty: 2 },
  { sku: 'tea', price: 6, qty: 1 },
];

test('subtotal adds every line', () => {
  assert.equal(subtotal(items), 30);
});
