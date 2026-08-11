# Bill Denomination Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace edited bill inventory redistribution with a global fair allocator that avoids concentrating `$1` bills while preserving exact payouts whenever possible.

**Architecture:** Add a pure `billAllocator.js` solver with no DOM dependencies, tested by a small Node `assert` test file. Load the solver before `app.js`, then make `redistributeBills()` call the solver and map returned allocations into the existing result-card and notification flow.

**Tech Stack:** Vanilla JavaScript, browser globals, Node built-in `assert` for tests, existing `index.html` and `app.js`.

## Global Constraints

- Do not change OCR, partner parsing, hourly-rate calculation, or whole-dollar payout rounding.
- Do not add external optimization libraries.
- Keep existing automatic/default bill generation unless tests reveal a correctness issue.
- Preserve existing leftover-bill and shortfall notifications.
- Keep allocation logic separate from DOM/UI code so it can be unit-tested independently.
- Do not mutate `lastCalculationResults`, partner objects, bill inventory, or partner order during solving.
- Exact scoring order: max `$1`, total `$1`, `$1` imbalance, max `$5`, total `$5`, `$5` imbalance, total bill count, deterministic tie-breaker.
- Best-effort scoring order: total dollar shortfall, largest individual shortfall, then the same small-bill fairness objectives, then total bill count, then deterministic tie-breaker.
- Memoization key must be equivalent to `partnerIndex|twenties|tens|fives|ones`.
- Prune when remaining cash is less than remaining required payouts and when remaining denominations cannot mathematically form remaining payouts.
- Include complexity safeguards so the browser cannot freeze with unusually large partner lists or bill inventories.

---

## File Structure

- Create `billAllocator.js`: pure global allocation solver exposed as `window.BillAllocator` in the browser and `module.exports` in Node tests.
- Create `tests/billAllocator.test.js`: dependency-free Node tests for exact allocation, best-effort allocation, mutation safety, order preservation, and safety diagnostics.
- Modify `index.html`: load `billAllocator.js` before `app.js`.
- Modify `app.js`: replace greedy logic inside `redistributeBills()` with a call to `BillAllocator.allocateBills()` and keep existing rendering/notification behavior.

---

### Task 1: Exact Global Solver

**Files:**
- Create: `billAllocator.js`
- Create: `tests/billAllocator.test.js`

**Interfaces:**
- Produces: `BillAllocator.allocateBills(partners, availableBills, options)`.
- Produces input type: `partners: Array<{ wholeDollarPayout: number }>`.
- Produces input type: `availableBills: { twenties: number, tens: number, fives: number, ones: number }`.
- Produces output type: `{ exact, allocation, usedBills, leftoverBills, diagnostics }`.
- Produces allocation item type: `{ breakdown, paid, shortfall }`.

- [ ] **Step 1: Write failing exact-allocation tests**

Create `tests/billAllocator.test.js` with this initial content:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/billAllocator.test.js`

Expected: FAIL with a module-not-found error for `../billAllocator`.

- [ ] **Step 3: Implement exact solver**

Create `billAllocator.js` with this implementation:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BillAllocator = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DENOMS = [
    ['twenties', 20],
    ['tens', 10],
    ['fives', 5],
    ['ones', 1]
  ];

  const DEFAULT_LIMITS = {
    maxPartnersForGlobalSolve: 80,
    maxCombinationsPerPartner: 500,
    maxExploredStates: 100000,
    maxMemoEntries: 50000,
    maxSolveMs: 150
  };

  function normalizeBills(bills) {
    return {
      twenties: Math.max(0, Math.floor(Number(bills && bills.twenties) || 0)),
      tens: Math.max(0, Math.floor(Number(bills && bills.tens) || 0)),
      fives: Math.max(0, Math.floor(Number(bills && bills.fives) || 0)),
      ones: Math.max(0, Math.floor(Number(bills && bills.ones) || 0))
    };
  }

  function billValue(bills) {
    return bills.twenties * 20 + bills.tens * 10 + bills.fives * 5 + bills.ones;
  }

  function billCount(bills) {
    return bills.twenties + bills.tens + bills.fives + bills.ones;
  }

  function subtractBills(a, b) {
    return {
      twenties: a.twenties - b.twenties,
      tens: a.tens - b.tens,
      fives: a.fives - b.fives,
      ones: a.ones - b.ones
    };
  }

  function addBills(a, b) {
    return {
      twenties: a.twenties + b.twenties,
      tens: a.tens + b.tens,
      fives: a.fives + b.fives,
      ones: a.ones + b.ones
    };
  }

  function emptyBills() {
    return { twenties: 0, tens: 0, fives: 0, ones: 0 };
  }

  function stateKey(index, bills) {
    return `${index}|${bills.twenties}|${bills.tens}|${bills.fives}|${bills.ones}`;
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function compareArraysDesc(a, b) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const left = a[i] || 0;
      const right = b[i] || 0;
      if (left !== right) return left - right;
    }
    return 0;
  }

  function distributionStats(allocation, denomination) {
    const counts = allocation.map(item => item.breakdown[denomination]);
    const sortedDesc = counts.slice().sort((a, b) => b - a);
    return {
      max: counts.length ? Math.max.apply(null, counts) : 0,
      total: counts.reduce((sum, count) => sum + count, 0),
      squares: counts.reduce((sum, count) => sum + count * count, 0),
      sortedDesc
    };
  }

  function scoreExact(allocation) {
    const ones = distributionStats(allocation, 'ones');
    const fives = distributionStats(allocation, 'fives');
    return {
      totalShortfall: 0,
      maxShortfall: 0,
      maxOnes: ones.max,
      totalOnes: ones.total,
      onesSquares: ones.squares,
      onesSortedDesc: ones.sortedDesc,
      maxFives: fives.max,
      totalFives: fives.total,
      fivesSquares: fives.squares,
      fivesSortedDesc: fives.sortedDesc,
      totalBills: allocation.reduce((sum, item) => sum + billCount(item.breakdown), 0)
    };
  }

  function compareExactScore(a, b) {
    if (!b) return -1;
    const numericKeys = ['maxOnes', 'totalOnes', 'onesSquares', 'maxFives', 'totalFives', 'fivesSquares', 'totalBills'];
    for (const key of numericKeys) {
      if (a[key] !== b[key]) return a[key] - b[key];
      if (key === 'onesSquares') {
        const sortedCompare = compareArraysDesc(a.onesSortedDesc, b.onesSortedDesc);
        if (sortedCompare !== 0) return sortedCompare;
      }
      if (key === 'fivesSquares') {
        const sortedCompare = compareArraysDesc(a.fivesSortedDesc, b.fivesSortedDesc);
        if (sortedCompare !== 0) return sortedCompare;
      }
    }
    return 0;
  }

  function generateCombinations(target, inventory, exactOnly, limits, diagnostics) {
    const combos = [];
    const maxAmount = exactOnly ? target : Math.max(0, target);

    for (let twenties = 0; twenties <= inventory.twenties && twenties * 20 <= maxAmount; twenties++) {
      for (let tens = 0; tens <= inventory.tens && twenties * 20 + tens * 10 <= maxAmount; tens++) {
        for (let fives = 0; fives <= inventory.fives && twenties * 20 + tens * 10 + fives * 5 <= maxAmount; fives++) {
          const partial = twenties * 20 + tens * 10 + fives * 5;
          if (exactOnly) {
            const ones = target - partial;
            if (ones >= 0 && ones <= inventory.ones) combos.push({ twenties, tens, fives, ones });
          } else {
            const maxOnes = Math.min(inventory.ones, target - partial);
            for (let ones = 0; ones <= maxOnes; ones++) combos.push({ twenties, tens, fives, ones });
          }
          if (combos.length > limits.maxCombinationsPerPartner) {
            diagnostics.safetyLimitHit = true;
            diagnostics.reason = 'combination-limit-hit';
            return combos.slice(0, limits.maxCombinationsPerPartner);
          }
        }
      }
    }

    combos.sort((a, b) => {
      const localA = [a.ones, billValue(a) < target ? target - billValue(a) : 0, a.fives, billCount(a)];
      const localB = [b.ones, billValue(b) < target ? target - billValue(b) : 0, b.fives, billCount(b)];
      for (let i = 0; i < localA.length; i++) if (localA[i] !== localB[i]) return localA[i] - localB[i];
      return 0;
    });

    return combos;
  }

  function canFormAmount(target, inventory) {
    const reachable = new Array(target + 1).fill(false);
    reachable[0] = true;
    for (const [key, value] of DENOMS) {
      for (let count = 0; count < inventory[key]; count++) {
        for (let amount = target; amount >= value; amount--) {
          reachable[amount] = reachable[amount] || reachable[amount - value];
        }
      }
    }
    return reachable[target] === true;
  }

  function remainingRequired(payouts, index) {
    let total = 0;
    for (let i = index; i < payouts.length; i++) total += payouts[i];
    return total;
  }

  function remainingPayoutsFormable(payouts, index, inventory) {
    if (billValue(inventory) < remainingRequired(payouts, index)) return false;
    for (let i = index; i < payouts.length; i++) {
      if (!canFormAmount(payouts[i], inventory)) return false;
    }
    return true;
  }

  function allocateExact(partners, inventory, limits, diagnostics, startTime) {
    const payouts = partners.map(partner => Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0)));
    const comboCache = new Map();
    const memo = new Map();
    let best = null;
    let bestScore = null;

    function combosFor(index, bills) {
      const key = `${payouts[index]}|${bills.twenties}|${bills.tens}|${bills.fives}|${bills.ones}|exact`;
      if (!comboCache.has(key)) comboCache.set(key, generateCombinations(payouts[index], bills, true, limits, diagnostics));
      return comboCache.get(key);
    }

    function search(index, bills, allocation) {
      diagnostics.exploredStates++;
      if (diagnostics.exploredStates > limits.maxExploredStates || memo.size > limits.maxMemoEntries || now() - startTime > limits.maxSolveMs) {
        diagnostics.safetyLimitHit = true;
        diagnostics.reason = 'safety-limit-hit';
        return;
      }

      if (index === partners.length) {
        const score = scoreExact(allocation);
        if (compareExactScore(score, bestScore) < 0) {
          bestScore = score;
          best = allocation.map(item => ({ breakdown: { ...item.breakdown }, paid: item.paid, shortfall: 0 }));
        }
        return;
      }

      if (!remainingPayoutsFormable(payouts, index, bills)) {
        diagnostics.prunedBranches++;
        return;
      }

      const key = stateKey(index, bills);
      if (memo.has(key)) return;
      memo.set(key, true);

      for (const combo of combosFor(index, bills)) {
        const remaining = subtractBills(bills, combo);
        allocation.push({ breakdown: combo, paid: payouts[index], shortfall: 0 });
        search(index + 1, remaining, allocation);
        allocation.pop();
      }
    }

    search(0, inventory, []);
    diagnostics.memoEntries = memo.size;
    if (!best) return null;
    return best;
  }

  function summarizeAllocation(allocation, inventory) {
    const usedBills = allocation.reduce((sum, item) => addBills(sum, item.breakdown), emptyBills());
    return {
      usedBills,
      leftoverBills: subtractBills(inventory, usedBills)
    };
  }

  function allocateBills(partners, availableBills, options) {
    const limits = { ...DEFAULT_LIMITS, ...(options && options.limits ? options.limits : {}) };
    const safePartners = Array.isArray(partners) ? partners.slice() : [];
    const inventory = normalizeBills(availableBills);
    const diagnostics = {
      mode: 'exact',
      exploredStates: 0,
      memoEntries: 0,
      prunedBranches: 0,
      safetyLimitHit: false,
      reason: 'exact-allocation-found'
    };
    const startTime = now();

    if (safePartners.length > limits.maxPartnersForGlobalSolve) {
      diagnostics.mode = 'best-effort';
      diagnostics.safetyLimitHit = true;
      diagnostics.reason = 'partner-limit-hit';
      return greedyBestEffort(safePartners, inventory, diagnostics);
    }

    const exactAllocation = allocateExact(safePartners, inventory, limits, diagnostics, startTime);
    if (exactAllocation) {
      const summary = summarizeAllocation(exactAllocation, inventory);
      return { exact: true, allocation: exactAllocation, usedBills: summary.usedBills, leftoverBills: summary.leftoverBills, diagnostics };
    }

    diagnostics.mode = 'best-effort';
    diagnostics.reason = diagnostics.safetyLimitHit ? diagnostics.reason : 'no-exact-allocation';
    return greedyBestEffort(safePartners, inventory, diagnostics);
  }

  function greedyBestEffort(partners, inventory, diagnostics) {
    let remainingBills = { ...inventory };
    const allocation = partners.map(partner => {
      let remainingAmount = Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0));
      const breakdown = emptyBills();
      for (const [key, value] of DENOMS) {
        while (remainingAmount >= value && remainingBills[key] > 0) {
          breakdown[key]++;
          remainingBills[key]--;
          remainingAmount -= value;
        }
      }
      const paid = Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0)) - remainingAmount;
      return { breakdown, paid, shortfall: remainingAmount };
    });
    const summary = summarizeAllocation(allocation, inventory);
    return { exact: false, allocation, usedBills: summary.usedBills, leftoverBills: summary.leftoverBills, diagnostics };
  }

  return { allocateBills, _private: { generateCombinations, scoreExact, compareExactScore, normalizeBills, billValue } };
});
```

- [ ] **Step 4: Run exact tests**

Run: `node tests/billAllocator.test.js`

Expected: PASS for the four exact-allocation tests.

- [ ] **Step 5: Commit Task 1 changes if commits are requested**

If the user explicitly requested commits, run:

```bash
git add billAllocator.js tests/billAllocator.test.js
git commit -m "feat: add exact bill allocation solver"
```

---

### Task 2: Global Best-Effort Solver And Safety Diagnostics

**Files:**
- Modify: `billAllocator.js`
- Modify: `tests/billAllocator.test.js`

**Interfaces:**
- Consumes: `BillAllocator.allocateBills(partners, availableBills, options)` from Task 1.
- Produces: best-effort result with `exact: false`, shortfall diagnostics, and no overpayment.

- [ ] **Step 1: Add failing best-effort and safety tests**

Append these tests to `tests/billAllocator.test.js`:

```js
test('best-effort never overpays and minimizes total shortfall', () => {
  const partners = [
    { name: 'A', wholeDollarPayout: 9 },
    { name: 'B', wholeDollarPayout: 9 }
  ];
  const inventory = { twenties: 0, tens: 1, fives: 1, ones: 3 };

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
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node tests/billAllocator.test.js`

Expected: FAIL because Task 1 uses `greedyBestEffort()`, which can fail the balanced-largest-shortfall case.

- [ ] **Step 3: Replace greedy best-effort with global search**

In `billAllocator.js`, replace `greedyBestEffort()` with a global best-effort search and add these helper functions before `allocateBills()`:

```js
  function scoreBestEffort(allocation) {
    const exactScore = scoreExact(allocation);
    return {
      ...exactScore,
      totalShortfall: allocation.reduce((sum, item) => sum + item.shortfall, 0),
      maxShortfall: allocation.length ? Math.max.apply(null, allocation.map(item => item.shortfall)) : 0
    };
  }

  function compareBestEffortScore(a, b) {
    if (!b) return -1;
    const earlyKeys = ['totalShortfall', 'maxShortfall'];
    for (const key of earlyKeys) if (a[key] !== b[key]) return a[key] - b[key];
    return compareExactScore(a, b);
  }

  function allocateBestEffort(partners, inventory, limits, diagnostics, startTime) {
    const payouts = partners.map(partner => Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0)));
    const comboCache = new Map();
    const memo = new Map();
    let best = null;
    let bestScore = null;

    function combosFor(index, bills) {
      const key = `${payouts[index]}|${bills.twenties}|${bills.tens}|${bills.fives}|${bills.ones}|best`;
      if (!comboCache.has(key)) comboCache.set(key, generateCombinations(payouts[index], bills, false, limits, diagnostics));
      return comboCache.get(key);
    }

    function search(index, bills, allocation) {
      diagnostics.exploredStates++;
      if (diagnostics.exploredStates > limits.maxExploredStates || memo.size > limits.maxMemoEntries || now() - startTime > limits.maxSolveMs) {
        diagnostics.safetyLimitHit = true;
        diagnostics.reason = 'safety-limit-hit';
        return;
      }

      if (index === partners.length) {
        const score = scoreBestEffort(allocation);
        if (compareBestEffortScore(score, bestScore) < 0) {
          bestScore = score;
          best = allocation.map(item => ({ breakdown: { ...item.breakdown }, paid: item.paid, shortfall: item.shortfall }));
        }
        return;
      }

      const key = stateKey(index, bills);
      if (memo.has(key)) return;
      memo.set(key, true);

      for (const combo of combosFor(index, bills)) {
        const paid = billValue(combo);
        const remaining = subtractBills(bills, combo);
        allocation.push({ breakdown: combo, paid, shortfall: payouts[index] - paid });
        search(index + 1, remaining, allocation);
        allocation.pop();
      }
    }

    search(0, inventory, []);
    diagnostics.memoEntries = Math.max(diagnostics.memoEntries, memo.size);
    if (best) return best;
    return partners.map(partner => ({
      breakdown: emptyBills(),
      paid: 0,
      shortfall: Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0))
    }));
  }
```

Then update the no-exact branch in `allocateBills()` to call `allocateBestEffort()` and return its summary:

```js
    diagnostics.mode = 'best-effort';
    diagnostics.reason = diagnostics.safetyLimitHit ? diagnostics.reason : 'no-exact-allocation';
    const bestEffortAllocation = allocateBestEffort(safePartners, inventory, limits, diagnostics, startTime);
    const bestEffortSummary = summarizeAllocation(bestEffortAllocation, inventory);
    return {
      exact: false,
      allocation: bestEffortAllocation,
      usedBills: bestEffortSummary.usedBills,
      leftoverBills: bestEffortSummary.leftoverBills,
      diagnostics
    };
```

Keep `greedyBestEffort()` only for partner-limit emergency fallback, or rename it `emergencyGreedyBestEffort()` so it is clear this is not the normal best-effort path.

- [ ] **Step 4: Run all solver tests**

Run: `node tests/billAllocator.test.js`

Expected: PASS for exact, best-effort, mutation, leftover, and safety tests.

- [ ] **Step 5: Commit Task 2 changes if commits are requested**

If the user explicitly requested commits, run:

```bash
git add billAllocator.js tests/billAllocator.test.js
git commit -m "feat: add best-effort bill allocation"
```

---

### Task 3: App Integration

**Files:**
- Modify: `index.html:345-346`
- Modify: `app.js:1697-1844`
- Modify: `tests/billAllocator.test.js`

**Interfaces:**
- Consumes: `window.BillAllocator.allocateBills(partners, availableBills, options)` from Tasks 1 and 2.
- Produces: `redistributeBills()` renders solver allocation in original order and calls `showBillNotification(leftoverBills, leftoverValue, shortfalls, totalNeeded, totalAvailable)`.

- [ ] **Step 1: Add integration-shape test for app-compatible rows**

Append this test to `tests/billAllocator.test.js`:

```js
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
```

- [ ] **Step 2: Run tests before integration**

Run: `node tests/billAllocator.test.js`

Expected: PASS. This test verifies the solver output shape needed by `app.js` before editing DOM code.

- [ ] **Step 3: Load solver before app code**

Modify `index.html` near the existing app script:

```html
    <!-- App logic -->
    <script src="billAllocator.js"></script>
    <script src="app.js"></script>
```

- [ ] **Step 4: Replace greedy redistribution body with solver integration**

In `app.js`, keep the bill input parsing and `totalAvailable` / `totalNeeded` calculations in `redistributeBills()`. Replace the sorted largest-first allocation block with:

```js
    const allocator = window.BillAllocator;
    if (!allocator || typeof allocator.allocateBills !== 'function') {
        console.error('Bill allocator is unavailable. Falling back to existing bill breakdowns.');
        return;
    }

    const solverResult = allocator.allocateBills(lastCalculationResults, availableBills);

    const updatedResults = lastCalculationResults.map((partner, index) => {
        const allocation = solverResult.allocation[index] || {
            breakdown: partner.breakdown,
            paid: partner.wholeDollarPayout,
            shortfall: 0
        };

        return {
            ...partner,
            breakdown: allocation.breakdown,
            adjustedPayout: allocation.paid,
            hasShortfall: allocation.shortfall > 0,
            shortfallAmount: allocation.shortfall
        };
    });

    const shortfalls = updatedResults
        .filter(partner => partner.shortfallAmount > 0)
        .map(partner => ({
            name: partner.name,
            owed: partner.wholeDollarPayout,
            received: partner.adjustedPayout,
            shortfall: partner.shortfallAmount
        }));

    const leftoverBills = solverResult.leftoverBills;
    const leftoverValue = (leftoverBills.twenties * 20) + (leftoverBills.tens * 10) +
        (leftoverBills.fives * 5) + (leftoverBills.ones * 1);

    debugLog('Bill allocation diagnostics:', solverResult.diagnostics);

    renderResultsTable(updatedResults, lastHourlyRate);
    showBillNotification(leftoverBills, leftoverValue, shortfalls, totalNeeded, totalAvailable);
```

Remove now-unused local variables from the old greedy block: `remainingBills`, `usedBills`, `indexedResults`, `sortedResults`, and `breakdownMap`.

- [ ] **Step 5: Run solver tests after app integration**

Run: `node tests/billAllocator.test.js`

Expected: PASS.

- [ ] **Step 6: Run a lightweight browser smoke test**

Run: `npx --yes serve .`

Expected: local server starts and serves `index.html`. Open the served URL manually if needed, enter two partners and edited bill counts, then confirm results render and bill notifications still appear. Stop the server with `Ctrl+C` after the smoke test.

- [ ] **Step 7: Commit Task 3 changes if commits are requested**

If the user explicitly requested commits, run:

```bash
git add index.html app.js tests/billAllocator.test.js
git commit -m "feat: use global bill allocator in app"
```

---

## Final Verification

- [ ] Run `node tests/billAllocator.test.js`.
- [ ] Run `git diff --check`.
- [ ] Confirm `index.html` loads `billAllocator.js` before `app.js`.
- [ ] Confirm `redistributeBills()` no longer sorts partners by payout or greedily consumes bills by largest payout.
- [ ] Confirm default bill generation through `breakdownBills()` remains unchanged.
- [ ] Confirm no commits were made unless explicitly requested.

## Self-Review Notes

- Spec coverage: exact solver, scoring order, best-effort fallback, diagnostics, non-mutation, UI notifications, and complexity safeguards are each covered by a task.
- Placeholder scan: no task relies on unspecified helper names; all new public function names and result fields are defined.
- Type consistency: `allocateBills()`, `allocation`, `breakdown`, `paid`, `shortfall`, `usedBills`, `leftoverBills`, and `diagnostics` are used consistently across tests and integration.
