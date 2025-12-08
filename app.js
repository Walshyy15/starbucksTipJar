// Starbucks Partner Tips Distribution Tool
// ----------------------------------------
// - Uses Azure AI Vision API for OCR processing
// - Builds a table of Partner Name / Number / Tippable Hours
// - Computes truncated hourly rate, per-partner tips, and cash payouts
// - Rounds hourly rate down to 2 decimals; then rounds partner tips to cents
// - Finally rounds each partner's cash payout to the nearest whole dollar
//   (e.g. $44.61 -> $45 as requested)
// - Breaks payouts into $20/$10/$5/$1 bills and totals all bills needed

let partners = []; // { id, name, number, hours }
let nextPartnerId = 1;

// Common tokens and headers that should be stripped from OCR output
const METADATA_PATTERNS = [
    /Store\s*Number[:#]?\s*\d+/gi,
    /Time\s*Period:[^\n]*/gi,
    /Executed\s*By:[^\n]*/gi,
    /Executed\s*On:[^\n]*/gi,
    /Data\s*Disclaimer[^\n]*/gi,
    /Includes\s*all\s*updates[^\n]*/gi,
    /Tip\s*Distribution[^\n]*/gi,
    /Home\s*Store[^\n]*/gi,
];

// Set of metadata tokens for quick lookup during parsing
const metadataTokens = new Set([
    'store', 'number', 'time', 'period', 'executed', 'by', 'on', 'data',
    'disclaimer', 'includes', 'all', 'updates', 'tip', 'distribution',
    'home', 'partner', 'name', 'tippable', 'hours', 'total'
]);

/**
 * Strip metadata tokens from OCR text to clean up parsing
 * @param {string} text - Raw OCR text
 * @returns {string} Cleaned text with metadata removed
 */
function stripMetadataTokens(text) {
    if (!text || typeof text !== 'string') return '';

    let cleaned = text;

    // Apply all metadata patterns
    for (const pattern of METADATA_PATTERNS) {
        cleaned = cleaned.replace(pattern, ' ');
    }

    // Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
}

/**
 * Parse by splitting into potential partner entries using token buckets
 * Fallback method when line-by-line parsing fails
 */
function parseByTokenBuckets(text, tokensToSkip) {
    const entries = [];
    if (!text) return entries;

    // Split by common delimiters and look for patterns
    const tokens = text.split(/\s+/);
    let currentEntry = { nameTokens: [], number: '', hours: null };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        // Skip metadata tokens
        const cleanedToken = token.toLowerCase().replace(/[^a-z]/g, '');
        if (tokensToSkip && tokensToSkip.has(cleanedToken)) {
            continue;
        }

        // Check if it's a partner number (US followed by digits or 6+ digits)
        if (/^US\d+$/i.test(token) || /^\d{6,}$/.test(token)) {
            currentEntry.number = token;
            continue;
        }

        // Check if it's hours (decimal number between 0 and 200)
        if (/^\d+\.\d+$/.test(token)) {
            const hours = parseFloat(token);
            if (hours > 0 && hours < 200) {
                currentEntry.hours = hours;

                // Complete this entry if we have a name
                if (currentEntry.nameTokens.length > 0) {
                    const name = currentEntry.nameTokens.join(' ').trim();
                    if (name && name.length > 1 && !/^\d+$/.test(name)) {
                        entries.push({
                            name: name,
                            number: currentEntry.number,
                            hours: currentEntry.hours
                        });
                    }
                }

                // Reset for next entry
                currentEntry = { nameTokens: [], number: '', hours: null };
                continue;
            }
        }

        // Skip 5-digit store numbers
        if (/^\d{5}$/.test(token)) {
            continue;
        }

        // Otherwise, it's likely a name token
        if (token.length > 0 && !/^\d+$/.test(token)) {
            currentEntry.nameTokens.push(token);
        }
    }

    return entries;
}

// DOM references
let partnerTableBody;
let totalHoursSpan;
let totalTipsInput;
let hourlyRateDisplay;
let resultsBody;
let ocrStatusEl;
let distributionDateEl;

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
    ocrStatusEl = document.getElementById("ocr-status");
    distributionDateEl = document.getElementById("distribution-date");

    const uploadInput = document.getElementById("image-upload");
    const addRowBtn = document.getElementById("add-row-btn");
    const clearTableBtn = document.getElementById("clear-table-btn");
    const calculateBtn = document.getElementById("calculate-btn");

    uploadInput.addEventListener("change", handleImageUpload);
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

    // Bill count edit listeners - redistribute when changed
    const billInputs = ['total-twenties', 'total-tens', 'total-fives', 'total-ones'];
    billInputs.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', redistributeBills);
        }
    });

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

function setOcrStatus(message, options = {}) {
    if (!ocrStatusEl) return;

    if (options.loading) {
        const progressText = message ? `${message}` : '';
        ocrStatusEl.innerHTML = `
      <div class="ocr-loader">
        <div class="ocr-spinner" aria-hidden="true"></div>
        <div class="ocr-progress">${progressText}</div>
      </div>
    `;
        ocrStatusEl.classList.add('is-loading');
    } else {
        ocrStatusEl.textContent = message;
        ocrStatusEl.classList.remove('is-loading');
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

        setOcrStatus(`${Math.min(attempts * 2, 95)}%`, { loading: true });

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
        setOcrStatus(`${Math.min(attempts * 3, 95)}%`, { loading: true });

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
    const fileInput = event?.target || document.getElementById("image-upload");
    const file = fileInput?.files?.[0];
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

    setOcrStatus("Uploading image... 0%", { loading: true });

    try {
        // Convert file to base64
        const base64 = await fileToBase64(file);
        setOcrStatus("Processing... 10%", { loading: true });

        // Call Azure Vision API
        const text = await callAzureVisionOCR(base64);

        const normalizedText = (() => {
            if (typeof text === "string") return text;
            if (Array.isArray(text)) return text.join("\n");
            if (text == null) return "";
            return String(text);
        })();

        const cleanedText = normalizedText.trim();

        const parsed = parseOcrToPartners(cleanedText);

        if (parsed.length === 0) {
            setOcrStatus(
                "OCR finished, but no rows were detected. Enter rows manually."
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

/**
 * Parse the columnar format from Azure Document Intelligence OCR
 * This handles the case where each cell value appears on a separate line:
 * Store (header)
 * 69600 (store value)
 * Ailuogwemhe, Jodie O (name)
 * US37008498 (partner number)
 * 18.48 (hours)
 * ... repeating for each row
 */
function parseColumnarFormat(text) {
    const entries = [];
    if (!text) return entries;

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    console.log('Columnar parsing - all lines:', lines);

    // Skip patterns for header lines
    const headerPatterns = [
        /^home$/i,
        /^partner\s*name$/i,
        /^partner\s*number$/i,
        /^total\s*tippable\s*hours$/i,
        /^store$/i,
        /^total\s*tippable\s*hours:$/i,
    ];

    // Summary line pattern (e.g., "Total Tippable Hours: 278.31")
    const summaryPattern = /^total\s*tippable\s*hours:\s*[\d.]+$/i;

    // Find where the data starts by looking for the first 5-digit store number after headers
    let dataStartIndex = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check if this looks like a header
        const isHeader = headerPatterns.some(p => p.test(line));
        if (!isHeader && /^\d{5}$/.test(line)) {
            dataStartIndex = i;
            break;
        }
    }

    console.log('Data starts at index:', dataStartIndex);

    // Now extract data - expecting pattern: StoreNum, Name, PartnerNum, Hours
    // Each partner should have these 4 values on consecutive lines
    let i = dataStartIndex;
    while (i < lines.length) {
        const line = lines[i];

        // Stop if we hit a summary line
        if (summaryPattern.test(line)) {
            console.log('Hit summary line, stopping:', line);
            break;
        }

        // Skip any remaining header lines in the data section
        if (headerPatterns.some(p => p.test(line))) {
            i++;
            continue;
        }

        // Expect: 5-digit store number
        if (/^\d{5}$/.test(line)) {
            const storeNum = line;

            // Look for the next 3 lines: Name, Partner Number, Hours
            if (i + 3 < lines.length) {
                const nameLine = lines[i + 1];
                const partnerNumLine = lines[i + 2];
                const hoursLine = lines[i + 3];

                console.log(`Checking group at ${i}: store=${storeNum}, name=${nameLine}, partnerNum=${partnerNumLine}, hours=${hoursLine}`);

                // Validate the pattern
                const isValidName = nameLine &&
                    nameLine.length > 1 &&
                    !/^\d+$/.test(nameLine) &&
                    !/^US\d+$/i.test(nameLine) &&
                    !headerPatterns.some(p => p.test(nameLine));

                const isValidPartnerNum = /^US\d+$/i.test(partnerNumLine) || /^\d{6,}$/.test(partnerNumLine);
                const isValidHours = /^\d+\.?\d*$/.test(hoursLine);

                if (isValidName && isValidPartnerNum && isValidHours) {
                    const hours = parseFloat(hoursLine);
                    if (isFinite(hours) && hours > 0 && hours < 200) {
                        entries.push({
                            name: nameLine.trim(),
                            number: partnerNumLine,
                            hours: hours
                        });
                        console.log('Added entry:', entries[entries.length - 1]);
                    }
                    i += 4; // Move to next group
                    continue;
                }
            }
        }

        // Alternative pattern: Name, Partner Number, Hours (without store number on each row)
        // This handles formats where store number appears once at the beginning
        const isName = line.length > 2 &&
            !/^\d+\.?\d*$/.test(line) &&
            !/^US\d+$/i.test(line) &&
            !/^\d{5}$/.test(line) &&
            !headerPatterns.some(p => p.test(line)) &&
            !summaryPattern.test(line);

        if (isName && i + 2 < lines.length) {
            const partnerNumLine = lines[i + 1];
            const hoursLine = lines[i + 2];

            const isValidPartnerNum = /^US\d+$/i.test(partnerNumLine) || /^\d{6,}$/.test(partnerNumLine);
            const isValidHours = /^\d+\.?\d*$/.test(hoursLine);

            if (isValidPartnerNum && isValidHours) {
                const hours = parseFloat(hoursLine);
                if (isFinite(hours) && hours > 0 && hours < 200) {
                    entries.push({
                        name: line.trim(),
                        number: partnerNumLine,
                        hours: hours
                    });
                    console.log('Added entry (alt pattern):', entries[entries.length - 1]);
                    i += 3; // Move to next group
                    continue;
                }
            }
        }

        i++; // Move to next line if no pattern matched
    }

    console.log('Columnar parse found entries:', entries);
    return entries;
}

/**
 * Parser for Starbucks Tip Distribution Report format.
 * Handles multiple variations of OCR output including:
 * - Columnar format: Each field (store, name, number, hours) on separate lines
 * - "69600 Ailuogwemhe, Jodie O US37008498 9.22" (full format on single line)
 * - "Ailuogwemhe, Jodie O US37008498 9.22" (without store)
 * - "Name 32.56" (simple format)
 * - Table cell data extracted separately
 */
function parseOcrToPartners(text) {
    console.log('Parsing OCR text:', text);

    // First, try columnar parsing for Azure Document Intelligence format
    const columnarResult = parseColumnarFormat(text);
    if (columnarResult.length > 0) {
        console.log('Columnar parsing succeeded:', columnarResult);
        return columnarResult;
    }

    const metadataStrip = stripMetadataTokens(text);

    const lines = metadataStrip.split(/\r?\n/);
    const parsed = [];

    // Helper to add entry avoiding duplicates
    function addEntry(entry) {
        if (!entry || !entry.name || entry.name.length < 2) return;
        // Check for duplicate by name (case-insensitive)
        const exists = parsed.some(p =>
            p.name.toLowerCase().trim() === entry.name.toLowerCase().trim()
        );
        if (!exists) {
            parsed.push(entry);
        }
    }

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
        /^\d{1,2}\/\d{1,2}\/\d{2,4}/,  // Date at start (MM/DD/YYYY or M/D/YY)
        /\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{2,4}/,  // Date range
        /\d{2}:\d{2}:\d{2}/,  // Time stamp (HH:MM:SS)
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

        // Skip metadata lines that were merged into partner text
        if (line.length > 120 && /(executed|time period|store number|data disclaimer)/i.test(line)) {
            console.log('Skipping merged metadata line:', line);
            continue;
        }

        // Skip metadata lines that were merged into partner text
        if (line.length > 120 && /(executed|time period|store number|data disclaimer)/i.test(line)) {
            console.log('Skipping merged metadata line:', line);
            continue;
        }

        const cleanedLine = stripMetadataTokens(line);

        if (!cleanedLine || cleanedLine.length < 3) {
            console.log('Line reduced to metadata only, skipping:', line);
            continue;
        }

        console.log('Processing line:', cleanedLine);

        // Pattern 1: Full Starbucks format with 5-digit store number
        // "69600 Ailuogwemhe, Jodie O US37008498 9.22"
        let match = cleanedLine.match(/^(\d{5})\s+(.+?)\s+(US\d+)\s+(\d+\.?\d*)$/i);
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
        match = cleanedLine.match(/^(.+?)\s+(US\d+)\s+(\d+\.?\d*)$/i);
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
        match = cleanedLine.match(/^(.+?)\s+(\d{6,})\s+(\d+\.?\d*)$/);
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
        match = cleanedLine.match(/^(.+?)\s+(\d+\.\d+)$/);
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
        const tokens = cleanedLine.split(/\s+/);
        if (tokens.length >= 2) {
            const lastToken = tokens[tokens.length - 1];

            // Check if last token is a valid hours number
            if (/^\d+\.?\d*$/.test(lastToken)) {
                const hours = parseFloat(lastToken);

                if (isFinite(hours) && hours > 0 && hours < 200) {
                    let number = "";
                    let nameTokens = tokens.slice(0, -1).filter((tok) => {
                        const cleaned = tok.toLowerCase().replace(/[^a-z]/g, '');
                        return cleaned ? !metadataTokens.has(cleaned) : true;
                    });

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

                    if (name && name.length > 1 && nameTokens.length <= 6 && !/^\d+$/.test(name)) {
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
        const fallbackEntries = parseByTokenBuckets(metadataStrip, metadataTokens);
        if (fallbackEntries.length > 0) {
            console.log('Fallback token parse results:', fallbackEntries);
            fallbackEntries.forEach(addEntry);
        }
    }

    console.log('Parsed results:', parsed);
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
        <button class="icon-button" type="button" title="Remove partner" data-action="delete" aria-label="Remove partner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
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

        // Final cash payout is rounded to the nearest whole dollar
        // e.g. 44.61 => 45; 44.40 => 44.
        const wholeDollarPayout = decimalTip > 0 ? Math.round(decimalTip + 1e-8) : 0;

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

    // Store results for redistribution feature
    lastCalculationResults = results;
    lastHourlyRate = hourlyRateTruncated;

    renderResultsTable(results, hourlyRateTruncated);
    renderSummary(
        hourlyRateTruncated,
        totalTipsVal,
        sumDecimalTips,
        sumWholeDollarPayout,
        totalHours,
        totalsBills
    );
}

function clearResults() {
    const resultsSection = document.getElementById('results-section');
    if (resultsSection) {
        resultsSection.classList.remove('visible');
    }
    if (resultsBody) {
        resultsBody.innerHTML = "";
    }
}

// ---------- RESULTS RENDERING ----------

function renderResultsTable(rows, hourlyRate) {
    const resultsSection = document.getElementById('results-section');
    if (!resultsBody) return;
    resultsBody.innerHTML = "";

    rows.forEach((r) => {
        const card = document.createElement("div");
        card.className = "partner-card";
        const safeName = escapeHtml(r.name || "Partner");

        // Build bill chips - only show denominations that are > 0
        const chips = [];
        if (r.breakdown.twenties > 0) chips.push(`${r.breakdown.twenties}×$20`);
        if (r.breakdown.tens > 0) chips.push(`${r.breakdown.tens}×$10`);
        if (r.breakdown.fives > 0) chips.push(`${r.breakdown.fives}×$5`);
        if (r.breakdown.ones > 0) chips.push(`${r.breakdown.ones}×$1`);

        const billChipsHtml = chips.map(c => `<span class="bill-chip">${c}</span>`).join('');

        // Calculation formula: 9.22 × $1.37 = $12.63 → $13
        const calcFormula = `${r.hours.toFixed(2)} × $${hourlyRate.toFixed(2)} = $${r.decimalTip.toFixed(2)} → $${r.wholeDollarPayout}`;

        card.innerHTML = `
      <div class="partner-header">
        <div class="partner-info">
          <div class="partner-name">${safeName}</div>
          <div class="partner-hours">${r.hours.toFixed(2)} hours</div>
        </div>
        <div class="payout-amount">$${r.wholeDollarPayout}</div>
      </div>
      <div class="partner-calc">${calcFormula}</div>
      <div class="bill-chips">${billChipsHtml}</div>
    `;

        resultsBody.appendChild(card);
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
    totalHours,
    totalsBills
) {
    // Update calc formula
    const calcFormula = document.getElementById('calc-formula');
    if (calcFormula) {
        calcFormula.textContent = `Total Tips: $${totalTipsVal.toFixed(2)} ÷ Total Hours: ${totalHours.toFixed(2)} = $${hourlyRateTruncated.toFixed(2)} per hour`;
    }

    // Update editable bill input fields
    const twentiesInput = document.getElementById('total-twenties');
    const tensInput = document.getElementById('total-tens');
    const fivesInput = document.getElementById('total-fives');
    const onesInput = document.getElementById('total-ones');

    if (twentiesInput) twentiesInput.value = totalsBills.twenties;
    if (tensInput) tensInput.value = totalsBills.tens;
    if (fivesInput) fivesInput.value = totalsBills.fives;
    if (onesInput) onesInput.value = totalsBills.ones;

    // Update distribution date
    if (distributionDateEl) {
        const now = new Date();
        const options = { month: 'short', day: 'numeric', year: 'numeric' };
        distributionDateEl.textContent = now.toLocaleDateString('en-US', options);
    }
}

// Store the last calculation results for redistribution
let lastCalculationResults = [];
let lastHourlyRate = 0;

/**
 * Redistribute bills when user manually edits the bill counts.
 * This function reads the edited bill totals and redistributes them
 * across partners based on their payout amounts.
 * If one bill type is insufficient, it will try to make up the difference
 * using other denominations.
 */
function redistributeBills() {
    if (lastCalculationResults.length === 0) return;

    // Read current bill counts from inputs
    const twentiesInput = document.getElementById('total-twenties');
    const tensInput = document.getElementById('total-tens');
    const fivesInput = document.getElementById('total-fives');
    const onesInput = document.getElementById('total-ones');

    let availableBills = {
        twenties: parseInt(twentiesInput?.value) || 0,
        tens: parseInt(tensInput?.value) || 0,
        fives: parseInt(fivesInput?.value) || 0,
        ones: parseInt(onesInput?.value) || 0
    };

    // Calculate total available cash
    const totalAvailable = (availableBills.twenties * 20) +
        (availableBills.tens * 10) +
        (availableBills.fives * 5) +
        (availableBills.ones * 1);

    // Calculate total needed
    const totalNeeded = lastCalculationResults.reduce((sum, p) => sum + p.wholeDollarPayout, 0);

    // If not enough total cash, we can't fully redistribute
    // But we'll still do our best with what's available

    // Redistribute bills to partners based on their payout
    const updatedResults = [];
    let remainingBills = { ...availableBills };

    // Track totals for updating the UI
    let usedBills = { twenties: 0, tens: 0, fives: 0, ones: 0 };

    // Sort partners by payout (highest first) to allocate larger bills first
    const sortedResults = [...lastCalculationResults].sort((a, b) => b.wholeDollarPayout - a.wholeDollarPayout);

    for (const partner of sortedResults) {
        let remaining = partner.wholeDollarPayout;
        const breakdown = { twenties: 0, tens: 0, fives: 0, ones: 0 };

        // Try to allocate bills in order of preference: $20, $10, $5, $1
        // Allocate twenties
        while (remaining >= 20 && remainingBills.twenties > 0) {
            breakdown.twenties++;
            remainingBills.twenties--;
            remaining -= 20;
        }

        // Allocate tens
        while (remaining >= 10 && remainingBills.tens > 0) {
            breakdown.tens++;
            remainingBills.tens--;
            remaining -= 10;
        }

        // Allocate fives
        while (remaining >= 5 && remainingBills.fives > 0) {
            breakdown.fives++;
            remainingBills.fives--;
            remaining -= 5;
        }

        // Allocate ones
        while (remaining >= 1 && remainingBills.ones > 0) {
            breakdown.ones++;
            remainingBills.ones--;
            remaining -= 1;
        }

        // If still have remaining, try to make change from larger bills
        // e.g., if we need $3 but have no $1s, use a $5 and note overpayment
        if (remaining > 0) {
            // Try to use a $5 for remaining 1-4, or $10 for remaining 5-9, etc.
            if (remaining <= 4 && remainingBills.fives > 0) {
                breakdown.fives++;
                remainingBills.fives--;
                remaining = 0; // Slight overpay is acceptable
            } else if (remaining <= 9 && remainingBills.tens > 0) {
                breakdown.tens++;
                remainingBills.tens--;
                remaining = 0;
            } else if (remaining <= 19 && remainingBills.twenties > 0) {
                breakdown.twenties++;
                remainingBills.twenties--;
                remaining = 0;
            }
        }

        // Track used bills
        usedBills.twenties += breakdown.twenties;
        usedBills.tens += breakdown.tens;
        usedBills.fives += breakdown.fives;
        usedBills.ones += breakdown.ones;

        updatedResults.push({
            ...partner,
            breakdown,
            adjustedPayout: partner.wholeDollarPayout - remaining
        });
    }

    // Re-render partner cards with new breakdown
    renderResultsTable(updatedResults, lastHourlyRate);
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
