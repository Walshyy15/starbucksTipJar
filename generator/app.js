/* ═══════════════════════════════════════════
   Sbux Sips Generator — App Logic
   v2.0 — Reddit scraping + fasting support
   ═══════════════════════════════════════════ */

const TREND_DATA_PATH = "./data/trends.json";
const REDDIT_SEARCH_URL = "https://www.reddit.com/r/starbucks/search.json";

// ─── App State ───
const appState = {
  localTrends: [],
  redditTrends: [],
  combinedTrends: [],
  trendingWeights: {
    bases: new Map(),
    ingredients: new Map(),
    combos: new Map()
  },
  redditLoaded: false
};

// ─── Prompt Templates (internal reference) ───
const promptTemplates = {
  generation: `
System: You are a drink idea assistant. Produce a realistic, fan-made Starbucks-style custom drink.
User input: {{craving}}
Mode: {{mode}}
Output schema:
{
  name: "",
  base: "",
  customizations: [],
  flavor: "",
  reason: ""
}
Constraints:
- Keep combinations plausible.
- Prefer trending ingredients when mode=trending.
- Mark as fan-made and not official menu.
- If fasting_mode is enabled, keep drinks compatible with selected fasting_window.
  `.trim(),
  parsing: `
System: Parse messy drink text into structured fields.
Input: {{messy_text}}
Output schema:
{
  drink: "",
  milk: "",
  syrups: [],
  foam: "",
  extras: []
}
Rules:
- Infer likely base drink from keywords.
- Keep unknown words in extras.
  `.trim(),
  trendReasoning: `
System: Build weighted preference from trend records.
Inputs: trend tags, popularity, ingredient overlap.
Method:
1) Score each ingredient by frequency * popularity.
2) Score pairs of ingredients as combo memory.
3) Bias suggestions toward high score items while respecting user craving.
  `.trim()
};

// ─── Drink Catalogs ───
const baseOptions = [
  "Latte", "Iced Latte", "Cold Brew", "Iced Chai Tea Latte",
  "Shaken Espresso", "Iced Matcha Latte", "Refresher", "Flat White"
];

const ingredientCatalog = {
  milks: ["oatmilk", "almondmilk", "coconutmilk", "2% milk", "nonfat milk"],
  syrups: [
    "vanilla syrup", "brown sugar syrup", "toffee nut syrup",
    "caramel syrup", "hazelnut syrup", "cinnamon dolce syrup", "honey blend"
  ],
  foams: ["vanilla sweet cream cold foam", "salted cold foam", "none"],
  toppings: ["cinnamon dust", "caramel drizzle", "cookie crumble topping", "nutmeg sprinkle", "none"]
};

const fastingProfiles = {
  fasting: {
    label: "Fasting window",
    allowedBases: ["Cold Brew", "Iced Coffee", "Iced Black Tea", "Iced Green Tea", "Nitro Cold Brew"],
    bannedTerms: ["syrup", "sauce", "sweet cream", "cold foam", "drizzle", "cookie", "puree", "lemonade", "honey"],
    preferredCustomizations: ["splash of almondmilk", "extra ice", "cinnamon dust"],
    reasonHint: "set to very low calorie support for your fasting hours"
  },
  eating: {
    label: "Eating window",
    allowedBases: ["Cold Brew", "Iced Latte", "Latte", "Shaken Espresso", "Iced Matcha Latte", "Iced Chai Tea Latte"],
    bannedTerms: ["cookie crumble", "extra drizzle", "double sauce"],
    preferredCustomizations: ["light syrup", "single pump", "nonfat milk", "almondmilk"],
    reasonHint: "set to balanced sweetness for your 6-hour eating window"
  }
};

// ─── DOM References ───
const cravingInput = document.getElementById("cravingInput");
const generateBtn = document.getElementById("generateBtn");
const generatorResult = document.getElementById("generatorResult");
const fastingFriendly = document.getElementById("fastingFriendly");
const fastingWindow = document.getElementById("fastingWindow");
const messyInput = document.getElementById("messyInput");
const reconstructBtn = document.getElementById("reconstructBtn");
const reconstructResult = document.getElementById("reconstructResult");
const themeToggle = document.getElementById("themeToggle");
const redditStatusEl = document.getElementById("redditStatus");
const redditStatusText = document.getElementById("redditStatusText");
const redditTrendsContainer = document.getElementById("redditTrends");
const refreshRedditBtn = document.getElementById("refreshReddit");


/* ═══════════════════════════════════════════
   REDDIT SCRAPING
   Uses Reddit's public JSON API (no auth needed, CORS friendly)
   ═══════════════════════════════════════════ */

const REDDIT_QUERIES = [
  "custom drink recipe",
  "secret menu drink",
  "favorite drink order",
  "drink recommendation",
  "try this drink"
];

function buildRedditUrl(query) {
  const params = new URLSearchParams({
    q: query,
    restrict_sr: "on",
    sort: "relevance",
    t: "month",
    limit: "10",
    type: "link"
  });
  return `${REDDIT_SEARCH_URL}?${params}`;
}

async function fetchRedditTrends() {
  setRedditStatus("loading", "Scraping Reddit for latest trends…");

  const allPosts = [];
  const seenIds = new Set();

  // Fire off all queries in parallel
  const queryPromises = REDDIT_QUERIES.map(async (query) => {
    try {
      const url = buildRedditUrl(query);
      const res = await fetch(url, {
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data?.children || []).map(c => c.data);
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(queryPromises);

  results.forEach(result => {
    if (result.status === "fulfilled") {
      result.value.forEach(post => {
        if (!seenIds.has(post.id) && !post.over_18 && post.selftext) {
          seenIds.add(post.id);
          allPosts.push(post);
        }
      });
    }
  });

  if (allPosts.length === 0) {
    setRedditStatus("error", "Couldn't reach Reddit — using local trends only.");
    return [];
  }

  // Sort by score, take top 15
  allPosts.sort((a, b) => b.score - a.score);
  const topPosts = allPosts.slice(0, 15);

  // Parse posts into trend-like objects
  const parsedTrends = topPosts.map(post => parseRedditPost(post)).filter(Boolean);

  setRedditStatus("live", `Loaded ${parsedTrends.length} trends from r/starbucks`);
  appState.redditLoaded = true;

  return parsedTrends;
}

function parseRedditPost(post) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();

  // Try to extract drink info from the post text
  const base = inferDrinkBaseFromText(text);
  const ingredients = extractIngredients(text);

  // Only include posts that seem to be about actual drinks
  if (base === "Unknown" && ingredients.length === 0) return null;

  const tags = extractTags(text);

  return {
    name: cleanTitle(post.title),
    base: base,
    customizations: ingredients.length > 0 ? ingredients : ["custom order"],
    flavor: inferFlavorFromTags(tags),
    tags: tags,
    popularity: Math.min(100, Math.round(post.score / 2) + 50),
    source: "reddit",
    redditUrl: `https://www.reddit.com${post.permalink}`,
    redditScore: post.score,
    redditAuthor: post.author,
    selftext: post.selftext.slice(0, 300)
  };
}

function cleanTitle(title) {
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/^(has anyone tried|try this|my favorite|psa:|just discovered|new)\s*/i, "")
    .trim()
    .split(" ")
    .slice(0, 8)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function inferDrinkBaseFromText(text) {
  const bases = [
    ["cold brew", "Cold Brew"],
    ["nitro", "Nitro Cold Brew"],
    ["iced chai", "Iced Chai Tea Latte"],
    ["chai", "Chai Tea Latte"],
    ["matcha", "Iced Matcha Latte"],
    ["refresher", "Refresher"],
    ["shaken espresso", "Shaken Espresso"],
    ["iced latte", "Iced Latte"],
    ["frappuccino", "Frappuccino"],
    ["frap", "Frappuccino"],
    ["flat white", "Flat White"],
    ["latte", "Latte"],
    ["americano", "Americano"],
    ["iced coffee", "Iced Coffee"],
    ["pink drink", "Pink Drink"],
    ["dragon drink", "Dragon Drink"],
    ["green tea", "Iced Green Tea"],
    ["black tea", "Iced Black Tea"]
  ];
  for (const [keyword, name] of bases) {
    if (text.includes(keyword)) return name;
  }
  return "Unknown";
}

function extractIngredients(text) {
  const allIngredients = [
    "oatmilk", "oat milk", "almond milk", "almondmilk", "coconut milk", "coconutmilk",
    "soy milk", "nonfat", "whole milk", "breve", "half and half",
    "vanilla syrup", "vanilla", "brown sugar syrup", "brown sugar", "caramel syrup",
    "caramel sauce", "caramel drizzle", "hazelnut syrup", "hazelnut", "toffee nut",
    "cinnamon dolce", "white mocha", "mocha sauce", "mocha", "peppermint",
    "lavender", "pistachio", "honey blend", "honey",
    "cold foam", "sweet cream", "salted foam", "whipped cream",
    "extra shot", "blonde espresso", "extra ice",
    "cinnamon", "nutmeg", "cookie crumble", "java chips",
    "strawberry puree", "peach juice", "raspberry", "dragonfruit"
  ];

  return allIngredients
    .filter(ing => text.includes(ing))
    .slice(0, 5)
    .map(toTitle);
}

function extractTags(text) {
  const tagMap = {
    "cozy": ["cozy", "warm", "fall", "autumn", "winter", "comfort"],
    "refreshing": ["refresh", "summer", "cool", "cold", "quench"],
    "fruity": ["fruit", "berry", "peach", "mango", "strawberry", "dragon"],
    "dessert": ["dessert", "sweet", "cookie", "cake", "treat", "indulgent"],
    "coffee-forward": ["espresso", "bold", "strong", "shot", "caffeine"],
    "spiced": ["cinnamon", "chai", "spice", "nutmeg", "pumpkin"],
    "nutty": ["hazelnut", "pistachio", "almond", "nutty"],
    "chocolate": ["mocha", "chocolate", "cocoa"],
    "floral": ["lavender", "rose", "floral"],
    "tropical": ["mango", "coconut", "pineapple", "tropical"],
    "caramel": ["caramel", "toffee", "butterscotch"],
    "matcha": ["matcha", "green tea"],
    "vanilla": ["vanilla"]
  };

  const tags = [];
  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some(kw => text.includes(kw))) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags.slice(0, 4) : ["custom"];
}

function inferFlavorFromTags(tags) {
  const descriptions = {
    "cozy": "warm and comforting",
    "refreshing": "cool and refreshing",
    "fruity": "bright and fruity",
    "dessert": "sweet and indulgent",
    "coffee-forward": "bold and caffeinated",
    "spiced": "warmly spiced",
    "nutty": "nutty and rich",
    "chocolate": "chocolatey",
    "floral": "delicately floral",
    "tropical": "tropical and vibrant",
    "caramel": "buttery caramel",
    "matcha": "earthy matcha",
    "vanilla": "smooth vanilla"
  };
  const words = tags.map(t => descriptions[t]).filter(Boolean).slice(0, 3);
  return words.length > 0 ? words.join(", ") : "smooth and balanced";
}

function setRedditStatus(state, text) {
  redditStatusEl.className = `reddit-status ${state}`;
  redditStatusText.textContent = text;
}

function renderRedditTrends(trends) {
  if (trends.length === 0) {
    redditTrendsContainer.innerHTML = `<p class="subtext" style="text-align:center;padding:1rem;">No Reddit trends available right now. Using local trend data.</p>`;
    return;
  }

  redditTrendsContainer.innerHTML = trends.map((trend, i) => `
    <div class="trend-card" style="animation-delay:${i * 0.06}s">
      <div class="trend-card__title">
        <span>${escapeHtml(trend.name)}</span>
        ${trend.redditScore ? `<span class="upvotes">▲ ${trend.redditScore}</span>` : ""}
      </div>
      <div class="trend-card__body">
        ${trend.selftext ? escapeHtml(trend.selftext) : `${escapeHtml(trend.base)} — ${escapeHtml(trend.customizations.join(", "))}`}
      </div>
      <div class="trend-card__meta">
        ${trend.tags.map(t => `<span class="trend-tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      ${trend.redditUrl ? `<a href="${escapeHtml(trend.redditUrl)}" target="_blank" rel="noopener noreferrer" class="trend-card__link">View on Reddit ↗</a>` : ""}
    </div>
  `).join("");
}


/* ═══════════════════════════════════════════
   TREND WEIGHT ENGINE
   ═══════════════════════════════════════════ */

function buildTrendWeights() {
  appState.trendingWeights.bases.clear();
  appState.trendingWeights.ingredients.clear();
  appState.trendingWeights.combos.clear();

  appState.combinedTrends.forEach(trend => {
    if (!trend.base || !trend.customizations) return;

    addWeight(appState.trendingWeights.bases, trend.base.toLowerCase(), trend.popularity);

    trend.customizations.forEach(item => {
      addWeight(appState.trendingWeights.ingredients, item.toLowerCase(), trend.popularity);
    });

    for (let i = 0; i < trend.customizations.length - 1; i++) {
      const combo = [trend.customizations[i], trend.customizations[i + 1]]
        .map(t => t.toLowerCase())
        .join(" + ");
      addWeight(appState.trendingWeights.combos, combo, trend.popularity);
    }
  });
}

function addWeight(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}


/* ═══════════════════════════════════════════
   DRINK GENERATOR
   ═══════════════════════════════════════════ */

function selectedMode() {
  return document.querySelector("input[name='mode']:checked")?.value || "trending";
}

function getFastingPrefs() {
  if (!fastingFriendly.checked) return null;
  const windowKey = fastingWindow.value === "fasting" ? "fasting" : "eating";
  return { enabled: true, window: windowKey, ...fastingProfiles[windowKey] };
}

function scoreTrend(trend, craving) {
  const cravingText = craving.toLowerCase();
  let score = trend.popularity || 50;

  if (trend.tags && trend.tags.some(tag => cravingText.includes(tag))) score += 24;
  if (trend.customizations && trend.customizations.some(item => cravingText.includes(item.split(" ")[0].toLowerCase()))) score += 16;
  if (cravingText.includes("sweet") && trend.tags && trend.tags.includes("dessert")) score += 10;
  if (cravingText.includes("refresh") && trend.tags && trend.tags.includes("refreshing")) score += 10;
  if (cravingText.includes("cozy") && trend.tags && trend.tags.includes("cozy")) score += 10;
  // Boost Reddit-sourced trends slightly for freshness
  if (trend.source === "reddit") score += 5;

  return score;
}

function weightedPick(items, weightAccessor) {
  if (!items.length) return "none";
  const weighted = items
    .map(item => ({ item, weight: Math.max(1, weightAccessor(item)) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);

  const sum = weighted.reduce((acc, curr) => acc + curr.weight, 0);
  let roll = Math.random() * sum;

  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.item;
  }
  return weighted[0]?.item || items[0];
}

function fitsFastingProfile(trend, fastingPrefs) {
  if (!fastingPrefs) return true;
  const haystack = `${trend.base} ${trend.customizations.join(" ")}`.toLowerCase();
  const baseAllowed = fastingPrefs.allowedBases.some(b => trend.base.toLowerCase().includes(b.toLowerCase()));
  const hasBannedTerm = fastingPrefs.bannedTerms.some(term => haystack.includes(term));
  return baseAllowed && !hasBannedTerm;
}

function makeFastingFallback(fastingPrefs) {
  if (!fastingPrefs || fastingPrefs.window === "eating") {
    return {
      name: "Balanced Oat Cold Brew",
      base: "Cold Brew",
      customizations: ["oatmilk splash", "single pump vanilla syrup", "extra ice"],
      flavor: "smooth and lightly sweet",
      reason: "Built for your eating window with lighter sugar choices.",
      fastingFit: "Eating window aligned"
    };
  }
  return {
    name: "Zero-Sugar Black Tea Lift",
    base: "Iced Black Tea",
    customizations: ["unsweetened", "extra ice", "cinnamon dust"],
    flavor: "crisp and clean",
    reason: "Built for your fasting window with minimal calories and no sweeteners.",
    fastingFit: "Fasting window aligned"
  };
}

function adaptCustomizationsForFasting(customizations, fastingPrefs) {
  if (!fastingPrefs) return customizations;
  const filtered = customizations.filter(item => {
    const lower = item.toLowerCase();
    return !fastingPrefs.bannedTerms.some(term => lower.includes(term));
  });
  if (filtered.length >= 2) return filtered;
  return [...filtered, ...fastingPrefs.preferredCustomizations].slice(0, 4);
}

function generateDrink(craving, mode, fastingPrefs) {
  // Reference prompt templates (used as internal documentation)
  void promptTemplates.generation;
  void promptTemplates.trendReasoning;

  if (!appState.combinedTrends.length) {
    return makeFastingFallback(fastingPrefs);
  }

  const lowerCraving = (craving || "").toLowerCase();
  const candidatePool = fastingPrefs
    ? appState.combinedTrends.filter(trend => fitsFastingProfile(trend, fastingPrefs))
    : [...appState.combinedTrends];
  const ranked = candidatePool.sort((a, b) => scoreTrend(b, lowerCraving) - scoreTrend(a, lowerCraving));

  if (!ranked.length) {
    return makeFastingFallback(fastingPrefs);
  }

  if (mode === "trending") {
    const top = ranked.slice(0, 6);
    const picked = weightedPick(top, trend => scoreTrend(trend, lowerCraving));
    const customizations = adaptCustomizationsForFasting(picked.customizations, fastingPrefs);

    return {
      name: picked.name,
      base: picked.base,
      customizations,
      flavor: picked.flavor,
      reason: `Suggested from ${picked.source === "reddit" ? "live Reddit trends" : "high-signal trend data"} with tags: ${picked.tags.join(", ")}${fastingPrefs ? ` and ${fastingPrefs.reasonHint}` : ""}.`,
      fastingFit: fastingPrefs ? `${fastingPrefs.label} aligned` : "Standard",
      source: picked.source || "local"
    };
  }

  // Creative mode
  const creativeBases = fastingPrefs ? fastingPrefs.allowedBases : baseOptions;
  const base = weightedPick(creativeBases, c => appState.trendingWeights.bases.get(c.toLowerCase()) || 40);
  const milk = weightedPick(ingredientCatalog.milks, i => appState.trendingWeights.ingredients.get(i) || 20);
  const syrupPool = fastingPrefs?.window === "fasting" ? ["none"] : ingredientCatalog.syrups;
  const syrup1 = weightedPick(syrupPool, i => appState.trendingWeights.ingredients.get(i) || 20);
  const secondSyrupPool = syrupPool.filter(i => i !== syrup1);
  const syrup2 = secondSyrupPool.length
    ? weightedPick(secondSyrupPool, i => appState.trendingWeights.ingredients.get(i) || 15)
    : "none";
  const foamPool = fastingPrefs?.window === "fasting" ? ["none"] : ingredientCatalog.foams;
  const toppingPool = fastingPrefs?.window === "fasting" ? ["none", "cinnamon dust"] : ingredientCatalog.toppings;
  const foam = weightedPick(foamPool, i => appState.trendingWeights.ingredients.get(i) || 12);
  const topping = weightedPick(toppingPool, i => appState.trendingWeights.ingredients.get(i) || 10);

  const nameLead = syrup1 === "none" ? "Clean" : capitalize(syrup1.split(" ")[0]);
  const creativeName = `${nameLead} ${capitalize(base.split(" ")[0])} Remix`;
  const customizations = adaptCustomizationsForFasting(
    [milk, syrup1, syrup2, foam, topping].filter(i => i !== "none"),
    fastingPrefs
  );

  return {
    name: creativeName,
    base,
    customizations,
    flavor: buildFlavorDescription(customizations, lowerCraving),
    reason: `Creative mode blended weighted trending ingredients with a novelty twist${fastingPrefs ? ` and ${fastingPrefs.reasonHint}` : ""}.`,
    fastingFit: fastingPrefs ? `${fastingPrefs.label} aligned` : "Standard",
    source: "creative"
  };
}

function buildFlavorDescription(items, craving) {
  const words = [];
  if (items.some(i => i.includes("vanilla") || i.includes("caramel") || i.includes("white mocha"))) words.push("sweet");
  if (items.some(i => i.includes("cinnamon") || i.includes("chai") || i.includes("brown sugar"))) words.push("spiced");
  if (items.some(i => i.includes("cold foam") || i.includes("sweet cream"))) words.push("creamy");
  if (craving.includes("refresh") || items.some(i => i.includes("lemonade") || i.includes("coconut"))) words.push("refreshing");
  return words.length ? `${[...new Set(words)].join(", ")} profile` : "balanced and smooth profile";
}

function renderGeneratedDrink(drink) {
  generatorResult.classList.remove("empty");
  const sourceLabel = drink.source === "reddit" ? "📡 Reddit trend" : drink.source === "creative" ? "🎨 Creative blend" : "📊 Local trend";

  generatorResult.innerHTML = `
    <div class="result-grid">
      <div class="result-row"><strong>Drink Name</strong><span>${escapeHtml(drink.name)}</span></div>
      <div class="result-row"><strong>Base drink</strong><span>${escapeHtml(drink.base)}</span></div>
      <div class="result-row"><strong>Customizations</strong><span>${escapeHtml(drink.customizations.join(" • "))}</span></div>
      <div class="result-row"><strong>Flavor profile</strong><span>${escapeHtml(drink.flavor)}</span></div>
      <div class="result-row"><strong>Why suggested</strong><span>${escapeHtml(drink.reason)}</span></div>
      <div class="result-row"><strong>Fasting fit</strong><span>${escapeHtml(drink.fastingFit || "Standard")}</span></div>
      <div class="result-row"><strong>Source</strong><span>${sourceLabel}</span></div>
      <div class="result-row"><strong>Note</strong><span>Custom fan-made Starbucks-style drink (not an official menu item).</span></div>
      <div class="result-row"><strong>Health note</strong><span>General wellness guidance only, not medical advice.</span></div>
    </div>
  `;
}


/* ═══════════════════════════════════════════
   RECONSTRUCTION TOOL
   ═══════════════════════════════════════════ */

function parseMessyOrder(text) {
  void promptTemplates.parsing;

  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized.split(/\s+/).filter(Boolean);

  const milkKeywords = ["oatmilk", "oat milk", "almondmilk", "almond milk", "coconutmilk", "coconut milk", "soy", "nonfat", "whole", "2%", "breve"];
  const syrupKeywords = ["vanilla", "brown sugar", "toffee nut", "hazelnut", "caramel", "mocha", "white mocha", "cinnamon dolce", "honey", "peppermint", "lavender", "pistachio"];
  const foamKeywords = ["cold foam", "sweet cream", "salted foam"];

  const lower = ` ${normalized} `;

  const drink = inferDrinkBase(lower);
  const milk = pickPhrase(lower, milkKeywords) || "Not specified";
  const syrups = syrupKeywords.filter(s => lower.includes(s)).map(toTitle);
  const foam = pickPhrase(lower, foamKeywords) || "None";

  const claimed = new Set([
    ...milk.split(" "),
    ...foam.split(" "),
    ...syrups.flatMap(s => s.toLowerCase().split(" ")),
    ...drink.toLowerCase().split(" ")
  ]);

  const extras = tokens
    .filter(token => !claimed.has(token))
    .filter(token => !["iced", "hot", "with", "and", "extra", "light", "add", "a", "of", "the"].includes(token));

  return {
    drink,
    milk: toTitle(milk),
    syrups: syrups.length ? syrups : ["None"],
    foam: toTitle(foam),
    extras: extras.length ? unique(extras.map(toTitle)) : ["None"]
  };
}

function inferDrinkBase(lower) {
  if (lower.includes("cold brew")) return "Cold Brew";
  if (lower.includes("chai")) return "Iced Chai Tea Latte";
  if (lower.includes("matcha")) return "Iced Matcha Latte";
  if (lower.includes("refresher") || lower.includes("dragonfruit")) return "Refresher";
  if (lower.includes("espresso") || lower.includes("shaken")) return "Shaken Espresso";
  if (lower.includes("frappuccino") || lower.includes("frap")) return "Frappuccino";
  if (lower.includes("flat white")) return "Flat White";
  if (lower.includes("americano")) return "Americano";
  if (lower.includes("latte")) return "Latte";
  return "Custom Iced Drink";
}

function pickPhrase(text, phrases) {
  return phrases.find(phrase => text.includes(phrase)) || "";
}

function renderParsedOrder(order) {
  reconstructResult.classList.remove("empty");
  reconstructResult.innerHTML = `
    <div class="result-grid">
      <div class="result-row"><strong>Drink</strong><span>${escapeHtml(order.drink)}</span></div>
      <div class="result-row"><strong>Milk</strong><span>${escapeHtml(order.milk)}</span></div>
      <div class="result-row"><strong>Syrups</strong><span>${escapeHtml(order.syrups.join(" • "))}</span></div>
      <div class="result-row"><strong>Foam</strong><span>${escapeHtml(order.foam)}</span></div>
      <div class="result-row"><strong>Extras</strong><span>${escapeHtml(order.extras.join(" • "))}</span></div>
    </div>
  `;
}


/* ═══════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════ */

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toTitle(text) {
  return text.split(" ").filter(Boolean).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function unique(list) {
  return [...new Set(list)];
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}


/* ═══════════════════════════════════════════
   THEME MANAGEMENT
   ═══════════════════════════════════════════ */

function initTheme() {
  const saved = localStorage.getItem("sbux-sips-theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  } else {
    // Detect system preference
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("sbux-sips-theme", next);
}


/* ═══════════════════════════════════════════
   EVENT HANDLERS
   ═══════════════════════════════════════════ */

generateBtn.addEventListener("click", () => {
  const craving = cravingInput.value.trim();
  const drink = generateDrink(craving, selectedMode(), getFastingPrefs());
  renderGeneratedDrink(drink);
});

// Allow Enter key to generate
cravingInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    generateBtn.click();
  }
});

reconstructBtn.addEventListener("click", () => {
  const text = messyInput.value.trim();
  if (!text) {
    reconstructResult.classList.remove("empty");
    reconstructResult.innerHTML = `<p style="text-align:center;color:var(--muted)">Please enter a messy drink line first.</p>`;
    return;
  }
  const parsed = parseMessyOrder(text);
  renderParsedOrder(parsed);
});

fastingFriendly.addEventListener("change", () => {
  fastingWindow.disabled = !fastingFriendly.checked;
});

themeToggle.addEventListener("click", toggleTheme);

refreshRedditBtn.addEventListener("click", async () => {
  refreshRedditBtn.classList.add("loading");
  await loadRedditTrends();
  refreshRedditBtn.classList.remove("loading");
});


/* ═══════════════════════════════════════════
   INITIALIZATION
   ═══════════════════════════════════════════ */

async function loadLocalTrends() {
  try {
    const res = await fetch(TREND_DATA_PATH);
    if (!res.ok) throw new Error("Could not load trends.json");
    appState.localTrends = await res.json();
  } catch (error) {
    console.warn("Local trends unavailable:", error.message);
    appState.localTrends = [];
  }
}

async function loadRedditTrends() {
  try {
    appState.redditTrends = await fetchRedditTrends();
    renderRedditTrends(appState.redditTrends);
  } catch (error) {
    console.warn("Reddit fetch failed:", error.message);
    setRedditStatus("error", "Reddit unavailable — using local trends.");
    appState.redditTrends = [];
  }
}

async function init() {
  initTheme();
  fastingWindow.disabled = true;

  // Load local trends and Reddit trends in parallel
  await Promise.all([
    loadLocalTrends(),
    loadRedditTrends()
  ]);

  // Merge: Reddit trends first (fresher), then local
  appState.combinedTrends = [...appState.redditTrends, ...appState.localTrends];

  // Build weights from combined data
  buildTrendWeights();

  // If no reddit and no local, show error
  if (appState.combinedTrends.length === 0) {
    generatorResult.classList.remove("empty");
    generatorResult.innerHTML = `<p style="text-align:center;color:var(--muted)">Unable to load any trend data. Try refreshing.</p>`;
  }
}

init();
