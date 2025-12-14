// Starbucks Partner Tips Distribution Tool
// ----------------------------------------
// - Uses Azure AI Vision API for OCR processing
// - Builds a table of Partner Name / Number / Tippable Hours
// - Computes truncated hourly rate, per-partner tips, and cash payouts
// - Rounds hourly rate down to 2 decimals; then rounds partner tips to cents
// - Finally rounds each partner's cash payout to the nearest whole dollar
//   (e.g. $44.61 -> $45 as requested)
// - Breaks payouts into $20/$10/$5/$1 bills and totals all bills needed

// Debug mode - set to true to see detailed console logs
// Can also be enabled via browser console: window.DEBUG_MODE = true
let DEBUG_MODE = false;

/**
 * Debug logger - only outputs when DEBUG_MODE is enabled
 * Usage: debugLog('message') or debugLog('label', data)
 */
function debugLog(...args) {
    if (DEBUG_MODE || window.DEBUG_MODE) {
        console.log('[TipJar Debug]', ...args);
    }
}

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
 * Clean partner name by removing dates, timestamps, and prefix symbols
 * Ensures all partner names use the exact same clean format
 * @param {string} name - Raw partner name from OCR
 * @returns {string} Cleaned partner name
 */
function cleanPartnerName(name) {
    if (!name || typeof name !== 'string') return '';

    let cleaned = name;

    // Remove date patterns (various formats)
    // MM/DD/YYYY, M/D/YY, MM-DD-YYYY, etc.
    cleaned = cleaned.replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, '');

    // Remove date ranges (MM/DD/YYYY - MM/DD/YYYY or similar)
    cleaned = cleaned.replace(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*[-–—]\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g, '');

    // Remove timestamps (HH:MM:SS or HH:MM)
    cleaned = cleaned.replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?\b/g, '');

    // Remove ISO-style dates (YYYY-MM-DD)
    cleaned = cleaned.replace(/\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/g, '');

    // Remove month name dates (e.g., "Dec 13, 2025" or "December 2025")
    cleaned = cleaned.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{2,4}\b/gi, '');
    cleaned = cleaned.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{2,4}\b/gi, '');

    // Remove leading prefix symbols: ~, =, -, *, •, >, », etc.
    cleaned = cleaned.replace(/^[\s~=\-\*•·>»→|:]+/, '');

    // Remove trailing prefix symbols
    cleaned = cleaned.replace(/[\s~=\-\*•·>»→|:]+$/, '');

    // Normalize multiple spaces to single space
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
                            name: cleanPartnerName(name),
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
        debugLog("Azure Vision API not configured. OCR will not work until credentials are set.");
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
 * Helper generator function to get text from content spans
 * Aligns with Azure Document Intelligence SDK patterns
 * @param {string} content - The full document content
 * @param {Array} spans - Array of span objects with offset and length
 */
function* getTextOfSpans(content, spans) {
    for (const span of spans) {
        yield content.slice(span.offset, span.offset + span.length);
    }
}

/**
 * Call Azure Document Intelligence (Form Recognizer) Layout API
 * Uses the prebuilt-layout model for table extraction from documents
 * This provides structured table data with cells for better accuracy
 * 
 * Based on Azure Document Intelligence SDK patterns:
 * https://learn.microsoft.com/azure/ai-services/document-intelligence/quickstarts/get-started-sdks-rest-api
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

    // Use Document Intelligence prebuilt-layout model for table extraction
    // API version 2024-11-30 is the latest stable version
    const modelId = 'prebuilt-layout';
    const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?api-version=2024-11-30`;

    debugLog('Using Document Intelligence Layout API:', analyzeUrl);
    debugLog('Model ID:', modelId);

    // Step 1: Submit the image for analysis (POST with binary data)
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
        debugLog('Azure API Error:', errorText);

        // Check if it's an unexpected response
        if (submitResponse.status >= 400) {
            debugLog('Trying alternative API format...');
            return await callAzureLayoutFallback(imageBase64, config);
        }
        throw new Error(`Azure API error: ${submitResponse.status} - ${errorText}`);
    }

    // Step 2: Get the operation location from headers (Long Running Operation pattern)
    const operationLocation = submitResponse.headers.get('Operation-Location') ||
        submitResponse.headers.get('operation-location');
    if (!operationLocation) {
        throw new Error("No operation location returned from Azure. Check your API configuration.");
    }

    debugLog('Operation location:', operationLocation);

    // Step 3: Poll for results using Long Running Poller pattern
    let result = null;
    let attempts = 0;
    const maxAttempts = 60; // Max 60 seconds wait

    while (attempts < maxAttempts) {
        await sleep(1000); // Wait 1 second between polls
        attempts++;

        setOcrStatus(`Analyzing document... (${attempts}s)`, { loading: true });

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
        debugLog('Poll result status:', result.status);

        // Check for completion (SDK uses 'succeeded', REST may return 'completed')
        if (result.status === 'succeeded' || result.status === 'completed') {
            break;
        } else if (result.status === 'failed') {
            debugLog('Analysis failed:', result);
            const errorMessage = result.error?.message || 'Unknown error';
            throw new Error(`Azure analysis failed: ${errorMessage}`);
        }
        // Otherwise, status is 'running' or 'notStarted', keep polling
    }

    if (!result || (result.status !== 'succeeded' && result.status !== 'completed')) {
        throw new Error("Timeout waiting for Azure results after 60 seconds");
    }

    // Get the analyzeResult from the response body
    const analyzeResult = result.analyzeResult;

    if (!analyzeResult) {
        throw new Error("No analyzeResult in response");
    }

    const content = analyzeResult.content;
    const pages = analyzeResult.pages;
    const tables = analyzeResult.tables;
    const languages = analyzeResult.languages;

    // Log extracted data for debugging
    if (pages && pages.length > 0) {
        debugLog("Pages:");
        for (const page of pages) {
            debugLog(`- Page ${page.pageNumber} (unit: ${page.unit})`);
            debugLog(`  ${page.width}x${page.height}, angle: ${page.angle}`);
            debugLog(`  ${(page.lines || []).length} lines, ${(page.words || []).length} words`);
        }
    }

    // Check for table data in the results (prebuilt-layout extracts tables)
    if (tables && tables.length > 0) {
        debugLog('Tables found:', tables.length);
        for (const table of tables) {
            debugLog(`- Extracted table: ${table.columnCount} columns, ${table.rowCount} rows (${(table.cells || []).length} cells)`);
        }

        // Extract partner data from tables
        const partners = extractPartnersFromTables(tables);

        if (partners.length > 0) {
            debugLog('Extracted partners from tables:', partners);
            // Return as special format that parseOcrToPartners can handle
            return { type: 'table_data', partners: partners };
        }
    } else {
        debugLog("No tables were extracted from the document.");
    }

    // Log detected languages
    if (languages && languages.length > 0) {
        debugLog("Languages detected:");
        for (const languageEntry of languages) {
            debugLog(`- Found language: ${languageEntry.locale} (confidence: ${languageEntry.confidence})`);
            if (content) {
                for (const text of getTextOfSpans(content, languageEntry.spans || [])) {
                    const escapedText = text.replace(/\r?\n/g, "\\n").replace(/"/g, '\\"');
                    debugLog(`  - "${escapedText.substring(0, 100)}${escapedText.length > 100 ? '...' : ''}"`);
                }
            }
        }
    }

    // Fallback to text extraction if no tables found
    if (content) {
        debugLog('Using raw content for parsing');
        debugLog('Content preview:', content.substring(0, 500));
        return content;
    }

    // Document Intelligence pages format fallback
    if (pages && pages.length > 0) {
        const lines = [];
        for (const page of pages) {
            for (const line of page.lines || []) {
                lines.push(line.content || line.text);
            }
        }
        if (lines.length > 0) {
            debugLog('Extracted lines from pages:', lines.length);
            return lines.join('\n');
        }
    }

    debugLog('Full result:', JSON.stringify(result, null, 2));
    return '';
}

/**
 * Extract partner data from Document Intelligence table cells
 * Uses smart header detection to dynamically identify columns
 * Supports various column orders and header text variations
 */
function extractPartnersFromTables(tables) {
    const partners = [];

    for (const table of tables) {
        debugLog(`Processing table: ${table.columnCount} columns, ${table.rowCount} rows`);

        // Step 1: Build a map of all cells organized by row
        const cellsByRow = new Map();

        for (const cell of table.cells || []) {
            const rowIndex = cell.rowIndex;
            if (!cellsByRow.has(rowIndex)) {
                cellsByRow.set(rowIndex, new Map());
            }
            cellsByRow.get(rowIndex).set(cell.columnIndex, (cell.content || '').trim());
        }

        // Step 2: Detect column mappings from header row (row 0)
        const columnMap = detectColumnHeaders(cellsByRow.get(0));

        if (!columnMap.hasRequiredFields()) {
            debugLog('Could not detect required columns (name and hours). Trying fallback...');
            // Try without header detection (assume fixed positions)
            const fallbackPartners = extractWithFixedColumns(cellsByRow, table.rowCount);
            partners.push(...fallbackPartners);
            continue;
        }

        debugLog('Detected column mappings:', columnMap.toJSON());

        // Step 3: Extract partner data from data rows (skip header row 0)
        for (let rowIndex = 1; rowIndex < table.rowCount; rowIndex++) {
            const rowCells = cellsByRow.get(rowIndex);
            if (!rowCells) continue;

            const partner = columnMap.extractPartner(rowCells);

            if (partner && isValidPartnerEntry(partner)) {
                partners.push(partner);
                debugLog(`Extracted partner: ${partner.name} - ${partner.hours} hours`);
            }
        }
    }

    debugLog(`Total partners extracted from tables: ${partners.length}`);
    return partners;
}

/**
 * Detect column types from header row text
 * Returns a ColumnMap object with methods to extract partner data
 */
function detectColumnHeaders(headerRow) {
    const columnMap = {
        nameCol: -1,
        numberCol: -1,
        hoursCol: -1,
        storeCol: -1,

        hasRequiredFields() {
            // At minimum, we need name and hours columns
            return this.nameCol >= 0 && this.hoursCol >= 0;
        },

        toJSON() {
            return {
                nameCol: this.nameCol,
                numberCol: this.numberCol,
                hoursCol: this.hoursCol,
                storeCol: this.storeCol
            };
        },

        extractPartner(rowCells) {
            const name = this.nameCol >= 0 ? (rowCells.get(this.nameCol) || '') : '';
            const number = this.numberCol >= 0 ? (rowCells.get(this.numberCol) || '') : '';
            const hoursStr = this.hoursCol >= 0 ? (rowCells.get(this.hoursCol) || '0') : '0';
            const store = this.storeCol >= 0 ? (rowCells.get(this.storeCol) || '') : '';

            // Parse hours - handle various formats
            const hours = parseHoursValue(hoursStr);

            return {
                name: cleanPartnerName(name.trim()),
                number: number.trim(),
                hours: hours,
                store: store.trim()
            };
        }
    };

    if (!headerRow) {
        debugLog('No header row found');
        return columnMap;
    }

    // Patterns to match different header text variations
    const namePatterns = [
        /partner\s*name/i,
        /^name$/i,
        /employee\s*name/i,
        /barista/i,
        /partner$/i
    ];

    const numberPatterns = [
        /partner\s*(number|#|no\.?|num)/i,
        /^(number|#|id)$/i,
        /employee\s*(number|#|id)/i,
        /partner\s*id/i,
        /^#$/
    ];

    const hoursPatterns = [
        /tippable\s*hours/i,
        /total\s*tippable/i,
        /hours/i,
        /^hrs$/i,
        /worked/i,
        /time/i
    ];

    const storePatterns = [
        /home\s*store/i,
        /store\s*(number|#|no\.?|num)?/i,
        /location/i,
        /^store$/i
    ];

    // Check each column header against patterns
    for (const [colIndex, headerText] of headerRow.entries()) {
        const text = headerText.toLowerCase().trim();

        debugLog(`Checking header column ${colIndex}: "${headerText}"`);

        // Check for name column
        if (columnMap.nameCol < 0) {
            for (const pattern of namePatterns) {
                if (pattern.test(headerText)) {
                    columnMap.nameCol = colIndex;
                    debugLog(`  -> Matched as NAME column`);
                    break;
                }
            }
        }

        // Check for partner number column
        if (columnMap.numberCol < 0) {
            for (const pattern of numberPatterns) {
                if (pattern.test(headerText)) {
                    columnMap.numberCol = colIndex;
                    debugLog(`  -> Matched as NUMBER column`);
                    break;
                }
            }
        }

        // Check for hours column
        if (columnMap.hoursCol < 0) {
            for (const pattern of hoursPatterns) {
                if (pattern.test(headerText)) {
                    columnMap.hoursCol = colIndex;
                    debugLog(`  -> Matched as HOURS column`);
                    break;
                }
            }
        }

        // Check for store column
        if (columnMap.storeCol < 0) {
            for (const pattern of storePatterns) {
                if (pattern.test(headerText)) {
                    columnMap.storeCol = colIndex;
                    debugLog(`  -> Matched as STORE column`);
                    break;
                }
            }
        }
    }

    return columnMap;
}

/**
 * Parse hours value from string, handling various formats
 */
function parseHoursValue(hoursStr) {
    if (!hoursStr) return 0;

    // Remove any non-numeric characters except decimal point and minus
    const cleaned = hoursStr.replace(/[^\d.\-]/g, '');
    const hours = parseFloat(cleaned);

    // Validate: hours should be between 0 and 200 (reasonable range)
    if (isFinite(hours) && hours >= 0 && hours < 200) {
        return hours;
    }

    return 0;
}

/**
 * Validate that a partner entry is valid (not a header, footer, or empty row)
 */
function isValidPartnerEntry(partner) {
    if (!partner || !partner.name) return false;

    const nameLower = partner.name.toLowerCase();
    const nameTrimmed = partner.name.trim();

    // Skip header-like rows
    if (nameLower.includes('partner name') ||
        nameLower.includes('employee name') ||
        nameLower === 'name') {
        return false;
    }

    // Skip footer/total rows
    if (nameLower.includes('total tippable') ||
        nameLower.includes('total:') ||
        nameLower === 'total' ||
        nameLower.includes('grand total')) {
        return false;
    }

    // Skip if name is too short
    if (nameTrimmed.length < 2) {
        return false;
    }

    // Skip if name is just numbers (probably a store number in wrong column)
    if (/^\d+$/.test(nameTrimmed)) {
        return false;
    }

    // Skip if name looks like a date (MM/DD/YYYY, YYYY-MM-DD, etc.)
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(nameTrimmed) ||
        /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(nameTrimmed)) {
        return false;
    }

    // Skip if name is a date range
    if (/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*[-–—]\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(nameTrimmed)) {
        return false;
    }

    // Skip if name starts with common date/range prefixes
    if (/^[\s~=\-\*•·>»→|:]+$/.test(nameTrimmed)) {
        return false;
    }

    // Must have valid hours (greater than 0)
    if (!partner.hours || partner.hours <= 0) {
        return false;
    }

    return true;
}

/**
 * Fallback: Extract partners using fixed column positions
 * Used when header detection fails
 */
function extractWithFixedColumns(cellsByRow, rowCount) {
    const partners = [];

    debugLog('Using fixed column extraction (fallback)');

    // Try common Starbucks format: Store, Name, Number, Hours
    for (let rowIndex = 1; rowIndex < rowCount; rowIndex++) {
        const rowCells = cellsByRow.get(rowIndex);
        if (!rowCells) continue;

        // Try multiple column arrangements
        let partner = null;

        // Arrangement 1: Store(0), Name(1), Number(2), Hours(3)
        partner = {
            store: rowCells.get(0) || '',
            name: cleanPartnerName(rowCells.get(1) || ''),
            number: rowCells.get(2) || '',
            hours: parseHoursValue(rowCells.get(3) || '0')
        };

        if (isValidPartnerEntry(partner)) {
            partners.push(partner);
            continue;
        }

        // Arrangement 2: Name(0), Number(1), Hours(2)
        partner = {
            store: '',
            name: cleanPartnerName(rowCells.get(0) || ''),
            number: rowCells.get(1) || '',
            hours: parseHoursValue(rowCells.get(2) || '0')
        };

        if (isValidPartnerEntry(partner)) {
            partners.push(partner);
            continue;
        }

        // Arrangement 3: Name(0), Hours(1)
        partner = {
            store: '',
            name: cleanPartnerName(rowCells.get(0) || ''),
            number: '',
            hours: parseHoursValue(rowCells.get(1) || '0')
        };

        if (isValidPartnerEntry(partner)) {
            partners.push(partner);
        }
    }

    return partners;
}

/**
 * Fallback: Try alternative API URL format for Document Intelligence
 */
async function callAzureLayoutFallback(imageBase64, config) {
    const endpoint = config.endpoint.replace(/\/$/, '');

    // Try formrecognizer path (older format)
    const analyzeUrl = `${endpoint}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`;

    debugLog('Trying fallback URL:', analyzeUrl);

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
        debugLog('Fallback API Error:', errorText);

        // Try Computer Vision as last resort
        debugLog('Trying Computer Vision API as last resort...');
        return await callComputerVisionOCR(imageBase64, config);
    }

    const operationLocation = submitResponse.headers.get('Operation-Location') ||
        submitResponse.headers.get('operation-location');
    if (!operationLocation) {
        throw new Error("No operation location returned from Azure");
    }

    let result = null;
    let attempts = 0;

    while (attempts < 60) {
        await sleep(1000);
        attempts++;
        setOcrStatus("Processing...", { loading: true });

        const resultResponse = await fetch(operationLocation, {
            method: 'GET',
            headers: { 'Ocp-Apim-Subscription-Key': config.apiKey }
        });

        result = await resultResponse.json();
        if (result.status === 'succeeded' || result.status === 'completed') break;
        if (result.status === 'failed') throw new Error("Analysis failed");
    }

    const analyzeResult = result.analyzeResult;

    // Check for tables
    if (analyzeResult && analyzeResult.tables && analyzeResult.tables.length > 0) {
        const partners = extractPartnersFromTables(analyzeResult.tables);
        if (partners.length > 0) {
            return { type: 'table_data', partners: partners };
        }
    }

    // Fallback to text
    if (analyzeResult && analyzeResult.content) {
        return analyzeResult.content;
    }

    const lines = [];
    if (analyzeResult && analyzeResult.pages) {
        for (const page of analyzeResult.pages) {
            for (const line of page.lines || []) {
                lines.push(line.content || line.text);
            }
        }
    }
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
        setOcrStatus("Processing...", { loading: true });

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

    setOcrStatus("Preparing image...");

    const config = getAzureConfig();
    if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__' ||
        !config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
        setOcrStatus("OCR not configured. Add secrets to GitHub and redeploy.");
        debugLog("Azure Vision API credentials not configured. Current config:", {
            endpoint: config.endpoint ? (config.endpoint.includes('__') ? 'PLACEHOLDER' : 'SET') : 'MISSING',
            apiKey: config.apiKey ? (config.apiKey.includes('__') ? 'PLACEHOLDER' : 'SET') : 'MISSING'
        });
        alert("Azure Vision API is not configured yet.\n\n1. Go to GitHub repo Settings > Secrets > Actions\n2. Add AZURE_VISION_ENDPOINT\n3. Add AZURE_VISION_API_KEY\n4. Re-run the deployment workflow");
        return;
    }

    setOcrStatus("Processing...", { loading: true });

    try {
        // Convert file to base64
        const base64 = await fileToBase64(file);
        setOcrStatus("Processing...", { loading: true });

        // Call Azure Vision API (now uses prebuilt-layout for table extraction)
        const result = await callAzureVisionOCR(base64);

        let parsed = [];

        // Check if we got structured table data (from prebuilt-layout)
        if (result && typeof result === 'object' && result.type === 'table_data') {
            // Direct table extraction - partners are already parsed
            debugLog('Using table data extraction, partners:', result.partners);
            parsed = result.partners.filter(p =>
                p && p.name && p.name.length > 1 &&
                !p.name.toLowerCase().includes('total') &&
                p.hours > 0
            );
        } else {
            // Fallback: Text-based OCR parsing
            const normalizedText = (() => {
                if (typeof result === "string") return result;
                if (Array.isArray(result)) return result.join("\n");
                if (result == null) return "";
                return String(result);
            })();

            const cleanedText = normalizedText.trim();
            parsed = parseOcrToPartners(cleanedText);
        }

        if (parsed.length === 0) {
            setOcrStatus(
                "OCR finished, but no rows were detected. Enter rows manually."
            );
            return;
        }

        partners = parsed.map((p) => ({
            id: nextPartnerId++,
            name: p.name,
            number: p.number || '',
            hours: p.hours || 0,
        }));

        renderPartnerTable();
        updateTotalHours();
        clearResults();
        setOcrStatus(`${partners.length} Partner${partners.length !== 1 ? 's' : ''}`);
    } catch (err) {
        debugLog(err);
        setOcrStatus(`Error: ${err.message}. You can still type data manually.`);
    }
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
    debugLog('Parsing OCR text:', text);

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
            debugLog('Skipping line:', line);
            continue;
        }

        // Skip metadata lines that were merged into partner text
        if (line.length > 120 && /(executed|time period|store number|data disclaimer)/i.test(line)) {
            debugLog('Skipping merged metadata line:', line);
            continue;
        }

        // Skip metadata lines that were merged into partner text
        if (line.length > 120 && /(executed|time period|store number|data disclaimer)/i.test(line)) {
            debugLog('Skipping merged metadata line:', line);
            continue;
        }

        const cleanedLine = stripMetadataTokens(line);

        if (!cleanedLine || cleanedLine.length < 3) {
            debugLog('Line reduced to metadata only, skipping:', line);
            continue;
        }

        debugLog('Processing line:', cleanedLine);

        // Pattern 1: Full Starbucks format with 5-digit store number
        // "69600 Ailuogwemhe, Jodie O US37008498 9.22"
        let match = cleanedLine.match(/^(\d{5})\s+(.+?)\s+(US\d+)\s+(\d+\.?\d*)$/i);
        if (match) {
            const entry = { name: cleanPartnerName(match[2].trim()), number: match[3], hours: parseFloat(match[4]) };
            debugLog('Pattern 1 match:', entry);
            if (entry.name && isFinite(entry.hours)) {
                addEntry(entry);
                continue;
            }
        }

        // Pattern 2: Without store number, with US partner number
        // "Ailuogwemhe, Jodie O US37008498 9.22"
        match = cleanedLine.match(/^(.+?)\s+(US\d+)\s+(\d+\.?\d*)$/i);
        if (match) {
            const entry = { name: cleanPartnerName(match[1].trim()), number: match[2], hours: parseFloat(match[3]) };
            debugLog('Pattern 2 match:', entry);
            if (entry.name && !entry.name.match(/^\d{5}$/) && isFinite(entry.hours)) {
                addEntry(entry);
                continue;
            }
        }

        // Pattern 3: Name with any numeric ID (6+ digits) and hours
        // "John Doe 1234567 32.56"  
        match = cleanedLine.match(/^(.+?)\s+(\d{6,})\s+(\d+\.?\d*)$/);
        if (match) {
            const entry = { name: cleanPartnerName(match[1].trim()), number: match[2], hours: parseFloat(match[3]) };
            debugLog('Pattern 3 match:', entry);
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
                const entry = { name: cleanPartnerName(nameCandidate), number: "", hours };
                debugLog('Pattern 4 match:', entry);
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
                        const entry = { name: cleanPartnerName(name), number, hours };
                        debugLog('Pattern 5 match:', entry);
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
            debugLog('Fallback token parse results:', fallbackEntries);
            fallbackEntries.forEach(addEntry);
        }
    }

    debugLog('Parsed results:', parsed);
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
