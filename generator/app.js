const TREND_DATA_PATH = "./data/trends.json";

const appState = {
  trends: [],
  trendingWeights: {
    bases: new Map(),
    ingredients: new Map(),
    combos: new Map()
  }
};

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

const baseOptions = [
  "Latte",
  "Iced Latte",
  "Cold Brew",
  "Iced Chai Tea Latte",
  "Shaken Espresso",
  "Iced Matcha Latte",
  "Refresher",
  "Flat White"
];

const ingredientCatalog = {
  milks: ["oatmilk", "almondmilk", "coconutmilk", "2% milk", "nonfat milk"],
  syrups: [
    "vanilla syrup",
    "brown sugar syrup",
    "toffee nut syrup",
    "caramel syrup",
    "hazelnut syrup",
    "cinnamon dolce syrup",
    "honey blend"
  ],
  foams: ["vanilla sweet cream cold foam", "salted cold foam", "none"],
  toppings: ["cinnamon dust", "caramel drizzle", "cookie crumble topping", "nutmeg sprinkle", "none"]
};

const cravingInput = document.getElementById("cravingInput");
const generateBtn = document.getElementById("generateBtn");
const generatorResult = document.getElementById("generatorResult");
const messyInput = document.getElementById("messyInput");
const reconstructBtn = document.getElementById("reconstructBtn");
const reconstructResult = document.getElementById("reconstructResult");

async function init() {
  try {
    const res = await fetch(TREND_DATA_PATH);
    if (!res.ok) throw new Error("Could not load trends.json");
    appState.trends = await res.json();
    buildTrendWeights();
  } catch (error) {
    generatorResult.classList.remove("empty");
    generatorResult.innerHTML = `<p>Unable to load local trend data. ${error.message}</p>`;
  }
}

function buildTrendWeights() {
  appState.trends.forEach((trend) => {
    addWeight(appState.trendingWeights.bases, trend.base.toLowerCase(), trend.popularity);

    trend.customizations.forEach((item) => {
      addWeight(appState.trendingWeights.ingredients, item.toLowerCase(), trend.popularity);
    });

    for (let i = 0; i < trend.customizations.length - 1; i += 1) {
      const combo = [trend.customizations[i], trend.customizations[i + 1]]
        .map((token) => token.toLowerCase())
        .join(" + ");
      addWeight(appState.trendingWeights.combos, combo, trend.popularity);
    }
  });
}

function addWeight(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}

function selectedMode() {
  return document.querySelector("input[name='mode']:checked")?.value || "trending";
}

function scoreTrend(trend, craving) {
  const cravingText = craving.toLowerCase();
  let score = trend.popularity;

  if (trend.tags.some((tag) => cravingText.includes(tag))) score += 24;
  if (trend.customizations.some((item) => cravingText.includes(item.split(" ")[0]))) score += 16;
  if (cravingText.includes("sweet") && trend.tags.includes("dessert")) score += 10;
  if (cravingText.includes("refresh") && trend.tags.includes("refreshing")) score += 10;
  if (cravingText.includes("cozy") && trend.tags.includes("cozy")) score += 10;

  return score;
}

function weightedPick(items, weightAccessor) {
  const weighted = items
    .map((item) => ({ item, weight: Math.max(1, weightAccessor(item)) }))
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

function generateDrink(craving, mode) {
  const generationPrompt = promptTemplates.generation
    .replace("{{craving}}", craving || "surprise me")
    .replace("{{mode}}", mode);
  const trendPrompt = promptTemplates.trendReasoning;
  void generationPrompt;
  void trendPrompt;

  if (!appState.trends.length) {
    return {
      name: "Cozy Vanilla Brew",
      base: "Cold Brew",
      customizations: ["oatmilk splash", "vanilla syrup", "cinnamon dust"],
      flavor: "lightly sweet and smooth",
      reason: "Fallback suggestion while trend data is unavailable."
    };
  }

  const lowerCraving = (craving || "").toLowerCase();
  const ranked = [...appState.trends].sort((a, b) => scoreTrend(b, lowerCraving) - scoreTrend(a, lowerCraving));

  if (mode === "trending") {
    const top = ranked.slice(0, 6);
    const picked = weightedPick(top, (trend) => scoreTrend(trend, lowerCraving));

    return {
      name: picked.name,
      base: picked.base,
      customizations: picked.customizations,
      flavor: picked.flavor,
      reason: `Suggested from high-signal trend combinations with tags: ${picked.tags.join(", ")}.`
    };
  }

  const base = weightedPick(baseOptions, (candidate) => appState.trendingWeights.bases.get(candidate.toLowerCase()) || 40);
  const milk = weightedPick(ingredientCatalog.milks, (item) => appState.trendingWeights.ingredients.get(item) || 20);
  const syrup1 = weightedPick(ingredientCatalog.syrups, (item) => appState.trendingWeights.ingredients.get(item) || 20);
  const syrup2 = weightedPick(
    ingredientCatalog.syrups.filter((item) => item !== syrup1),
    (item) => appState.trendingWeights.ingredients.get(item) || 15
  );
  const foam = weightedPick(ingredientCatalog.foams, (item) => appState.trendingWeights.ingredients.get(item) || 12);
  const topping = weightedPick(ingredientCatalog.toppings, (item) => appState.trendingWeights.ingredients.get(item) || 10);

  const creativeName = `${capitalize(syrup1.split(" ")[0])} ${capitalize(base.split(" ")[0])} Remix`;
  const customizations = [milk, syrup1, syrup2, foam, topping].filter((item) => item !== "none");

  return {
    name: creativeName,
    base,
    customizations,
    flavor: buildFlavorDescription(customizations, lowerCraving),
    reason:
      "Creative mode blended weighted trending ingredients with a novelty twist while keeping combinations realistic."
  };
}

function buildFlavorDescription(items, craving) {
  const words = [];
  if (items.some((i) => i.includes("vanilla") || i.includes("caramel") || i.includes("white mocha"))) {
    words.push("sweet");
  }
  if (items.some((i) => i.includes("cinnamon") || i.includes("chai") || i.includes("brown sugar"))) {
    words.push("spiced");
  }
  if (items.some((i) => i.includes("cold foam") || i.includes("sweet cream"))) {
    words.push("creamy");
  }
  if (craving.includes("refresh") || items.some((i) => i.includes("lemonade") || i.includes("coconut"))) {
    words.push("refreshing");
  }
  return words.length ? `${[...new Set(words)].join(", ")} profile` : "balanced and smooth profile";
}

function renderGeneratedDrink(drink) {
  generatorResult.classList.remove("empty");
  generatorResult.innerHTML = `
    <div class="result-grid">
      <div class="result-row"><strong>Drink Name</strong><span>${escapeHtml(drink.name)}</span></div>
      <div class="result-row"><strong>Base drink</strong><span>${escapeHtml(drink.base)}</span></div>
      <div class="result-row"><strong>Customizations</strong><span>${escapeHtml(drink.customizations.join(" • "))}</span></div>
      <div class="result-row"><strong>Flavor profile</strong><span>${escapeHtml(drink.flavor)}</span></div>
      <div class="result-row"><strong>Why it was suggested</strong><span>${escapeHtml(drink.reason)}</span></div>
      <div class="result-row"><strong>Note</strong><span>Custom fan-made Starbucks-style drink (not an official Starbucks menu item).</span></div>
    </div>
  `;
}

function parseMessyOrder(text) {
  const parsePrompt = promptTemplates.parsing.replace("{{messy_text}}", text);
  void parsePrompt;

  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized.split(/\s+/).filter(Boolean);

  const milkKeywords = ["oatmilk", "almondmilk", "coconutmilk", "soy", "nonfat", "whole", "2%", "breve"];
  const syrupKeywords = [
    "vanilla",
    "brown sugar",
    "toffee nut",
    "hazelnut",
    "caramel",
    "mocha",
    "white mocha",
    "cinnamon dolce",
    "honey"
  ];
  const foamKeywords = ["cold foam", "sweet cream", "salted foam"];

  const lower = ` ${normalized} `;

  const drink = inferDrinkBase(lower);
  const milk = pickPhrase(lower, milkKeywords) || "Not specified";
  const syrups = syrupKeywords.filter((s) => lower.includes(s)).map(toTitle);
  const foam = pickPhrase(lower, foamKeywords) || "None";

  const claimed = new Set([
    ...milk.split(" "),
    ...foam.split(" "),
    ...syrups.flatMap((s) => s.toLowerCase().split(" ")),
    ...drink.toLowerCase().split(" ")
  ]);

  const extras = tokens
    .filter((token) => !claimed.has(token))
    .filter((token) => !["iced", "hot", "with", "and", "extra", "light", "add"].includes(token));

  return {
    drink,
    milk: toTitle(milk),
    syrups: syrups.length ? syrups : ["None"],
    foam: toTitle(foam),
    extras: extras.length ? unique(extras.map(toTitle)) : ["None"]
  };
}

function inferDrinkBase(lower) {
  if (lower.includes("chai")) return "Iced Chai Tea Latte";
  if (lower.includes("cold brew")) return "Cold Brew";
  if (lower.includes("matcha")) return "Iced Matcha Latte";
  if (lower.includes("refresher") || lower.includes("dragonfruit")) return "Refresher";
  if (lower.includes("espresso") || lower.includes("shaken")) return "Shaken Espresso";
  if (lower.includes("latte")) return "Latte";
  return "Custom Iced Latte";
}

function pickPhrase(text, phrases) {
  return phrases.find((phrase) => text.includes(phrase)) || "";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toTitle(text) {
  return text
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function unique(list) {
  return [...new Set(list)];
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

generateBtn.addEventListener("click", () => {
  const craving = cravingInput.value.trim();
  const drink = generateDrink(craving, selectedMode());
  renderGeneratedDrink(drink);
});

reconstructBtn.addEventListener("click", () => {
  const text = messyInput.value.trim();
  if (!text) {
    reconstructResult.classList.remove("empty");
    reconstructResult.innerHTML = "<p>Please enter a messy drink line first.</p>";
    return;
  }
  const parsed = parseMessyOrder(text);
  renderParsedOrder(parsed);
});

init();
