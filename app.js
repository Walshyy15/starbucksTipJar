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
 * Call Azure Document Intelligence (Form Recognizer) Read API
 * Uses the prebuilt-read model for document text extraction
 */
async function callAzureVisionOCR(imageBase64) {
    const config = getAzureConfig();

    if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__') {
        throw new Error("Azure endpoint not configured. Please set up your environment variables.");
    }

    if (!config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
        throw new Error("Azure API key not configured. Please set up your environment variables.");
    }

    // Ensure endpoint doesn't have trailing slash
    const endpoint = config.endpoint.replace(/\/$/, '');

    // Try Document Intelligence API first, fall back to Computer Vision
    let analyzeUrl;
    let isDocIntelligence = false;

    // Check if endpoint looks like Document Intelligence (formrecognizer or documentintelligence)
    if (endpoint.includes('cognitiveservices') && !endpoint.includes('vision')) {
        // Document Intelligence endpoint
        analyzeUrl = `${endpoint}/formrecognizer/documentModels/prebuilt-read:analyze?api-version=2023-07-31`;
        isDocIntelligence = true;
    } else {
        // Try Computer Vision endpoint
        analyzeUrl = `${endpoint}/vision/v3.2/read/analyze`;
    }

    console.log('Using API:', analyzeUrl);

    // Step 1: Submit the image for analysis
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

        // If Document Intelligence failed, try Computer Vision
        if (isDocIntelligence) {
            console.log('Trying Computer Vision API as fallback...');
            return await callComputerVisionOCR(imageBase64, config);
        }

        throw new Error(`Azure API error: ${submitResponse.status} - ${submitResponse.statusText}`);
    }

    // Step 2: Get the operation location from headers
    const operationLocation = submitResponse.headers.get('Operation-Location') ||
        submitResponse.headers.get('operation-location');
    if (!operationLocation) {
        throw new Error("No operation location returned from Azure");
    }

    console.log('Operation location:', operationLocation);

    // Step 3: Poll for results
    let result = null;
    let attempts = 0;
    const maxAttempts = 60; // Max 60 seconds wait

    while (attempts < maxAttempts) {
        await sleep(1000); // Wait 1 second between polls
        attempts++;

        setOcrStatus(`Processing image... ${Math.min(attempts * 2, 95)}%`);

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
        console.log('Poll result status:', result.status);

        if (result.status === 'succeeded' || result.status === 'completed') {
            break;
        } else if (result.status === 'failed') {
            console.error('Analysis failed:', result);
            throw new Error("Azure analysis failed");
        }
        // Otherwise, status is 'running' or 'notStarted', keep polling
    }

    if (!result || (result.status !== 'succeeded' && result.status !== 'completed')) {
        throw new Error("Timeout waiting for Azure results");
    }

    // Extract text from results - handle both API response formats
    const lines = [];

    // Document Intelligence format
    if (result.analyzeResult && result.analyzeResult.content) {
        console.log('Raw content:', result.analyzeResult.content);
        return result.analyzeResult.content;
    }

    // Document Intelligence pages format
    if (result.analyzeResult && result.analyzeResult.pages) {
        for (const page of result.analyzeResult.pages) {
            for (const line of page.lines || []) {
                lines.push(line.content || line.text);
            }
        }
        if (lines.length > 0) {
            console.log('Extracted lines:', lines);
            return lines.join('\n');
        }
    }

    // Computer Vision format
    if (result.analyzeResult && result.analyzeResult.readResults) {
        for (const page of result.analyzeResult.readResults) {
            for (const line of page.lines || []) {
                lines.push(line.text);
            }
        }
        console.log('Extracted lines:', lines);
        return lines.join('\n');
    }

    console.log('Full result:', JSON.stringify(result, null, 2));
    return lines.join('\n');
}

/**
 * Fallback: Call Azure Computer Vision Read API
 */
async function callComputerVisionOCR(imageBase64, config) {
    const endpoint = config.endpoint.replace(/\/$/, '');
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
        throw new Error(`Computer Vision API error: ${submitResponse.status}`);
    }

    const operationLocation = submitResponse.headers.get('Operation-Location');
    if (!operationLocation) {
        throw new Error("No operation location returned");
    }

    let result = null;
    let attempts = 0;

    while (attempts < 30) {
        await sleep(1000);
        attempts++;
        setOcrStatus(`Processing image... ${Math.min(attempts * 3, 95)}%`);

        const resultResponse = await fetch(operationLocation, {
            method: 'GET',
            headers: { 'Ocp-Apim-Subscription-Key': config.apiKey }
        });

        result = await resultResponse.json();
        if (result.status === 'succeeded') break;
        if (result.status === 'failed') throw new Error("Analysis failed");
    }

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

    setOcrStatus("Checking Azure configuration...");

    const config = getAzureConfig();
    if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__' ||
        !config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
        setOcrStatus("Azure Vision API not configured. Add secrets to GitHub and redeploy.");
        console.error("Azure Vision API credentials not configured. Current config:", {
            endpoint: config.endpoint ? (config.endpoint.includes('__') ? 'PLACEHOLDER' : 'SET') : 'MISSING',
            apiKey: config.apiKey ? (config.apiKey.includes('__') ? 'PLACEHOLDER' : 'SET') : 'MISSING'
        });
        alert("Azure Vision API is not configured yet.\n\n1. Go to GitHub repo Settings > Secrets > Actions\n2. Add AZURE_VISION_ENDPOINT\n3. Add AZURE_VISION_API_KEY\n4. Re-run the deployment workflow");
        return;
    }

    setOcrStatus("Uploading image to Azure AI Vision... 0%");

    try {
        // Convert file to base64
        const base64 = await fileToBase64(file);
        setOcrStatus("Processing with Azure AI Vision... 10%");

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
 * Parser for Starbucks Tip Distribution Report format.
 * Handles multiple variations of OCR output including:
 * - "69600 Ailuogwemhe, Jodie O US37008498 9.22" (full format)
 * - "Ailuogwemhe, Jodie O US37008498 9.22" (without store)
 * - "Name 32.56" (simple format)
 * - Table cell data extracted separately
 */
function parseOcrToPartners(text) {
    console.log('Parsing OCR text:', text);

    const lines = text.split(/\r?\n/);
    const parsed = [];
    const seen = new Set();

    const addEntry = (entry) => {
        if (!entry || !entry.name || !isFinite(entry.hours)) return;
        const key = `${entry.name.toLowerCase()}|${(entry.number || "").toLowerCase()}|${entry.hours}`;
        if (seen.has(key)) return;
        seen.add(key);
        parsed.push(entry);
    };

    // Skip patterns - headers and metadata
    const skipPatterns = [
        /partner\s*name/i,
        /home\s*store/i,
        /tippable.*hours/i,
        /total\s*tippable/i,
        /time\s*period/i,
        /executed/i,
        /store\s*number/i,
        /data\s*disclaimer/i,
        /tip\s*distribution/i,
        /^\s*total\s*$/i,
        /includes\s*all\s*updates/i,
        /^\d{2}\/\d{2}\/\d{4}/,  // Date patterns
    ];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.length < 3) continue;

        // Check skip patterns
        let shouldSkip = false;
        for (const pattern of skipPatterns) {
            if (pattern.test(line)) {
                shouldSkip = true;
                break;
            }
        }
        if (shouldSkip) {
            console.log('Skipping line:', line);
            continue;
        }

        console.log('Processing line:', line);

        // Pattern 1: Full Starbucks format with 5-digit store number
        // "69600 Ailuogwemhe, Jodie O US37008498 9.22"
        let match = line.match(/^(\d{5})\s+(.+?)\s+(US\d+)\s+(\d+\.?\d*)$/i);
        if (match) {
            const entry = { name: match[2].trim(), number: match[3], hours: parseFloat(match[4]) };
            console.log('Pattern 1 match:', entry);
            if (entry.name && isFinite(entry.hours)) {
                addEntry(entry);
                continue;
            }
        }

        // Pattern 2: Without store number, with US partner number
        // "Ailuogwemhe, Jodie O US37008498 9.22"
        match = line.match(/^(.+?)\s+(US\d+)\s+(\d+\.?\d*)$/i);
        if (match) {
            const entry = { name: match[1].trim(), number: match[2], hours: parseFloat(match[3]) };
            console.log('Pattern 2 match:', entry);
            if (entry.name && !entry.name.match(/^\d{5}$/) && isFinite(entry.hours)) {
                addEntry(entry);
                continue;
            }
        }

        // Pattern 3: Name with any numeric ID (6+ digits) and hours
        // "John Doe 1234567 32.56"  
        match = line.match(/^(.+?)\s+(\d{6,})\s+(\d+\.?\d*)$/);
        if (match) {
            const entry = { name: match[1].trim(), number: match[2], hours: parseFloat(match[3]) };
            console.log('Pattern 3 match:', entry);
            if (entry.name && isFinite(entry.hours)) {
                addEntry(entry);
                continue;
            }
        }

        // Pattern 4: Just name and hours (decimal number at end)
        // "John Doe 32.56"
        match = line.match(/^(.+?)\s+(\d+\.\d+)$/);
        if (match) {
            const nameCandidate = match[1].trim();
            const hours = parseFloat(match[2]);
            // Exclude if name is just numbers or a store number
            if (nameCandidate && !/^\d+$/.test(nameCandidate) && isFinite(hours) && hours > 0 && hours < 200) {
                const entry = { name: nameCandidate, number: "", hours };
                console.log('Pattern 4 match:', entry);
                addEntry(entry);
                continue;
            }
        }

        // Pattern 5: Flexible token-based parsing
        const tokens = line.split(/\s+/);
        if (tokens.length >= 2) {
            const lastToken = tokens[tokens.length - 1];

            // Check if last token is a valid hours number
            if (/^\d+\.?\d*$/.test(lastToken)) {
                const hours = parseFloat(lastToken);

                if (isFinite(hours) && hours > 0 && hours < 200) {
                    let number = "";
                    let nameTokens = tokens.slice(0, -1);

                    // Check if second-to-last is a partner number
                    if (nameTokens.length > 0) {
                        const lastNameToken = nameTokens[nameTokens.length - 1];
                        if (/^US\d+$/i.test(lastNameToken) || /^\d{6,}$/.test(lastNameToken)) {
                            number = lastNameToken;
                            nameTokens = nameTokens.slice(0, -1);
                        }
                    }

                    // Remove 5-digit store number from beginning
                    if (nameTokens.length > 0 && /^\d{5}$/.test(nameTokens[0])) {
                        nameTokens = nameTokens.slice(1);
                    }

                    const name = nameTokens.join(" ").trim();

                    if (name && name.length > 1 && !/^\d+$/.test(name)) {
                        const entry = { name, number, hours };
                        console.log('Pattern 5 match:', entry);
                        addEntry(entry);
                    }
                }
            }
        }
    }

    // Fallback: token-bucket parsing for when OCR returns a single line or mangled spacing
    if (parsed.length === 0) {
        const fallbackEntries = parseByTokenBuckets(text);
        if (fallbackEntries.length > 0) {
            console.log('Fallback token parse results:', fallbackEntries);
            fallbackEntries.forEach(addEntry);
        }
    }

    console.log('Parsed results:', parsed);
    return parsed;

    function parseByTokenBuckets(rawText) {
        const tokens = rawText.split(/\s+/).filter(Boolean);
        const headerTokens = new Set([
            'home', 'store', 'partner', 'name', 'number', 'total', 'tippable', 'hours',
            'time', 'period', 'report', 'tip', 'distribution', 'weekly', 'week', 'ending',
        ]);

        const entries = [];
        let bucket = [];

        for (const token of tokens) {
            const normalizedHoursToken = token.replace(/[^0-9.]/g, '');
            bucket.push(token);

            if (/^\d+\.?\d*$/.test(normalizedHoursToken)) {
                const hours = parseFloat(normalizedHoursToken);

                if (isFinite(hours) && hours > 0 && hours < 200) {
                    const candidateTokens = bucket.slice(0, -1);
                    let number = "";

                    if (candidateTokens.length > 0) {
                        const lastToken = candidateTokens[candidateTokens.length - 1].replace(/[^A-Za-z0-9]/g, '');
                        if (/^US\d+$/i.test(lastToken) || /^\d{6,}$/.test(lastToken)) {
                            number = lastToken;
                            candidateTokens.pop();
                        }
                    }

                    if (candidateTokens.length > 0 && /^\d{5}$/.test(candidateTokens[0])) {
                        candidateTokens.shift();
                    }

                    const filteredNameTokens = candidateTokens.filter((t) => {
                        const cleaned = t.toLowerCase().replace(/[^a-z]/g, '');
                        return cleaned && !headerTokens.has(cleaned);
                    });

                    const name = filteredNameTokens.join(" ").trim();

                    if (name && /[a-z]/i.test(name)) {
                        entries.push({ name, number, hours });
                    }

                    bucket = [];
                }
            }

            if (bucket.length > 20) {
                bucket = bucket.slice(-10);
            }
        }

        return entries;
    }
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
          x
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
    const resultsSection = document.getElementById('results-section');
    if (resultsSection) {
        resultsSection.classList.remove('visible');
    }
    if (resultsBody) {
        resultsBody.innerHTML = "";
    }
    if (billsSummary) {
        billsSummary.innerHTML = '';
    }
}

// ---------- RESULTS RENDERING ----------

function renderResultsTable(rows) {
    const resultsSection = document.getElementById('results-section');
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

    // Show results section
    if (resultsSection) {
        resultsSection.classList.add('visible');
    }
}

function renderSummary(
    hourlyRateTruncated,
    totalTipsVal,
    sumDecimalTips,
    sumWholeDollarPayout,
    totalsBills
) {
    if (!billsSummary) return;

    billsSummary.innerHTML = `
    <p><strong>$${hourlyRateTruncated.toFixed(2)}</strong> per hour &bull; <strong>$${sumWholeDollarPayout.toFixed(0)}</strong> total payout</p>
    <ul>
      <li>$20<strong>${totalsBills.twenties}</strong></li>
      <li>$10<strong>${totalsBills.tens}</strong></li>
      <li>$5<strong>${totalsBills.fives}</strong></li>
      <li>$1<strong>${totalsBills.ones}</strong></li>
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
