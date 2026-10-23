// A scripted stand-in for a coding agent, used by record.mjs. It runs as a
// VS Code task in the demo workspace, waits for the recorder's go file, then
// writes a few edits across files much faster than anyone could type them.
import * as fs from 'node:fs';
import * as path from 'node:path';

const [goFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const coupons = `export interface Coupon {
  code: string;
  percentOff: number;
}

export function findCoupon(code: string, coupons: Coupon[]): Coupon | undefined {
  return coupons.find((c) => c.code === code.trim().toUpperCase());
}
`;

const totalFn = `
export function total(items: Item[], coupon?: Coupon): number {
  const amount = subtotal(items);
  return coupon ? amount * (1 - coupon.percentOff / 100) : amount;
}
`;

const totalTest = `
test('total applies a coupon', () => {
  const coupon = { code: 'TEA10', percentOff: 10 };
  assert.equal(total(items, coupon), 27);
});
`;

const steps = [
  ['write', 'src/coupons.ts', () => coupons],
  ['edit', 'src/cart.ts', (s) => `import { Coupon } from './coupons';\n\n${s}${totalFn}`],
  ['edit', 'test/cart.test.ts', (s) => s.replace('{ subtotal }', '{ subtotal, total }') + totalTest],
  ['edit', 'src/cart.ts', (s) => s.replaceAll('amount', 'gross')],
];

while (goFile && !fs.existsSync(goFile)) await sleep(100);

console.log('demo agent: "add coupon support to the cart"\n');
const started = Date.now();
for (const [verb, file, change] of steps) {
  const abs = path.join(process.cwd(), file);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  fs.writeFileSync(abs, change(before));
  console.log(`  ${verb.padEnd(6)} ${file}`);
  await sleep(450);
}
console.log(`\ndone: ${steps.length} changes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
