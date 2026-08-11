# Bill Denomination Allocation Design

## Context

The app calculates each partner's whole-dollar cash payout, then displays a bill breakdown using `$20`, `$10`, `$5`, and `$1` bills. The current edited-inventory redistribution path allocates greedily after sorting partners by largest payout. That can let early partners consume flexible larger bills and force later partners into inconvenient payouts with many `$1` bills.

The fix is to treat edited bill inventory as a global allocation problem. The solver must choose bill combinations for all partners together instead of deciding each partner independently.

## Goals

- Pay every partner their exact whole-dollar payout whenever the edited bill inventory makes that globally possible.
- Avoid concentrating `$1` bills on one partner.
- Prefer using fewer `$1` bills before trying to make `$1` counts look even.
- Apply the same fairness principle to `$5` bills after `$1` bills.
- Keep existing automatic/default bill generation unless tests reveal a correctness issue.
- Preserve existing leftover-bill and shortfall notifications.
- Keep allocation logic separate from DOM/UI code so it can be unit-tested independently.

## Non-Goals

- Do not change OCR, partner parsing, hourly-rate calculation, or whole-dollar payout rounding.
- Do not add external optimization libraries.
- Do not redesign the results UI beyond showing the improved allocations through the existing cards and notifications.

## Solver Inputs

The solver receives plain data, with no DOM dependencies:

- Partners in original display order, each with `wholeDollarPayout` and identifying display data.
- Available bill inventory: `{ twenties, tens, fives, ones }`.
- Denomination values: `$20`, `$10`, `$5`, `$1`.
- Optional safety limits for partner count, branch count, memo size, and elapsed runtime.

The solver must not mutate `lastCalculationResults`, partner objects, or partner order.

## Exact Allocation

For each partner payout, generate every valid exact denomination combination that sums to that partner's payout and does not exceed the total available inventory for any denomination.

The exact solver uses dynamic programming/backtracking with memoization keyed by state equivalent to:

```text
partnerIndex|twenties|tens|fives|ones
```

At each partner index, the solver tries valid combinations for that partner, subtracts the bills from remaining inventory, and recurses to the next partner. A complete exact allocation is valid only when every partner receives their exact payout.

## Exact Scoring

Exact solutions are compared lexicographically in this order:

1. Minimize the maximum number of `$1` bills received by any one partner.
2. Minimize the total number of `$1` bills used.
3. Minimize `$1` bill imbalance across partners, using a deterministic metric such as sum of squares of per-partner `$1` counts or sorted-count lexicographic comparison.
4. Minimize the maximum number of `$5` bills received by any one partner.
5. Minimize the total number of `$5` bills used.
6. Minimize `$5` bill imbalance across partners, using the same style of deterministic imbalance metric.
7. Minimize the total number of bills handled.
8. Preserve original partner order only as the final deterministic tie-breaker.

This intentionally avoids raw variance as the primary imbalance rule. For example, between `$1` distributions `[0, 2]` and `[2, 2]`, both have a maximum of `2`, but `[0, 2]` wins because it uses fewer `$1` bills overall.

## Pruning

The exact solver prunes branches immediately when:

- Remaining cash value is less than the sum of remaining partner payouts.
- Remaining denominations cannot collectively form exact combinations for the remaining partner payouts. Surplus bills are allowed as leftovers, so surplus cash alone is not a reason to prune.
- A partial solution already exceeds the best known exact solution on an earlier lexicographic score dimension.
- Safety limits are reached.

The denomination feasibility check should be conservative and fast. It can use reachable-sum dynamic programming from the remaining bill inventory to confirm each remaining payout is individually formable, plus a total remaining cash check. If needed for performance, cache feasibility results by remaining inventory and remaining payout multiset.

## Best-Effort Allocation

If no exact global allocation exists, the solver falls back to a global best-effort search.

Best-effort rules:

- Never overpay a partner.
- First minimize total dollar shortfall.
- Then minimize the largest individual shortfall.
- Then apply the same `$1` and `$5` small-bill fairness objectives used by the exact solver.
- Then minimize total bills handled.
- Use original partner order only as the final deterministic tie-breaker.

The best-effort solver can reuse generated combinations, but combinations may sum to any amount from `$0` through the partner's payout. It should prefer higher paid amounts through the shortfall score instead of greedy allocation.

## Diagnostics

The solver returns both allocation and metadata:

```js
{
  exact: true,
  allocation: [
    { breakdown: { twenties: 0, tens: 1, fives: 0, ones: 2 }, paid: 12, shortfall: 0 }
  ],
  usedBills: { twenties: 0, tens: 1, fives: 0, ones: 2 },
  leftoverBills: { twenties: 0, tens: 0, fives: 0, ones: 0 },
  diagnostics: {
    mode: 'exact',
    exploredStates: 0,
    memoEntries: 0,
    prunedBranches: 0,
    safetyLimitHit: false,
    reason: 'exact-allocation-found'
  }
}
```

For best-effort results, `exact` is `false`, partner entries include positive `shortfall` values where applicable, and `diagnostics.reason` explains why exact allocation was unavailable or abandoned.

## UI Integration

`redistributeBills()` remains responsible for reading bill inputs, calling the solver, rendering partner cards, and showing notifications.

The solver output maps back onto the existing result objects without mutating the originals. `renderResultsTable()` can continue receiving rows with `breakdown`, `adjustedPayout`, `hasShortfall`, and `shortfallAmount` fields.

Existing notification behavior remains:

- Leftover bills are reported when edited inventory contains bills the allocation does not use.
- Shortfalls are reported when best-effort allocation cannot fully pay one or more partners.

## Complexity Safeguards

The browser must not freeze on unusually large partner lists or manually entered bill inventories.

Safeguards:

- Cap generated combinations per partner. If exceeded, switch that solve attempt to best-effort with diagnostics indicating `combination-limit-hit`.
- Cap total explored states and memo entries.
- Cap elapsed solve time using `performance.now()` checks inside the search loop.
- Pre-sort each partner's generated combinations by local preference so good solutions are found early and pruning becomes more effective. This does not reorder partners.
- Use memoization for exact and best-effort searches.
- Cache generated combinations by `payout|twenties|tens|fives|ones|mode`.
- If exact search hits a safety limit, return a best-effort result rather than blocking the UI.
- If best-effort search also hits a safety limit, return the best allocation found so far with `safetyLimitHit: true` so the UI can still show a usable result and warning metadata remains available.

Initial limits should be conservative and easy to adjust in one constants object. A reasonable starting point is:

- `MAX_PARTNERS_FOR_GLOBAL_SOLVE`: 80
- `MAX_COMBINATIONS_PER_PARTNER`: 500
- `MAX_EXPLORED_STATES`: 100000
- `MAX_MEMO_ENTRIES`: 50000
- `MAX_SOLVE_MS`: 150

If partner count exceeds the global solve limit, use the current greedy-safe behavior as an emergency fallback and report that in diagnostics. This fallback should still never overpay.

## Testing

Add unit-style tests for the pure solver where practical in this repo. At minimum, add browser-runnable or command-line JavaScript tests that cover:

- Exact allocation where greedy largest-first would concentrate `$1` bills but global allocation spreads or reduces them.
- The `[0, 2]` versus `[2, 2]` scoring case where fewer total `$1` bills wins before imbalance.
- Inventory with leftovers preserves exact payouts and reports leftover bills.
- No exact allocation falls back to best-effort without overpaying.
- Best-effort minimizes total shortfall before fairness.
- Partner order in the returned allocation matches input order.
- Solver does not mutate input partners or inventory.
- Safety-limit diagnostics are returned when configured with intentionally tiny limits.

## Acceptance Criteria

- Edited bill inventory is allocated globally, not greedily by largest payout.
- Exact global solutions pay every partner exactly when possible.
- `$1` bill allocation follows the approved lexicographic scoring order.
- `$5` bill allocation follows the approved lexicographic scoring order after `$1` objectives.
- Best-effort allocation never overpays and reports shortfalls through existing notification behavior.
- Existing default bill generation remains unchanged unless tests reveal a correctness issue.
- Solver code is separated from DOM code and can be tested independently.
- Complexity safeguards prevent long-running searches from freezing the browser.
