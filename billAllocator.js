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
    maxSolveMs: 150,
    maxFormableAmount: 10000,
    maxFormabilityIterations: 200000
  };

  function markSafetyLimit(diagnostics, reason) {
    diagnostics.safetyLimitHit = true;
    if (diagnostics.reason === 'exact-allocation-found' || diagnostics.reason === 'no-exact-allocation') {
      diagnostics.reason = reason;
    }
  }

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

  function compareLocalCombination(a, b, target) {
    const localA = [a.ones, billValue(a) < target ? target - billValue(a) : 0, a.fives, billCount(a), a.twenties, a.tens];
    const localB = [b.ones, billValue(b) < target ? target - billValue(b) : 0, b.fives, billCount(b), b.twenties, b.tens];
    for (let i = 0; i < localA.length; i++) if (localA[i] !== localB[i]) return localA[i] - localB[i];
    return 0;
  }

  function prefixDominates(a, b) {
    if (a.totalShortfall > b.totalShortfall || a.maxShortfall > b.maxShortfall || a.totalBills > b.totalBills) return false;
    for (const denomination of ['ones', 'fives']) {
      for (let i = 0; i < b.counts[denomination].length; i++) {
        if (a.counts[denomination][i] > b.counts[denomination][i]) return false;
      }
    }
    return true;
  }

  function prefixState(allocation) {
    return {
      totalShortfall: allocation.reduce((sum, item) => sum + item.shortfall, 0),
      maxShortfall: allocation.length ? Math.max.apply(null, allocation.map(item => item.shortfall)) : 0,
      totalBills: allocation.reduce((sum, item) => sum + billCount(item.breakdown), 0),
      counts: {
        ones: allocation.map(item => item.breakdown.ones),
        fives: allocation.map(item => item.breakdown.fives)
      }
    };
  }

  function generateCombinations(target, inventory, exactOnly, limits, diagnostics) {
    const combos = [];
    const maxAmount = exactOnly ? target : Math.max(0, target);
    const maxCombinations = Math.max(0, Math.floor(Number(limits.maxCombinationsPerPartner) || 0));

    function addCombo(combo) {
      if (combos.length < maxCombinations) {
        combos.push(combo);
        return;
      }
      markSafetyLimit(diagnostics, 'combination-limit-hit');
      if (maxCombinations === 0) return;
      combos.sort((a, b) => compareLocalCombination(a, b, target));
      if (compareLocalCombination(combo, combos[combos.length - 1], target) < 0) combos[combos.length - 1] = combo;
    }

    for (let twenties = 0; twenties <= inventory.twenties && twenties * 20 <= maxAmount; twenties++) {
      for (let tens = 0; tens <= inventory.tens && twenties * 20 + tens * 10 <= maxAmount; tens++) {
        for (let fives = 0; fives <= inventory.fives && twenties * 20 + tens * 10 + fives * 5 <= maxAmount; fives++) {
          const partial = twenties * 20 + tens * 10 + fives * 5;
          if (exactOnly) {
            const ones = target - partial;
            if (ones >= 0 && ones <= inventory.ones) addCombo({ twenties, tens, fives, ones });
          } else {
            const maxOnes = Math.min(inventory.ones, target - partial);
            for (let ones = 0; ones <= maxOnes; ones++) addCombo({ twenties, tens, fives, ones });
          }
        }
      }
    }

    combos.sort((a, b) => compareLocalCombination(a, b, target));

    return combos;
  }

  function canFormAmount(target, inventory, limits, diagnostics) {
    if (target > limits.maxFormableAmount) {
      markSafetyLimit(diagnostics, 'formability-limit-hit');
      return false;
    }

    const reachable = new Array(target + 1).fill(false);
    reachable[0] = true;
    let iterations = 0;

    for (const [key, value] of DENOMS) {
      const usableCount = Math.min(inventory[key], Math.floor(target / value));
      for (let count = 0; count < usableCount; count++) {
        for (let amount = target; amount >= value; amount--) {
          iterations++;
          if (iterations > limits.maxFormabilityIterations) {
            markSafetyLimit(diagnostics, 'formability-limit-hit');
            return false;
          }
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

  function remainingPayoutsFormable(payouts, index, inventory, limits, diagnostics) {
    if (billValue(inventory) < remainingRequired(payouts, index)) return false;
    for (let i = index; i < payouts.length; i++) {
      if (!canFormAmount(payouts[i], inventory, limits, diagnostics)) return false;
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
        markSafetyLimit(diagnostics, 'safety-limit-hit');
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

      if (!remainingPayoutsFormable(payouts, index, bills, limits, diagnostics)) {
        diagnostics.prunedBranches++;
        return;
      }

      const key = stateKey(index, bills);
      const prefixScore = scoreExact(allocation);
      const previousPrefixScore = memo.get(key);
      if (previousPrefixScore && compareExactScore(prefixScore, previousPrefixScore) >= 0) {
        diagnostics.prunedBranches++;
        return;
      }
      memo.set(key, prefixScore);

      for (const combo of combosFor(index, bills)) {
        const remaining = subtractBills(bills, combo);
        allocation.push({ breakdown: combo, paid: payouts[index], shortfall: 0 });
        search(index + 1, remaining, allocation);
        allocation.pop();
      }
    }

    search(0, inventory, []);
    diagnostics.memoEntries = memo.size;
    if (best && diagnostics.safetyLimitHit) diagnostics.optimalityAbandoned = true;
    if (!best) return null;
    return best;
  }

  function freshDiagnostics(source) {
    return {
      mode: source.mode,
      exploredStates: 0,
      memoEntries: 0,
      prunedBranches: 0,
      safetyLimitHit: false,
      reason: source.reason
    };
  }

  function mergeDiagnostics(target, source) {
    const alreadyHitSafetyLimit = target.safetyLimitHit;
    target.exploredStates += source.exploredStates;
    target.memoEntries = Math.max(target.memoEntries, source.memoEntries);
    target.prunedBranches += source.prunedBranches;
    target.safetyLimitHit = target.safetyLimitHit || source.safetyLimitHit;
    if (source.safetyLimitHit && !alreadyHitSafetyLimit) target.reason = source.reason;
    if (source.optimalityAbandoned) target.optimalityAbandoned = true;
  }

  function bestEffortLimitsAfterExact(limits, exactDiagnostics) {
    if (!exactDiagnostics.safetyLimitHit) return limits;
    return {
      ...limits,
      maxExploredStates: Math.max(limits.maxExploredStates, DEFAULT_LIMITS.maxExploredStates),
      maxMemoEntries: Math.max(limits.maxMemoEntries, DEFAULT_LIMITS.maxMemoEntries),
      maxSolveMs: Math.max(limits.maxSolveMs, DEFAULT_LIMITS.maxSolveMs)
    };
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
        markSafetyLimit(diagnostics, 'safety-limit-hit');
        return;
      }

      const currentScore = scoreBestEffort(allocation);
      const remainingRequiredAmount = remainingRequired(payouts, index);
      const minimumTotalShortfall = currentScore.totalShortfall + Math.max(0, remainingRequiredAmount - billValue(bills));
      if (bestScore && minimumTotalShortfall > bestScore.totalShortfall) {
        diagnostics.prunedBranches++;
        return;
      }

      if (index === partners.length) {
        if (compareBestEffortScore(currentScore, bestScore) < 0) {
          bestScore = currentScore;
          best = allocation.map(item => ({ breakdown: { ...item.breakdown }, paid: item.paid, shortfall: item.shortfall }));
        }
        return;
      }

      const key = stateKey(index, bills);
      const currentPrefix = prefixState(allocation);
      const prefixes = memo.get(key) || [];
      if (prefixes.some(prefix => prefixDominates(prefix, currentPrefix))) {
        diagnostics.prunedBranches++;
        return;
      }
      const survivingPrefixes = prefixes.filter(prefix => !prefixDominates(currentPrefix, prefix));
      survivingPrefixes.push(currentPrefix);
      memo.set(key, survivingPrefixes);

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
      return emergencyGreedyBestEffort(safePartners, inventory, diagnostics);
    }

    const exactAllocation = allocateExact(safePartners, inventory, limits, diagnostics, startTime);
    if (exactAllocation) {
      const summary = summarizeAllocation(exactAllocation, inventory);
      return { exact: true, allocation: exactAllocation, usedBills: summary.usedBills, leftoverBills: summary.leftoverBills, diagnostics };
    }

    const exactDiagnostics = { ...diagnostics };
    const bestEffortDiagnostics = freshDiagnostics(diagnostics);
    diagnostics.mode = 'best-effort';
    diagnostics.reason = diagnostics.safetyLimitHit ? diagnostics.reason : 'no-exact-allocation';
    bestEffortDiagnostics.mode = 'best-effort';
    bestEffortDiagnostics.reason = diagnostics.reason;
    const bestEffortAllocation = allocateBestEffort(
      safePartners,
      inventory,
      bestEffortLimitsAfterExact(limits, exactDiagnostics),
      bestEffortDiagnostics,
      now()
    );
    mergeDiagnostics(diagnostics, bestEffortDiagnostics);
    const bestEffortSummary = summarizeAllocation(bestEffortAllocation, inventory);
    return {
      exact: false,
      allocation: bestEffortAllocation,
      usedBills: bestEffortSummary.usedBills,
      leftoverBills: bestEffortSummary.leftoverBills,
      diagnostics
    };
  }

  function emergencyGreedyBestEffort(partners, inventory, diagnostics) {
    let remainingBills = { ...inventory };
    const allocation = partners.map(partner => {
      let remainingAmount = Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0));
      const breakdown = emptyBills();
      for (const [key, value] of DENOMS) {
        const count = Math.min(remainingBills[key], Math.floor(remainingAmount / value));
        breakdown[key] += count;
        remainingBills[key] -= count;
        remainingAmount -= count * value;
      }
      const paid = Math.max(0, Math.floor(Number(partner.wholeDollarPayout) || 0)) - remainingAmount;
      return { breakdown, paid, shortfall: remainingAmount };
    });
    const summary = summarizeAllocation(allocation, inventory);
    return { exact: false, allocation, usedBills: summary.usedBills, leftoverBills: summary.leftoverBills, diagnostics };
  }

  return { allocateBills, _private: { generateCombinations, scoreExact, compareExactScore, scoreBestEffort, compareBestEffortScore, normalizeBills, billValue, stateKey } };
});
