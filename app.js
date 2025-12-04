// Starbucks Partner Tips Distribution Tool
// ----------------------------------------
// - Uses Azure AI Vision API for OCR processing
// - Builds a table of Partner Name / Number / Tippable Hours
// - Computes truncated hourly rate, per-partner tips, and cash payouts
// - Rounds hourly rate down to 2 decimals; then rounds partner tips to cents
// - Finally rounds each partner's cash payout UP to the next whole dollar
//   (e.g. $44.61 -> $45 as requested)
// - Breaks payouts into $20/$10/$5/$1 bills and totals all bills needed

let partners = []; // { id, name, number, hours }
let nextPartnerId = 1;

// DOM references
let partnerTableBody;
let totalHoursSpan;
let totalTipsInput;
let hourlyRateDisplay;
let resultsBody;
let billsSummary;
let ocrStatusEl;
let ocrRawTextEl;

// Azure AI Vision API Configuration
function getAzureConfig() {
    const config = window.AZURE_CONFIG || {};
    return {
        endpoint: config.endpoint || '',
        apiKey: config.apiKey || ''
    };
}

document.addEventListener("DOMContentLoaded", () => {
    partnerTableBody = document.getElementById("partner-table-body");
    totalHoursSpan = document.getElementById("total-hours");
    totalTipsInput = document.getElementById("total-tips");
    hourlyRateDisplay = document.getElementById("hourly-rate-display");
    resultsBody = document.getElementById("results-body");
    billsSummary = document.getElementById("bills-summary");
    ocrStatusEl = document.getElementById("ocr-status");
    ocrRawTextEl = document.getElementById("ocr-raw-text");

    const uploadInput = document.getElementById("image-upload");
    const parseTextBtn = document.getElementById("parse-text-btn");
    const addRowBtn = document.getElementById("add-row-btn");
    const clearTableBtn = document.getElementById("clear-table-btn");
    const calculateBtn = document.getElementById("calculate-btn");

    uploadInput.addEventListener("change", handleImageUpload);
    parseTextBtn.addEventListener("click", handleParseTextToTable);
    addRowBtn.addEventListener("click", () => {
        addEmptyPartnerRow();
        renderPartnerTable();
        updateTotalHours();
    });
    clearTableBtn.addEventListener("click", () => {
        partners = [];
        renderPartnerTable();
        updateTotalHours();
        clearResults();
    });
    calculateBtn.addEventListener("click", runCalculations);

    // Check Azure configuration
    const config = getAzureConfig();
    if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__' ||
        !config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
        console.warn("Azure Vision API not configured. OCR will not work until credentials are set.");
    }

    // Start with one blank row for convenience
    addEmptyPartnerRow();
    renderPartnerTable();
    updateTotalHours();
});

// ---------- OCR HANDLING ----------

function setOcrStatus(message) {
    if (ocrStatusEl) {
        ocrStatusEl.textContent = message;
    }
}

/**
 * Convert a File object to base64 string
 */
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // Remove the data URL prefix to get just the base64 string
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Call Azure AI Vision Read API
 * Uses the Read API for better accuracy with formatted text
 */
async function callAzureVisionOCR(imageBase64) {
    const config = getAzureConfig();

    if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__') {
        throw new Error("Azure Vision endpoint not configured. Please set up your environment variables.");
    }

    if (!config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
        throw new Error("Azure Vision API key not configured. Please set up your environment variables.");
    }

    // Ensure endpoint doesn't have trailing slash
    const endpoint = config.endpoint.replace(/\/$/, '');

    // Step 1: Submit the image for analysis using Read API
    const analyzeUrl = `${endpoint}/vision/v3.2/read/analyze`;

    const submitResponse = await fetch(analyzeUrl, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': config.apiKey,
            'Content-Type': 'application/octet-stream'
        },
        body: base64ToArrayBuffer(imageBase64)
    });

    if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        console.error('Azure API Error:', errorText);
        throw new Error(`Azure API error: ${submitResponse.status} - ${submitResponse.statusText}`);
    }

    // Step 2: Get the operation location from headers
    const operationLocation = submitResponse.headers.get('Operation-Location');
    if (!operationLocation) {
        throw new Error("No operation location returned from Azure");
    }

    // Step 3: Poll for results
    let result = null;
    let attempts = 0;
    const maxAttempts = 30; // Max 30 seconds wait

    while (attempts < maxAttempts) {
        await sleep(1000); // Wait 1 second between polls
        attempts++;

        setOcrStatus(`Processing image… ${Math.min(attempts * 3, 95)}%`);

        const resultResponse = await fetch(operationLocation, {
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': config.apiKey
            }
        });

        if (!resultResponse.ok) {
            throw new Error(`Failed to get results: ${resultResponse.status}`);
        }

        result = await resultResponse.json();

        if (result.status === 'succeeded') {
            break;
        } else if (result.status === 'failed') {
            throw new Error("Azure Vision analysis failed");
        }
        // Otherwise, status is 'running' or 'notStarted', keep polling
    }

    if (!result || result.status !== 'succeeded') {
        throw new Error("Timeout waiting for Azure Vision results");
    }

    // Extract text from results
    const lines = [];
    if (result.analyzeResult && result.analyzeResult.readResults) {
        for (const page of result.analyzeResult.readResults) {
            for (const line of page.lines || []) {
                lines.push(line.text);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Helper function to convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Helper function to sleep for a given number of milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    const config = getAzureConfig();
    if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__' ||
        !config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
        setOcrStatus("Azure Vision API not configured. Please set up environment variables.");
        return;
    }

    setOcrStatus("Uploading image to Azure AI Vision… 0%");

    try {
        // Convert file to base64
        const base64 = await fileToBase64(file);
        setOcrStatus("Processing with Azure AI Vision… 10%");

        // Call Azure Vision API
        const text = await callAzureVisionOCR(base64);

        const cleanedText = text.trim();
        ocrRawTextEl.value = cleanedText;

        const parsed = parseOcrToPartners(cleanedText);

        if (parsed.length === 0) {
            setOcrStatus(
                "OCR finished, but no rows were detected. Adjust the text below or enter rows manually."
            );
            return;
        }

        partners = parsed.map((p) => ({
            id: nextPartnerId++,
            name: p.name,
            number: p.number,
            hours: p.hours,
        }));

        renderPartnerTable();
        updateTotalHours();
        clearResults();
        setOcrStatus(`OCR complete. Loaded ${partners.length} partners. Review and adjust as needed.`);
    } catch (err) {
        console.error(err);
        setOcrStatus(`Error: ${err.message}. You can still type data manually.`);
    }
}

function handleParseTextToTable() {
    const text = ocrRawTextEl.value || "";
    const parsed = parseOcrToPartners(text);

    if (parsed.length === 0) {
        alert("No valid rows found. Expected format: 'Name [Number] Hours' (e.g. 'John Doe 32.56' or 'John 1234567 32.56')");
        return;
    }

    partners = parsed.map((p) => ({
        id: nextPartnerId++,
        name: p.name,
        number: p.number,
        hours: p.hours,
    }));

    renderPartnerTable();
    updateTotalHours();
    clearResults();
    setOcrStatus(`Loaded ${partners.length} partners from text.`);
}

/**
 * Very simple parser for lines in the form:
 *   Jane Doe 1234567 32.56
 * i.e. last value = hours (number with optional decimals),
 *      second-to-last value = partner number (digits),
 *      rest of the line = name.
 */
function parseOcrToPartners(text) {
    const lines = text.split(/\r?\n/);
    const parsed = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Skip header-ish lines
        if (/partner\s*name/i.test(line)) continue;
        if (/tippable/i.test(line)) continue;
        if (/hours/i.test(line) && /total/i.test(line)) continue;

        const tokens = line.split(/\s+/);
        if (tokens.length < 2) continue;

        const hoursToken = tokens[tokens.length - 1];

        // Validate hours (must be a number)
        if (!/^\d+(\.\d+)?$/.test(hoursToken)) continue;
        const hours = parseFloat(hoursToken);
        if (!isFinite(hours)) continue;

        // Check for optional partner number in the second-to-last token
        let number = "";
        let nameTokens = tokens.slice(0, -1);

        if (nameTokens.length > 0) {
            const candidateNumber = nameTokens[nameTokens.length - 1];
            // If it looks like a partner number (digits), treat it as such
            if (/^\d+$/.test(candidateNumber)) {
                number = candidateNumber;
                nameTokens.pop();
            }
        }

        const name = nameTokens.join(" ").trim();

        // We need at least a name OR a number to consider this a valid row
        if (!name && !number) continue;

        parsed.push({
            name,
            number,
            hours,
        });
    }

    return parsed;
}

// ---------- TABLE / PARTNER CRUD ----------

function addEmptyPartnerRow() {
    partners.push({
        id: nextPartnerId++,
        name: "",
        number: "",
        hours: 0,
    });
}

function renderPartnerTable() {
    if (!partnerTableBody) return;
    partnerTableBody.innerHTML = "";

    partners.forEach((p) => {
        const tr = document.createElement("tr");
        tr.dataset.partnerId = String(p.id);

        tr.innerHTML = `
      <td>
        <input
          type="text"
          class="cell-input"
          data-field="name"
          value="${escapeHtmlAttr(p.name || "")}"
          placeholder="Partner name"
        />
      </td>
      <td>
        <input
          type="text"
          class="cell-input"
          data-field="number"
          value="${escapeHtmlAttr(p.number || "")}"
          placeholder="Partner #"
        />
      </td>
      <td>
        <input
          type="number"
          class="cell-input"
          data-field="hours"
          min="0"
          step="0.01"
          value="${p.hours ? p.hours : ""}"
          placeholder="0.00"
        />
      </td>
      <td style="text-align:right;">
        <button class="icon-button" type="button" title="Remove partner" data-action="delete">
          ×
        </button>
      </td>
    `;

        partnerTableBody.appendChild(tr);
    });

    // Attach listeners (simple approach; table is not huge)
    partnerTableBody.querySelectorAll("input").forEach((input) => {
        input.addEventListener("input", handlePartnerInputChange);
    });

    partnerTableBody.querySelectorAll("button[data-action='delete']").forEach((btn) => {
        btn.addEventListener("click", handleDeletePartner);
    });
}

function handlePartnerInputChange(event) {
    const input = event.target;
    const field = input.dataset.field;
    const tr = input.closest("tr");
    if (!tr) return;

    const id = Number(tr.dataset.partnerId);
    const partner = partners.find((p) => p.id === id);
    if (!partner) return;

    if (field === "name") {
        partner.name = input.value;
    } else if (field === "number") {
        partner.number = input.value;
    } else if (field === "hours") {
        const v = parseFloat(input.value);
        partner.hours = isFinite(v) && v >= 0 ? v : 0;
        updateTotalHours();
    }
}

function handleDeletePartner(event) {
    const tr = event.target.closest("tr");
    if (!tr) return;
    const id = Number(tr.dataset.partnerId);
    partners = partners.filter((p) => p.id !== id);
    renderPartnerTable();
    updateTotalHours();
    clearResults();
}

function updateTotalHours() {
    const total = partners.reduce((sum, p) => {
        const h = typeof p.hours === "number" ? p.hours : parseFloat(p.hours);
        if (isFinite(h)) {
            return sum + h;
        }
        return sum;
    }, 0);

    if (totalHoursSpan) {
        totalHoursSpan.textContent = total.toFixed(2);
    }
}

// ---------- MATH HELPERS ----------

function truncateToTwoDecimals(value) {
    // Truncate (not round) to 2 decimals:
    // e.g. 1.3782356 -> 1.37
    return Math.floor(value * 100 + 1e-8) / 100;
}

function roundToTwoDecimals(value) {
    // Normal rounding to cents
    return Math.round(value * 100 + 1e-8) / 100;
}

function breakdownBills(amountWholeDollars) {
    // Returns { twenties, tens, fives, ones }
    let remaining = Math.max(0, Math.floor(amountWholeDollars));

    const twenties = Math.floor(remaining / 20);
    remaining -= twenties * 20;

    const tens = Math.floor(remaining / 10);
    remaining -= tens * 10;

    const fives = Math.floor(remaining / 5);
    remaining -= fives * 5;

    const ones = remaining;

    return { twenties, tens, fives, ones };
}

// ---------- MAIN CALCULATION ----------

function runCalculations() {
    clearResults();

    const totalTipsVal = parseFloat(totalTipsInput.value);
    if (!isFinite(totalTipsVal) || totalTipsVal <= 0) {
        alert("Please enter a valid positive number for total weekly tips.");
        return;
    }

    const totalHours = partners.reduce((sum, p) => {
        const h = typeof p.hours === "number" ? p.hours : parseFloat(p.hours);
        if (isFinite(h)) return sum + h;
        return sum;
    }, 0);

    if (totalHours <= 0) {
        alert("Total tippable hours must be greater than zero.");
        return;
    }

    // 1. Hourly rate = total tips / total tippable hours
    const hourlyRateRaw = totalTipsVal / totalHours;
    const hourlyRateTruncated = truncateToTwoDecimals(hourlyRateRaw);

    if (hourlyRateDisplay) {
        hourlyRateDisplay.textContent = `$${hourlyRateTruncated.toFixed(2)} per hour`;
    }

    // 2. Per-partner calculations
    const results = [];
    let sumDecimalTips = 0;
    let sumWholeDollarPayout = 0;
    const totalsBills = { twenties: 0, tens: 0, fives: 0, ones: 0 };

    partners.forEach((p) => {
        const hours = typeof p.hours === "number" ? p.hours : parseFloat(p.hours);
        const safeHours = isFinite(hours) && hours > 0 ? hours : 0;

        // Raw tip = truncated hourly rate * hours
        const rawTip = hourlyRateTruncated * safeHours;

        // Round to cents for decimal tip total
        const decimalTip = roundToTwoDecimals(rawTip);

        // Final cash payout is rounded UP to the next whole dollar
        // e.g. 44.61 => 45; 87.00 stays 87.
        const wholeDollarPayout = decimalTip > 0 ? Math.ceil(decimalTip - 1e-8) : 0;

        const breakdown = breakdownBills(wholeDollarPayout);

        sumDecimalTips += decimalTip;
        sumWholeDollarPayout += wholeDollarPayout;
        totalsBills.twenties += breakdown.twenties;
        totalsBills.tens += breakdown.tens;
        totalsBills.fives += breakdown.fives;
        totalsBills.ones += breakdown.ones;

        results.push({
            name: p.name || "",
            number: p.number || "",
            hours: safeHours,
            decimalTip,
            wholeDollarPayout,
            breakdown,
        });
    });

    renderResultsTable(results);
    renderSummary(hourlyRateTruncated, totalTipsVal, sumDecimalTips, sumWholeDollarPayout, totalsBills);
}

function clearResults() {
    if (resultsBody) {
        resultsBody.innerHTML = "";
    }
    if (billsSummary) {
        billsSummary.innerHTML =
            '<p class="muted">Once you run a calculation, you'll see a summary of all bills needed here, including total $1 bills so everyone gets their fair share.</p > ';
    }
}

// ---------- RESULTS RENDERING ----------

function renderResultsTable(rows) {
    if (!resultsBody) return;
    resultsBody.innerHTML = "";

    rows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.number)}</td>
      <td class="numeric">${r.hours.toFixed(2)}</td>
      <td class="numeric">$${r.decimalTip.toFixed(2)}</td>
      <td class="numeric">$${r.wholeDollarPayout.toFixed(0)}</td>
      <td class="numeric">${r.breakdown.twenties}</td>
      <td class="numeric">${r.breakdown.tens}</td>
      <td class="numeric">${r.breakdown.fives}</td>
      <td class="numeric">${r.breakdown.ones}</td>
    `;
        resultsBody.appendChild(tr);
    });
}

function renderSummary(
    hourlyRateTruncated,
    totalTipsVal,
    sumDecimalTips,
    sumWholeDollarPayout,
    totalsBills
) {
    if (!billsSummary) return;

    const diff = sumWholeDollarPayout - totalTipsVal;

    const diffLabel =
        diff > 0
            ? `You are paying $${diff.toFixed(
                2
            )} more in whole bills than the raw total tips (because every partner rounds up).`
            : diff < 0
                ? `You are paying $${Math.abs(diff).toFixed(
                    2
                )} less in whole bills than the raw tips (unusual with "round up"; check values).`
                : "Whole-bill payouts exactly match total tips.";

    billsSummary.innerHTML = `
    <p><strong>Summary</strong></p>
    <p>Hourly tip rate (truncated to cents): <strong>$${hourlyRateTruncated.toFixed(
        2
    )}</strong> per hour.</p>
    <p>Sum of partner tips (decimal): <strong>$${sumDecimalTips.toFixed(2)}</strong></p>
    <p>Total cash payout (whole dollars): <strong>$${sumWholeDollarPayout.toFixed(0)}</strong></p>
    <p>Total tips entered: <strong>$${totalTipsVal.toFixed(2)}</strong></p>
    <p>${diffLabel}</p>
    <p>Order this many bills to cover all partner payouts:</p>
    <ul>
      <li>$20 bills: <strong>${totalsBills.twenties}</strong></li>
      <li>$10 bills: <strong>${totalsBills.tens}</strong></li>
      <li>$5 bills: <strong>${totalsBills.fives}</strong></li>
      <li>$1 bills: <strong>${totalsBills.ones}</strong></li>
    </ul>
  `;
}

// ---------- SIMPLE HTML ESCAPING HELPERS ----------

function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeHtmlAttr(str) {
    // For attribute values inside quotes
    return escapeHtml(str).replace(/"/g, "&quot;");
}
