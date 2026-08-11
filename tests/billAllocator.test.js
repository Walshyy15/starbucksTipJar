const assert = require('assert');
const BillAllocator = require('../billAllocator');

function billsValue(bills) {
  return bills.twenties * 20 + bills.tens * 10 + bills.fives * 5 + bills.ones;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('finds exact global allocation and preserves partner order', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 22 },
    { name: 'B', wholeDollarPayout: 22 }
  ];
  const inventory = { twenties: 1, tens: 2, fives: 0, ones: 4 };

  const result = BillAllocator.allocateBills(partners, inventory);

  assert.strictEqual(result.exact, true);
  assert.deepStrictEqual(result.allocation.map(item => item.paid), [22, 22]);
  assert.deepStrictEqual(result.allocation.map(item => item.shortfall), [0, 0]);
  assert.strictEqual(result.allocation[0].breakdown.ones, 2);
  assert.strictEqual(result.allocation[1].breakdown.ones, 2);
});

test('minimizes total one-dollar bills before one-dollar imbalance', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 20 },
    { name: 'B', wholeDollarPayout: 22 }
  ];
  const inventory = { twenties: 2, tens: 2, fives: 0, ones: 4 };

  const result = BillAllocator.allocateBills(partners, inventory);
  const onesCounts = result.allocation.map(item => item.breakdown.ones);

  assert.strictEqual(result.exact, true);
  assert.deepStrictEqual(onesCounts, [0, 2]);
  assert.strictEqual(onesCounts.reduce((sum, count) => sum + count, 0), 2);
});

test('does not mutate partners or inventory', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 22 },
    { name: 'B', wholeDollarPayout: 12 }
  ];
  const inventory = { twenties: 1, tens: 1, fives: 0, ones: 4 };
  const partnersBefore = clone(partners);
  const inventoryBefore = clone(inventory);

  BillAllocator.allocateBills(partners, inventory);

  assert.deepStrictEqual(partners, partnersBefore);
  assert.deepStrictEqual(inventory, inventoryBefore);
});

test('reports leftover bills while preserving exact payouts', () => {
  const partners = [{ name: 'A', wholeDollarPayout: 10 }];
  const inventory = { twenties: 0, tens: 1, fives: 1, ones: 0 };

  const result = BillAllocator.allocateBills(partners, inventory);

  assert.strictEqual(result.exact, true);
  assert.strictEqual(result.allocation[0].paid, 10);
  assert.strictEqual(billsValue(result.leftoverBills), 5);
  assert.deepStrictEqual(result.leftoverBills, { twenties: 0, tens: 0, fives: 1, ones: 0 });
});

test('returns found exact allocation when combination limit prevents proving optimality', () => {
  const partners = [{ name: 'A', wholeDollarPayout: 20 }];
  const inventory = { twenties: 1, tens: 2, fives: 0, ones: 20 };

  const result = BillAllocator.allocateBills(partners, inventory, {
    limits: { maxCombinationsPerPartner: 1 }
  });

  assert.strictEqual(result.exact, true);
  assert.strictEqual(result.allocation[0].paid, 20);
  assert.strictEqual(result.diagnostics.safetyLimitHit, true);
  assert.strictEqual(result.diagnostics.reason, 'combination-limit-hit');
  assert.strictEqual(result.diagnostics.optimalityAbandoned, true);
});

test('falls back when formability checks exceed practical payout caps', () => {
  const partners = [{ name: 'A', wholeDollarPayout: 101 }];
  const inventory = { twenties: 0, tens: 0, fives: 0, ones: 101 };

  const result = BillAllocator.allocateBills(partners, inventory, {
    limits: { maxFormableAmount: 100 }
  });

  assert.strictEqual(result.exact, false);
  assert.strictEqual(result.diagnostics.safetyLimitHit, true);
  assert.strictEqual(result.diagnostics.reason, 'formability-limit-hit');
});

test('best-effort never overpays and minimizes total shortfall', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 9 },
    { name: 'B', wholeDollarPayout: 9 }
  ];
  const inventory = { twenties: 0, tens: 0, fives: 2, ones: 7 };

  const result = BillAllocator.allocateBills(partners, inventory);
  const paid = result.allocation.map(item => item.paid);
  const shortfalls = result.allocation.map(item => item.shortfall);

  assert.strictEqual(result.exact, false);
  assert.ok(paid[0] <= 9);
  assert.ok(paid[1] <= 9);
  assert.strictEqual(shortfalls.reduce((sum, amount) => sum + amount, 0), 1);
});

test('best-effort minimizes largest individual shortfall after total shortfall', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 8 },
    { name: 'B', wholeDollarPayout: 8 }
  ];
  const inventory = { twenties: 0, tens: 0, fives: 2, ones: 4 };

  const result = BillAllocator.allocateBills(partners, inventory);
  const shortfalls = result.allocation.map(item => item.shortfall).sort((a, b) => b - a);

  assert.strictEqual(result.exact, false);
  assert.deepStrictEqual(shortfalls, [1, 1]);
});

test('returns safety diagnostics when limits are intentionally tiny', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 22 },
    { name: 'B', wholeDollarPayout: 22 },
    { name: 'C', wholeDollarPayout: 22 }
  ];
  const inventory = { twenties: 3, tens: 3, fives: 3, ones: 9 };

  const result = BillAllocator.allocateBills(partners, inventory, {
    limits: { maxExploredStates: 1, maxMemoEntries: 1, maxSolveMs: 1 }
  });

  assert.strictEqual(result.diagnostics.safetyLimitHit, true);
  assert.ok(['safety-limit-hit', 'combination-limit-hit'].includes(result.diagnostics.reason));
});

test('reports best-effort safety-limit reason after exact search fails normally', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 8 },
    { name: 'B', wholeDollarPayout: 8 }
  ];
  const inventory = { twenties: 0, tens: 0, fives: 2, ones: 4 };

  const result = BillAllocator.allocateBills(partners, inventory, {
    limits: { maxExploredStates: 10 }
  });

  assert.strictEqual(result.exact, false);
  assert.strictEqual(result.diagnostics.safetyLimitHit, true);
  assert.strictEqual(result.diagnostics.reason, 'safety-limit-hit');
});

test('best-effort gets a fresh budget after exact search safety limit', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 9 },
    { name: 'B', wholeDollarPayout: 9 }
  ];
  const inventory = { twenties: 0, tens: 0, fives: 2, ones: 8 };

  const result = BillAllocator.allocateBills(partners, inventory, {
    limits: { maxExploredStates: 1 }
  });

  assert.ok(result.allocation.some(item => item.paid > 0));
  assert.ok(result.allocation.every((item, index) => item.paid <= partners[index].wholeDollarPayout));
});

test('capped combinations keep locally preferred high-value candidates', () => {
  const diagnostics = { safetyLimitHit: false, reason: 'exact-allocation-found' };
  const combos = BillAllocator._private.generateCombinations(
    20,
    { twenties: 1, tens: 2, fives: 0, ones: 20 },
    true,
    { maxCombinationsPerPartner: 1 },
    diagnostics
  );

  assert.deepStrictEqual(combos, [{ twenties: 1, tens: 0, fives: 0, ones: 0 }]);
  assert.strictEqual(diagnostics.safetyLimitHit, true);
});

test('keeps exact allocation found before a later safety limit', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 20 },
    { name: 'B', wholeDollarPayout: 20 }
  ];
  const inventory = { twenties: 2, tens: 4, fives: 0, ones: 0 };

  const result = BillAllocator.allocateBills(partners, inventory, {
    limits: { maxExploredStates: 4 }
  });

  assert.strictEqual(result.exact, true);
  assert.deepStrictEqual(result.allocation.map(item => item.paid), [20, 20]);
  assert.deepStrictEqual(result.allocation.map(item => item.shortfall), [0, 0]);
  assert.strictEqual(result.diagnostics.safetyLimitHit, true);
  assert.strictEqual(result.diagnostics.optimalityAbandoned, true);
});

test('allocation maps cleanly to existing app row fields', () => {
  const partners = [
    { name: 'A', number: '1', hours: 10, wholeDollarPayout: 12, breakdown: { twenties: 0, tens: 1, fives: 0, ones: 2 } },
    { name: 'B', number: '2', hours: 8, wholeDollarPayout: 8, breakdown: { twenties: 0, tens: 0, fives: 1, ones: 3 } }
  ];
  const result = BillAllocator.allocateBills(partners, { twenties: 1, tens: 0, fives: 0, ones: 0 });
  const rows = partners.map((partner, index) => ({
    ...partner,
    breakdown: result.allocation[index].breakdown,
    adjustedPayout: result.allocation[index].paid,
    hasShortfall: result.allocation[index].shortfall > 0,
    shortfallAmount: result.allocation[index].shortfall
  }));

  assert.strictEqual(result.exact, false);
  assert.deepStrictEqual(rows.map(row => row.name), ['A', 'B']);
  assert.ok(rows.every(row => row.adjustedPayout <= row.wholeDollarPayout));
  assert.ok(rows.some(row => row.hasShortfall));
});
