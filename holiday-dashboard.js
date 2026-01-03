/**
 * Holiday Automation Dashboard Module
 * ====================================
 * A completely separate module for handling holiday tip splits.
 * This module READS from the main app.js partners array for Regular Tips,
 * but NEVER modifies it.
 * 
 * Architecture:
 * - Left side (Regular Tips): Locked-in data from main app's uploaded report
 * - Right side (Holiday Tips): Separate upload for holiday-only hours
 * - Holiday side matches partners by name from Regular side
 * - Holiday Tips is an ADD-ON, not a replacement
 * 
 * Features:
 * - Reads regular week data from main app (already uploaded)
 * - Upload holiday-specific hours report separately
 * - Match partners between both for combined view
 * - Apply different tip amounts for normal vs holiday periods
 * - Calculate combined totals with bill breakdown
 */

// ============================================
// MODULE SCOPE - All variables are scoped here
// ============================================

const HolidayDashboard = (function () {
    'use strict';

    // Private state
    let isOpen = false;
    // Regular partners are READ from main app - never stored/modified here
    let holidayReportPartners = [];
    let calculationResults = [];

    // DOM references (set on init)
    let dashboardEl = null;
    let holidayUploadZone = null;
    let regularPartnersPreview = null;
    let holidayPartnersPreview = null;
    let calculateBtn = null;
    let resultsSection = null;

    // ============================================
    // UTILITY FUNCTIONS
    // ============================================

    /**
     * Get regular partners from main app.js
     * This reads the global `partners` array which is set by the main app's OCR upload.
     * Returns a copy to prevent any accidental modifications.
     * @returns {Array} Copy of partners array from main app
     */
    function getRegularPartnersFromMainApp() {
        // Access the global partners array from app.js
        if (typeof window.partners !== 'undefined' && Array.isArray(window.partners)) {
            // Return a deep copy so we never modify the original
            return window.partners.map(p => ({
                name: p.name || '',
                number: p.number || '',
                hours: parseFloat(p.hours) || 0
            })).filter(p => p.name && p.hours > 0);
        }
        // Fallback: try to read from DOM if partners not exposed globally
        return getPartnersFromDOM();
    }

    /**
     * Fallback: Read partners from the DOM table if global array not available
     * @returns {Array} Partners extracted from the table
     */
    function getPartnersFromDOM() {
        const tableBody = document.getElementById('partner-table-body');
        if (!tableBody) return [];

        const partners = [];
        const rows = tableBody.querySelectorAll('tr');

        rows.forEach(row => {
            const nameInput = row.querySelector('input[data-field="name"]');
            const numberInput = row.querySelector('input[data-field="number"]');
            const hoursInput = row.querySelector('input[data-field="hours"]');

            if (nameInput && hoursInput) {
                const name = nameInput.value?.trim() || '';
                const number = numberInput?.value?.trim() || '';
                const hours = parseFloat(hoursInput.value) || 0;

                if (name && hours > 0) {
                    partners.push({ name, number, hours });
                }
            }
        });

        return partners;
    }

    function debugLog(...args) {
        if (window.DEBUG_MODE) {
            console.log('[HolidayDashboard]', ...args);
        }
    }

    function escapeHtml(str) {
        if (str == null) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function truncateToTwoDecimals(value) {
        return Math.floor(value * 100 + 1e-8) / 100;
    }

    function roundToTwoDecimals(value) {
        return Math.round(value * 100 + 1e-8) / 100;
    }

    function breakdownBills(amountWholeDollars) {
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

    // ============================================
    // PARTNER NAME CLEANING (copied to be self-contained)
    // ============================================

    function cleanPartnerName(name) {
        if (!name) return '';

        let cleaned = name;

        // Remove date patterns
        cleaned = cleaned.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '');
        cleaned = cleaned.replace(/\d{1,2}-\d{1,2}-\d{2,4}/g, '');
        cleaned = cleaned.replace(/\d{4}-\d{2}-\d{2}/g, '');

        // Remove date ranges
        cleaned = cleaned.replace(/\d{1,2}\/\d{1,2}\s*[-–—]\s*\d{1,2}\/\d{1,2}/g, '');

        // Remove timestamps
        cleaned = cleaned.replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, '');

        // Remove prefix symbols
        cleaned = cleaned.replace(/^[~=\-_*#@!$%^&+]+/, '');

        // Clean up extra whitespace
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        return cleaned;
    }

    // ============================================
    // OCR PROCESSING (self-contained for this module)
    // ============================================

    function getAzureConfig() {
        if (window.AZURE_CONFIG) {
            return {
                endpoint: window.AZURE_CONFIG.endpoint,
                apiKey: window.AZURE_CONFIG.apiKey
            };
        }
        return { endpoint: '', apiKey: '' };
    }

    async function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Process uploaded image and extract partner data
     * This version has fallback mechanisms for different Azure API endpoints
     * to handle various Azure service configurations (matching app.js behavior)
     */
    async function processReportImage(file, updateStatus) {
        const config = getAzureConfig();

        if (!config.endpoint || config.endpoint === '__AZURE_VISION_ENDPOINT__' ||
            !config.apiKey || config.apiKey === '__AZURE_VISION_API_KEY__') {
            throw new Error('Azure OCR not configured');
        }

        updateStatus('Preparing image...');
        const base64 = await fileToBase64(file);

        updateStatus('Uploading to Azure...');

        const endpoint = config.endpoint.replace(/\/$/, '');

        // Try multiple API formats in sequence (matching app.js behavior)
        let result = null;

        // Try 1: Document Intelligence (2024-11-30)
        try {
            result = await tryDocumentIntelligence(endpoint, config.apiKey, base64, updateStatus);
            if (result) {
                const partners = extractPartnersFromResult(result);
                return partners;
            }
        } catch (err) {
            debugLog('Document Intelligence failed:', err.message);
        }

        // Try 2: Form Recognizer (2023-07-31)
        try {
            updateStatus('Trying alternative API...');
            result = await tryFormRecognizer(endpoint, config.apiKey, base64, updateStatus);
            if (result) {
                const partners = extractPartnersFromResult(result);
                return partners;
            }
        } catch (err) {
            debugLog('Form Recognizer failed:', err.message);
        }

        // Try 3: Computer Vision Read API (v3.2)
        try {
            updateStatus('Trying Computer Vision API...');
            result = await tryComputerVision(endpoint, config.apiKey, base64, updateStatus);
            if (result) {
                const partners = extractPartnersFromResult(result);
                return partners;
            }
        } catch (err) {
            debugLog('Computer Vision failed:', err.message);
            throw new Error('All Azure API attempts failed. Check your credentials.');
        }

        throw new Error('Could not extract data from image');
    }

    /**
     * Try Document Intelligence API (2024-11-30)
     */
    async function tryDocumentIntelligence(endpoint, apiKey, base64, updateStatus) {
        const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30`;

        debugLog('Trying Document Intelligence:', analyzeUrl);

        const submitResponse = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
                'Content-Type': 'application/octet-stream'
            },
            body: base64ToArrayBuffer(base64)
        });

        if (!submitResponse.ok) {
            const errorText = await submitResponse.text();
            debugLog('Document Intelligence error:', submitResponse.status, errorText);
            throw new Error(`API error: ${submitResponse.status}`);
        }

        const operationLocation = submitResponse.headers.get('Operation-Location') ||
            submitResponse.headers.get('apim-request-id');

        if (!operationLocation) {
            throw new Error('No operation location returned');
        }

        return await pollForResults(operationLocation, endpoint, apiKey, updateStatus, 'documentintelligence');
    }

    /**
     * Try Form Recognizer API (2023-07-31) - older format
     */
    async function tryFormRecognizer(endpoint, apiKey, base64, updateStatus) {
        const analyzeUrl = `${endpoint}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`;

        debugLog('Trying Form Recognizer:', analyzeUrl);

        const submitResponse = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
                'Content-Type': 'application/octet-stream'
            },
            body: base64ToArrayBuffer(base64)
        });

        if (!submitResponse.ok) {
            const errorText = await submitResponse.text();
            debugLog('Form Recognizer error:', submitResponse.status, errorText);
            throw new Error(`API error: ${submitResponse.status}`);
        }

        const operationLocation = submitResponse.headers.get('Operation-Location') ||
            submitResponse.headers.get('operation-location');

        if (!operationLocation) {
            throw new Error('No operation location returned');
        }

        return await pollForResults(operationLocation, endpoint, apiKey, updateStatus, 'formrecognizer');
    }

    /**
     * Try Computer Vision Read API (v3.2)
     */
    async function tryComputerVision(endpoint, apiKey, base64, updateStatus) {
        const analyzeUrl = `${endpoint}/vision/v3.2/read/analyze`;

        debugLog('Trying Computer Vision:', analyzeUrl);

        const submitResponse = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
                'Content-Type': 'application/octet-stream'
            },
            body: base64ToArrayBuffer(base64)
        });

        if (!submitResponse.ok) {
            const errorText = await submitResponse.text();
            debugLog('Computer Vision error:', submitResponse.status, errorText);
            throw new Error(`API error: ${submitResponse.status}`);
        }

        const operationLocation = submitResponse.headers.get('Operation-Location');

        if (!operationLocation) {
            throw new Error('No operation location returned');
        }

        // Poll for Computer Vision results
        let result = null;
        let attempts = 0;

        while (attempts < 30) {
            await sleep(1000);
            attempts++;
            updateStatus(`Analyzing document... (${attempts}s)`);

            const resultResponse = await fetch(operationLocation, {
                method: 'GET',
                headers: { 'Ocp-Apim-Subscription-Key': apiKey }
            });

            result = await resultResponse.json();
            if (result.status === 'succeeded') break;
            if (result.status === 'failed') throw new Error('Analysis failed');
        }

        // Convert Computer Vision format to Document Intelligence format
        if (result && result.analyzeResult && result.analyzeResult.readResults) {
            const content = [];
            for (const page of result.analyzeResult.readResults) {
                for (const line of page.lines || []) {
                    content.push(line.text);
                }
            }
            return { analyzeResult: { content: content.join('\n') } };
        }

        return null;
    }

    /**
     * Poll for results from Document Intelligence or Form Recognizer
     */
    async function pollForResults(operationLocation, endpoint, apiKey, updateStatus, apiType) {
        let result = null;
        let attempts = 0;

        const resultUrl = operationLocation.startsWith('http')
            ? operationLocation
            : `${endpoint}/${apiType}/documentModels/prebuilt-layout/analyzeResults/${operationLocation}?api-version=${apiType === 'documentintelligence' ? '2024-11-30' : '2023-07-31'}`;

        while (attempts < 30) {
            await sleep(1000);
            attempts++;
            updateStatus(`Analyzing document... (${attempts}s)`);

            const resultResponse = await fetch(resultUrl, {
                method: 'GET',
                headers: { 'Ocp-Apim-Subscription-Key': apiKey }
            });

            result = await resultResponse.json();
            if (result.status === 'succeeded' || result.status === 'completed') break;
            if (result.status === 'failed') throw new Error('Analysis failed');
        }

        return result;
    }

    /**
     * Extract partner data from Azure Document Intelligence result
     */
    function extractPartnersFromResult(result) {
        const partners = [];

        if (!result || !result.analyzeResult) {
            debugLog('No analyze result found');
            return partners;
        }

        const tables = result.analyzeResult.tables || [];
        const content = result.analyzeResult.content || '';

        // Try table extraction first
        for (const table of tables) {
            const cells = table.cells || [];
            const rowCount = table.rowCount || 0;

            // Group cells by row
            const cellsByRow = {};
            for (const cell of cells) {
                const rowIdx = cell.rowIndex;
                if (!cellsByRow[rowIdx]) cellsByRow[rowIdx] = [];
                cellsByRow[rowIdx].push(cell);
            }

            // Skip header row, process data rows
            for (let rowIdx = 1; rowIdx < rowCount; rowIdx++) {
                const rowCells = cellsByRow[rowIdx] || [];
                if (rowCells.length < 2) continue;

                // Sort cells by column index
                rowCells.sort((a, b) => a.columnIndex - b.columnIndex);

                // Try to extract name and hours
                let name = '';
                let hours = 0;
                let number = '';

                for (const cell of rowCells) {
                    const text = (cell.content || '').trim();

                    // Check if it's a hours value (decimal number)
                    if (/^\d+\.\d+$/.test(text)) {
                        const val = parseFloat(text);
                        if (val > 0 && val < 200) {
                            hours = val;
                        }
                    }
                    // Check if it's a partner number
                    else if (/^US\d+$/i.test(text) || /^\d{6,}$/.test(text)) {
                        number = text;
                    }
                    // Otherwise might be a name
                    else if (text.length > 2 && !/^\d+$/.test(text) &&
                        !text.toLowerCase().includes('total') &&
                        !text.toLowerCase().includes('partner')) {
                        if (!name) name = cleanPartnerName(text);
                    }
                }

                if (name && hours > 0) {
                    partners.push({ name, number, hours });
                }
            }
        }

        // Fallback: line-based parsing
        if (partners.length === 0 && content) {
            const lines = content.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.length < 3) continue;

                // Skip headers and metadata
                if (/partner\s*name|tippable.*hours|total|executed|time period/i.test(trimmed)) {
                    continue;
                }

                // Try to match: Name (possibly with number) followed by hours
                const match = trimmed.match(/^(.+?)\s+(\d+\.\d+)$/);
                if (match) {
                    const namePart = match[1].trim();
                    const hours = parseFloat(match[2]);

                    if (namePart && hours > 0 && hours < 200) {
                        // Check if namePart contains a partner number
                        let name = namePart;
                        let number = '';

                        const numMatch = namePart.match(/(US\d+|\d{6,})$/i);
                        if (numMatch) {
                            number = numMatch[1];
                            name = namePart.replace(number, '').trim();
                        }

                        // Remove 5-digit store numbers from beginning
                        name = name.replace(/^\d{5}\s+/, '');
                        name = cleanPartnerName(name);

                        if (name && name.length > 1) {
                            partners.push({ name, number, hours });
                        }
                    }
                }
            }
        }

        debugLog('Extracted partners:', partners);
        return partners;
    }

    // ============================================
    // MAIN CALCULATION FUNCTION
    // ============================================

    /**
     * Calculate Holiday Split Tips
     * This function handles the two-rate calculation for holiday periods.
     * It matches partners between normal and holiday reports and applies
     * different rates to each set of hours.
     * 
     * @param {Array} normalPartners - Partners from normal week report
     * @param {Array} holidayPartners - Partners from holiday period report  
     * @param {number} normalHourlyRate - Rate for normal hours ($/hr)
     * @param {number} holidayHourlyRate - Rate for holiday hours ($/hr)
     * @returns {Object} Calculation results with matched partners and totals
     */
    function calculateHolidaySplitTips(normalPartners, holidayPartners, normalHourlyRate, holidayHourlyRate) {
        debugLog('calculateHolidaySplitTips called with:', {
            normalPartners: normalPartners.length,
            holidayPartners: holidayPartners.length,
            normalHourlyRate,
            holidayHourlyRate
        });

        // Build a map of all unique partners
        const partnerMap = new Map();

        // Add normal partners
        for (const p of normalPartners) {
            const key = normalizeNameKey(p.name);
            if (!partnerMap.has(key)) {
                partnerMap.set(key, {
                    name: p.name,
                    number: p.number || '',
                    normalHours: 0,
                    holidayHours: 0
                });
            }
            partnerMap.get(key).normalHours += p.hours;
            if (p.number && !partnerMap.get(key).number) {
                partnerMap.get(key).number = p.number;
            }
        }

        // Add/merge holiday partners
        for (const p of holidayPartners) {
            const key = normalizeNameKey(p.name);
            if (!partnerMap.has(key)) {
                partnerMap.set(key, {
                    name: p.name,
                    number: p.number || '',
                    normalHours: 0,
                    holidayHours: 0
                });
            }
            partnerMap.get(key).holidayHours += p.hours;
            if (p.number && !partnerMap.get(key).number) {
                partnerMap.get(key).number = p.number;
            }
        }

        // Calculate tips for each partner
        const results = [];
        let totalNormalHours = 0;
        let totalHolidayHours = 0;
        let totalNormalTips = 0;
        let totalHolidayTips = 0;
        let totalCombinedPayout = 0;
        const totalBills = { twenties: 0, tens: 0, fives: 0, ones: 0 };

        const truncNormalRate = truncateToTwoDecimals(normalHourlyRate);
        const truncHolidayRate = truncateToTwoDecimals(holidayHourlyRate);

        for (const [key, partner] of partnerMap) {
            // Calculate normal tips
            const normalTipRaw = truncNormalRate * partner.normalHours;
            const normalTipDecimal = roundToTwoDecimals(normalTipRaw);

            // Calculate holiday tips
            const holidayTipRaw = truncHolidayRate * partner.holidayHours;
            const holidayTipDecimal = roundToTwoDecimals(holidayTipRaw);

            // Combine and round to whole dollar
            const combinedDecimal = normalTipDecimal + holidayTipDecimal;
            const wholeDollarPayout = combinedDecimal > 0 ? Math.round(combinedDecimal + 1e-8) : 0;

            // Bill breakdown
            const breakdown = breakdownBills(wholeDollarPayout);

            // Accumulate totals
            totalNormalHours += partner.normalHours;
            totalHolidayHours += partner.holidayHours;
            totalNormalTips += normalTipDecimal;
            totalHolidayTips += holidayTipDecimal;
            totalCombinedPayout += wholeDollarPayout;
            totalBills.twenties += breakdown.twenties;
            totalBills.tens += breakdown.tens;
            totalBills.fives += breakdown.fives;
            totalBills.ones += breakdown.ones;

            results.push({
                name: partner.name,
                number: partner.number,
                normalHours: partner.normalHours,
                holidayHours: partner.holidayHours,
                normalTip: normalTipDecimal,
                holidayTip: holidayTipDecimal,
                combinedDecimal,
                wholeDollarPayout,
                breakdown
            });
        }

        // Sort by name
        results.sort((a, b) => a.name.localeCompare(b.name));

        return {
            partners: results,
            summary: {
                totalNormalHours,
                totalHolidayHours,
                totalNormalTips,
                totalHolidayTips,
                totalCombinedTips: totalNormalTips + totalHolidayTips,
                totalCombinedPayout,
                normalHourlyRate: truncNormalRate,
                holidayHourlyRate: truncHolidayRate,
                totalBills
            }
        };
    }

    /**
     * Normalize partner name for matching
     */
    function normalizeNameKey(name) {
        return (name || '')
            .toLowerCase()
            .replace(/[^a-z]/g, '')
            .trim();
    }

    // ============================================
    // UI FUNCTIONS
    // ============================================

    function createDashboardHTML() {
        return `
            <div class="holiday-dashboard" id="holiday-dashboard">
                <div class="holiday-dashboard__container">
                    <!-- Header -->
                    <div class="holiday-dashboard__header">
                        <div class="holiday-dashboard__title">
                            <div class="holiday-dashboard__title-text">
                                <h2>Holiday Tips Calculator</h2>
                            </div>
                        </div>
                        <button class="holiday-dashboard__close" id="holiday-close-btn" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>

                    <!-- Upload Grid -->
                    <div class="holiday-dashboard__grid">
                        <!-- Regular Tips Card (Locked from Main App) -->
                        <div class="holiday-card">
                            <div class="holiday-card__header">
                                <div class="holiday-card__header-left">
                                    <div class="holiday-card__icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                            <polyline points="22 4 12 14.01 9 11.01"/>
                                        </svg>
                                    </div>
                                    <h3 class="holiday-card__title">Regular Tips</h3>
                                </div>
                                <span class="holiday-card__tag holiday-card__tag--locked">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:10px;height:10px;margin-right:4px;">
                                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                    </svg>
                                    Locked
                                </span>
                            </div>
                            <!-- Locked Data Display (no upload zone) -->
                            <div class="holiday-locked-data" id="regular-locked-data">
                                <div class="holiday-locked-data__icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                    </svg>
                                </div>
                                <p class="holiday-locked-data__text">Using your weekly report</p>
                                <p class="holiday-locked-data__hint" id="regular-data-status">No partners loaded</p>
                            </div>
                            <div class="holiday-partners-list" id="regular-partners-preview"></div>
                            <div class="holiday-tips-section">
                                <div class="holiday-tips-label">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z"/>
                                    </svg>
                                    REGULAR CASH TIPS
                                </div>
                                <div class="holiday-tips-input-wrapper">
                                    <span class="holiday-tips-currency">$</span>
                                    <input type="number" class="holiday-tips-input" id="regular-tips-input" 
                                           placeholder="0.00" step="0.01" min="0">
                                </div>
                            </div>
                        </div>

                        <!-- Holiday Tips Card (Upload Required) -->
                        <div class="holiday-card">
                            <div class="holiday-card__header">
                                <div class="holiday-card__header-left">
                                    <div class="holiday-card__icon holiday-card__icon--holiday">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                                        </svg>
                                    </div>
                                    <h3 class="holiday-card__title">Holiday Tips</h3>
                                </div>
                                <span class="holiday-card__tag">Holiday Hours</span>
                            </div>
                            <div class="holiday-upload-zone holiday-upload-zone--holiday" id="holiday-upload-zone">
                                <input type="file" accept="image/*" class="holiday-upload-zone__input" id="holiday-report-input">
                                <div class="holiday-upload-zone__icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                        <polyline points="17 8 12 3 7 8"/>
                                        <line x1="12" y1="3" x2="12" y2="15"/>
                                    </svg>
                                </div>
                                <p class="holiday-upload-zone__text">Upload Holiday Hours Report</p>
                                <p class="holiday-upload-zone__hint">PNG, JPG, JPEG supported</p>
                                <p class="holiday-upload-zone__status" id="holiday-upload-status"></p>
                            </div>
                            <div class="holiday-partners-list" id="holiday-partners-preview"></div>
                            <div class="holiday-tips-section">
                                <div class="holiday-tips-label holiday-tips-label--holiday">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z"/>
                                    </svg>
                                    HOLIDAY CASH TIPS
                                </div>
                                <div class="holiday-tips-input-wrapper holiday-tips-input-wrapper--holiday">
                                    <span class="holiday-tips-currency">$</span>
                                    <input type="number" class="holiday-tips-input" id="holiday-tips-input" 
                                           placeholder="0.00" step="0.01" min="0">
                                </div>
                            </div>
                        </div>

                        <!-- Calculate Button -->
                        <div class="holiday-calculate-section">
                            <div class="holiday-calculate-hint">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="12" y1="16" x2="12" y2="12"/>
                                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                                </svg>
                                <span id="holiday-calculate-hint-text">Upload holiday report to begin</span>
                            </div>
                            <button class="holiday-calculate-btn" id="holiday-calculate-btn" disabled>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                    <polyline points="22 4 12 14.01 9 11.01"/>
                                </svg>
                                <span>Calculate Holiday Split</span>
                            </button>
                        </div>

                        <!-- Results Section -->
                        <div class="holiday-results" id="holiday-results">
                            <div class="holiday-card">
                                <div class="holiday-card__header">
                                    <div class="holiday-card__header-left">
                                        <div class="holiday-card__icon holiday-card__icon--holiday">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                                <polyline points="22 4 12 14.01 9 11.01"/>
                                            </svg>
                                        </div>
                                        <h3 class="holiday-card__title">Distribution Results</h3>
                                    </div>
                                    <span class="holiday-card__tag" id="results-date"></span>
                                </div>

                                <!-- Summary Stats -->
                                <div class="holiday-results-summary" id="holiday-summary"></div>

                                <!-- Bills Needed -->
                                <div class="holiday-bills-grid" id="holiday-bills"></div>

                                <!-- Results Table -->
                                <div style="overflow-x: auto; margin-top: 1.25rem;">
                                    <table class="holiday-results-table">
                                        <thead>
                                            <tr>
                                                <th>Partner</th>
                                                <th>Regular Hrs</th>
                                                <th>Holiday Hrs</th>
                                                <th>Regular Tips</th>
                                                <th>Holiday Tips</th>
                                                <th>Total Payout</th>
                                            </tr>
                                        </thead>
                                        <tbody id="holiday-results-body"></tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function renderPartnersPreview(partners, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (partners.length === 0) {
            container.innerHTML = '';
            return;
        }

        let html = '';
        for (const p of partners.slice(0, 10)) {
            html += `
                <div class="holiday-partner-row">
                    <span class="holiday-partner-name">${escapeHtml(p.name)}</span>
                    <span class="holiday-partner-hours">${p.hours.toFixed(2)} hrs</span>
                </div>
            `;
        }

        if (partners.length > 10) {
            html += `
                <div class="holiday-partner-row">
                    <span class="holiday-partner-name" style="color: rgba(255,255,255,0.5);">
                        +${partners.length - 10} more partners...
                    </span>
                </div>
            `;
        }

        container.innerHTML = html;
    }

    function renderResults(results) {
        const summaryEl = document.getElementById('holiday-summary');
        const billsEl = document.getElementById('holiday-bills');
        const bodyEl = document.getElementById('holiday-results-body');
        const resultsSection = document.getElementById('holiday-results');
        const dateEl = document.getElementById('results-date');

        if (!summaryEl || !bodyEl) return;

        const { partners, summary } = results;

        // Date
        if (dateEl) {
            const now = new Date();
            dateEl.textContent = now.toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
        }

        // Summary stats
        summaryEl.innerHTML = `
            <div class="holiday-summary-stat holiday-summary-stat--normal">
                <div class="holiday-summary-stat__label">Normal Hours</div>
                <div class="holiday-summary-stat__value">${summary.totalNormalHours.toFixed(2)}</div>
            </div>
            <div class="holiday-summary-stat holiday-summary-stat--holiday">
                <div class="holiday-summary-stat__label">Holiday Hours</div>
                <div class="holiday-summary-stat__value">${summary.totalHolidayHours.toFixed(2)}</div>
            </div>
            <div class="holiday-summary-stat holiday-summary-stat--normal">
                <div class="holiday-summary-stat__label">Normal Tips</div>
                <div class="holiday-summary-stat__value">$${summary.totalNormalTips.toFixed(2)}</div>
            </div>
            <div class="holiday-summary-stat holiday-summary-stat--holiday">
                <div class="holiday-summary-stat__label">Holiday Tips</div>
                <div class="holiday-summary-stat__value">$${summary.totalHolidayTips.toFixed(2)}</div>
            </div>
            <div class="holiday-summary-stat">
                <div class="holiday-summary-stat__label">Total Payout</div>
                <div class="holiday-summary-stat__value">$${summary.totalCombinedPayout}</div>
            </div>
        `;

        // Bills breakdown
        const bills = summary.totalBills;
        billsEl.innerHTML = `
            <div class="holiday-bill-item">
                <div class="holiday-bill-item__count">${bills.twenties}</div>
                <div class="holiday-bill-item__denom">× $20</div>
            </div>
            <div class="holiday-bill-item">
                <div class="holiday-bill-item__count">${bills.tens}</div>
                <div class="holiday-bill-item__denom">× $10</div>
            </div>
            <div class="holiday-bill-item">
                <div class="holiday-bill-item__count">${bills.fives}</div>
                <div class="holiday-bill-item__denom">× $5</div>
            </div>
            <div class="holiday-bill-item">
                <div class="holiday-bill-item__count">${bills.ones}</div>
                <div class="holiday-bill-item__denom">× $1</div>
            </div>
        `;

        // Partner rows
        let rowsHtml = '';
        for (const p of partners) {
            rowsHtml += `
                <tr>
                    <td class="td-name">${escapeHtml(p.name)}</td>
                    <td class="td-hours">${p.normalHours.toFixed(2)}</td>
                    <td class="td-hours">${p.holidayHours.toFixed(2)}</td>
                    <td class="td-normal">$${p.normalTip.toFixed(2)}</td>
                    <td class="td-holiday">$${p.holidayTip.toFixed(2)}</td>
                    <td class="td-total">$${p.wholeDollarPayout}</td>
                </tr>
            `;
        }
        bodyEl.innerHTML = rowsHtml;

        // Show results section
        if (resultsSection) {
            resultsSection.classList.add('is-visible');
        }
    }

    function updateCalculateButtonState() {
        const btn = document.getElementById('holiday-calculate-btn');
        const hintEl = document.getElementById('holiday-calculate-hint-text');
        if (!btn) return;

        // Get regular partners from main app (always fresh)
        const regularPartners = getRegularPartnersFromMainApp();
        const regularTipsVal = parseFloat(document.getElementById('regular-tips-input')?.value) || 0;
        const holidayTipsVal = parseFloat(document.getElementById('holiday-tips-input')?.value) || 0;

        const hasRegularData = regularPartners.length > 0;
        const hasHolidayData = holidayReportPartners.length > 0;
        const hasAnyTips = regularTipsVal > 0 || holidayTipsVal > 0;

        // Key rule: Need regular data AND holiday data (or just holiday with tips)
        // Holiday Tips is an add-on, so we need holiday upload
        const canCalculate = hasHolidayData && hasAnyTips;

        btn.disabled = !canCalculate;

        // Update hint text based on state
        if (hintEl) {
            if (!hasRegularData) {
                hintEl.textContent = 'Upload a report on the main page first';
            } else if (!hasHolidayData) {
                hintEl.textContent = 'Upload holiday hours report';
            } else if (!hasAnyTips) {
                hintEl.textContent = 'Enter cash tips to calculate';
            } else {
                hintEl.textContent = 'Ready to calculate';
            }
        }

        // Update regular data status display
        updateRegularDataDisplay(regularPartners);
    }

    /**
     * Update the locked regular data display with current partner info
     * This reads from the main app's partner data and displays it as read-only
     */
    function updateRegularDataDisplay(regularPartners) {
        const statusEl = document.getElementById('regular-data-status');
        const previewEl = document.getElementById('regular-partners-preview');
        const lockedDataEl = document.getElementById('regular-locked-data');
        const textEl = document.querySelector('.holiday-locked-data__text');

        if (!statusEl) return;

        if (regularPartners.length > 0) {
            const totalHours = regularPartners.reduce((sum, p) => sum + (p.hours || 0), 0);
            statusEl.textContent = `${regularPartners.length} partners • ${totalHours.toFixed(2)} hours`;
            if (textEl) textEl.textContent = 'Using your weekly report';
            if (lockedDataEl) {
                lockedDataEl.classList.add('has-data');
            }
            // Show preview of partners
            renderPartnersPreview(regularPartners, 'regular-partners-preview');
        } else {
            statusEl.textContent = 'Close this and upload a report on the main page first';
            if (textEl) textEl.textContent = 'No weekly data found';
            if (lockedDataEl) {
                lockedDataEl.classList.remove('has-data');
            }
            if (previewEl) {
                previewEl.innerHTML = '';
            }
        }
    }

    // ============================================
    // EVENT HANDLERS
    // ============================================

    async function handleHolidayReportUpload(event) {
        const file = event.target.files?.[0];
        if (!file) return;

        const statusEl = document.getElementById('holiday-upload-status');
        const zone = document.getElementById('holiday-upload-zone');

        try {
            holidayReportPartners = await processReportImage(file, (msg) => {
                if (statusEl) statusEl.textContent = msg;
            });

            if (statusEl) {
                statusEl.textContent = `${holidayReportPartners.length} partners found`;
            }
            if (zone) zone.classList.add('has-file');

            renderPartnersPreview(holidayReportPartners, 'holiday-partners-preview');
            updateCalculateButtonState();

        } catch (err) {
            debugLog('Holiday report upload error:', err);
            if (statusEl) {
                statusEl.textContent = `Error: ${err.message}`;
            }
        }
    }

    function handleCalculate() {
        // Get regular partners from main app (locked data)
        const regularPartners = getRegularPartnersFromMainApp();
        const regularTipsVal = parseFloat(document.getElementById('regular-tips-input')?.value) || 0;
        const holidayTipsVal = parseFloat(document.getElementById('holiday-tips-input')?.value) || 0;

        // Validate: need holiday data to proceed
        if (holidayReportPartners.length === 0) {
            alert('Please upload a holiday hours report.');
            return;
        }

        if (regularTipsVal <= 0 && holidayTipsVal <= 0) {
            alert('Please enter at least one cash tips amount.');
            return;
        }

        // Calculate total hours for each period
        const regularTotalHours = regularPartners.reduce((sum, p) => sum + (p.hours || 0), 0);
        const holidayTotalHours = holidayReportPartners.reduce((sum, p) => sum + (p.hours || 0), 0);

        // Derive hourly rates from tips / hours
        const regularHourlyRate = regularTotalHours > 0 ? regularTipsVal / regularTotalHours : 0;
        const holidayHourlyRate = holidayTotalHours > 0 ? holidayTipsVal / holidayTotalHours : 0;

        debugLog('Calculating with:', {
            regularPartners: regularPartners.length,
            holidayPartners: holidayReportPartners.length,
            regularTips: regularTipsVal,
            holidayTips: holidayTipsVal,
            regularHourlyRate,
            holidayHourlyRate
        });

        const results = calculateHolidaySplitTips(
            regularPartners,
            holidayReportPartners,
            regularHourlyRate,
            holidayHourlyRate
        );

        calculationResults = results;
        renderResults(results);
    }

    // ============================================
    // PUBLIC API
    // ============================================

    function open() {
        if (isOpen) return;
        isOpen = true;

        const dashboard = document.getElementById('holiday-dashboard');
        const mainContent = document.querySelector('.app-container');

        if (dashboard) {
            dashboard.classList.remove('is-exiting');
            dashboard.classList.add('is-entering');
            setTimeout(() => {
                dashboard.classList.remove('is-entering');
                dashboard.classList.add('is-visible');
            }, 300);
        }

        if (mainContent) {
            mainContent.style.display = 'none';
        }

        document.body.style.overflow = 'hidden';

        // Populate regular data from main app when opening
        // This ensures we always have the latest data
        updateCalculateButtonState();
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;

        const dashboard = document.getElementById('holiday-dashboard');
        const mainContent = document.querySelector('.app-container');

        if (dashboard) {
            dashboard.classList.remove('is-visible', 'is-entering');
            dashboard.classList.add('is-exiting');
            setTimeout(() => {
                dashboard.classList.remove('is-exiting');
            }, 300);
        }

        if (mainContent) {
            mainContent.style.display = '';
        }

        document.body.style.overflow = '';
    }

    /**
     * Reset only the holiday-specific data
     * Regular data is read from main app and should NOT be reset here
     * This ensures the "add-on" behavior where holiday is separate
     * 
     * KEY: Regular tips input is NOT cleared - it's part of the locked regular week data
     * Only holiday-specific inputs and data are reset
     */
    function reset() {
        // Only reset holiday data - regular data comes from main app
        holidayReportPartners = [];
        calculationResults = [];

        // Reset ONLY holiday UI elements - NOT regular tips input
        const holidayStatus = document.getElementById('holiday-upload-status');
        const holidayPreview = document.getElementById('holiday-partners-preview');
        const holidayZone = document.getElementById('holiday-upload-zone');
        const holidayInput = document.getElementById('holiday-report-input');
        // NOTE: regularTipsIn is intentionally NOT reset - it's part of the locked regular week data
        const holidayTipsIn = document.getElementById('holiday-tips-input');
        const results = document.getElementById('holiday-results');

        if (holidayStatus) holidayStatus.textContent = '';
        if (holidayPreview) holidayPreview.innerHTML = '';
        if (holidayZone) holidayZone.classList.remove('has-file');
        if (holidayInput) holidayInput.value = '';
        // Regular tips input is NOT cleared - stays locked with the regular week data
        if (holidayTipsIn) holidayTipsIn.value = '';
        if (results) results.classList.remove('is-visible');

        updateCalculateButtonState();
    }

    function init() {
        // Inject dashboard HTML
        const existingDashboard = document.getElementById('holiday-dashboard');
        if (!existingDashboard) {
            document.body.insertAdjacentHTML('beforeend', createDashboardHTML());
        }

        // Set up event listeners
        const closeBtn = document.getElementById('holiday-close-btn');
        const holidayReportInput = document.getElementById('holiday-report-input');
        const calcBtn = document.getElementById('holiday-calculate-btn');
        const regularTipsIn = document.getElementById('regular-tips-input');
        const holidayTipsIn = document.getElementById('holiday-tips-input');

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                close();
                reset();
            });
        }

        // Only holiday upload - regular is read from main app
        if (holidayReportInput) {
            holidayReportInput.addEventListener('change', handleHolidayReportUpload);
        }

        if (calcBtn) {
            calcBtn.addEventListener('click', handleCalculate);
        }

        if (regularTipsIn) {
            regularTipsIn.addEventListener('input', updateCalculateButtonState);
        }

        if (holidayTipsIn) {
            holidayTipsIn.addEventListener('input', updateCalculateButtonState);
        }

        // Only need drag/drop for holiday upload zone
        setupDragDrop('holiday-upload-zone', 'holiday-report-input');

        debugLog('Holiday Dashboard initialized (add-on mode)');
    }

    function setupDragDrop(zoneId, inputId) {
        const zone = document.getElementById(zoneId);
        const input = document.getElementById(inputId);
        if (!zone || !input) return;

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('is-dragover');
        });

        zone.addEventListener('dragleave', () => {
            zone.classList.remove('is-dragover');
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('is-dragover');

            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                // Create a new file list and trigger the input
                const dt = new DataTransfer();
                dt.items.add(files[0]);
                input.files = dt.files;
                input.dispatchEvent(new Event('change'));
            }
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Return public API
    return {
        open,
        close,
        reset,
        isOpen: () => isOpen,
        // Expose the calculation function for testing
        calculateHolidaySplitTips
    };

})();

// Make available globally
window.HolidayDashboard = HolidayDashboard;
