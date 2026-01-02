/**
 * Holiday Automation Dashboard - Beta Feature
 * ============================================
 * 
 * This is a completely ISOLATED module that provides holiday split tip calculation.
 * It does NOT modify, call, or depend on any existing app.js functions.
 * 
 * Features:
 * - Dual OCR upload for Regular and Holiday hours
 * - Auto-matching of partners across both rate types
 * - Two-rate calculation (regular rate vs holiday rate)
 * - Combined bill breakdown per partner
 * 
 * @author William Walsh
 * @version 1.0.0-beta
 */

// ============================================
// MODULE STATE - Completely isolated from app.js
// ============================================

const HolidayAutomation = (function () {
    'use strict';

    // Private state
    let isActive = false;
    let regularPartners = [];
    let holidayPartners = [];
    let regularCash = 0;
    let holidayCash = 0;
    let lastResults = null;

    // Debug mode for this module
    const HOLIDAY_DEBUG = false;

    function holidayLog(...args) {
        if (HOLIDAY_DEBUG) {
            console.log('[HolidayAutomation]', ...args);
        }
    }

    // ============================================
    // AZURE OCR INTEGRATION (Separate instance)
    // ============================================

    function getAzureConfig() {
        const config = window.AZURE_CONFIG || {};
        return {
            endpoint: config.endpoint || '',
            apiKey: config.apiKey || ''
        };
    }

    async function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = function () {
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

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Call Azure Document Intelligence API for OCR
     * This is a simplified version specifically for holiday automation
     */
    async function performOCR(imageBase64, statusCallback) {
        const config = getAzureConfig();

        if (!config.endpoint || config.endpoint.includes('__') ||
            !config.apiKey || config.apiKey.includes('__')) {
            throw new Error('Azure OCR not configured. Please configure API credentials.');
        }

        statusCallback('Uploading to Azure...', 'loading');

        const endpoint = config.endpoint.replace(/\/$/, '');
        const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-02-29-preview`;

        try {
            const response = await fetch(analyzeUrl, {
                method: 'POST',
                headers: {
                    'Ocp-Apim-Subscription-Key': config.apiKey,
                    'Content-Type': 'application/octet-stream'
                },
                body: base64ToArrayBuffer(imageBase64)
            });

            if (!response.ok) {
                throw new Error(`Azure API error: ${response.status}`);
            }

            const operationLocation = response.headers.get('Operation-Location');
            if (!operationLocation) {
                throw new Error('No operation location returned');
            }

            statusCallback('Processing document...', 'loading');

            // Poll for results
            let result = null;
            let attempts = 0;
            const maxAttempts = 30;

            while (attempts < maxAttempts) {
                await sleep(1000);
                attempts++;

                const resultResponse = await fetch(operationLocation, {
                    headers: { 'Ocp-Apim-Subscription-Key': config.apiKey }
                });

                result = await resultResponse.json();

                if (result.status === 'succeeded') {
                    break;
                } else if (result.status === 'failed') {
                    throw new Error('Document analysis failed');
                }

                statusCallback(`Processing... (${attempts}s)`, 'loading');
            }

            if (!result || result.status !== 'succeeded') {
                throw new Error('Analysis timeout');
            }

            return parseOCRResult(result);

        } catch (error) {
            holidayLog('OCR Error:', error);
            throw error;
        }
    }

    /**
     * Parse Azure Document Intelligence result into partner data
     */
    function parseOCRResult(result) {
        const partners = [];

        if (result.analyzeResult && result.analyzeResult.tables) {
            for (const table of result.analyzeResult.tables) {
                const extracted = extractFromTable(table);
                partners.push(...extracted);
            }
        }

        // Fallback to text parsing if no tables found
        if (partners.length === 0 && result.analyzeResult && result.analyzeResult.content) {
            const textParsed = parseTextContent(result.analyzeResult.content);
            partners.push(...textParsed);
        }

        // Filter out invalid entries
        return partners.filter(p =>
            p && p.name && p.name.length > 1 &&
            !p.name.toLowerCase().includes('total') &&
            p.hours > 0 && p.hours < 200
        );
    }

    /**
     * Extract partner data from a table structure
     */
    function extractFromTable(table) {
        const partners = [];
        const rowCount = table.rowCount || 0;
        const cells = table.cells || [];

        // Group cells by row
        const cellsByRow = {};
        for (const cell of cells) {
            const row = cell.rowIndex;
            if (!cellsByRow[row]) cellsByRow[row] = [];
            cellsByRow[row].push(cell);
        }

        // Detect header row to find column indices
        let nameCol = -1, hoursCol = -1, numberCol = -1;

        if (cellsByRow[0]) {
            for (const cell of cellsByRow[0]) {
                const text = (cell.content || '').toLowerCase();
                if (text.includes('name') && nameCol < 0) nameCol = cell.columnIndex;
                if ((text.includes('hours') || text.includes('tippable')) && hoursCol < 0) hoursCol = cell.columnIndex;
                if ((text.includes('partner') && text.includes('#')) || text.includes('number')) numberCol = cell.columnIndex;
            }
        }

        // Default columns if not detected
        if (nameCol < 0) nameCol = 0;
        if (hoursCol < 0) hoursCol = 2;

        // Parse data rows (skip header)
        for (let row = 1; row < rowCount; row++) {
            const rowCells = cellsByRow[row] || [];

            let name = '';
            let hours = 0;
            let number = '';

            for (const cell of rowCells) {
                const content = (cell.content || '').trim();

                if (cell.columnIndex === nameCol) {
                    name = cleanPartnerName(content);
                } else if (cell.columnIndex === hoursCol) {
                    const parsed = parseFloat(content.replace(/[^0-9.]/g, ''));
                    if (isFinite(parsed)) hours = parsed;
                } else if (cell.columnIndex === numberCol) {
                    if (/US\d+/i.test(content) || /^\d{6,}$/.test(content)) {
                        number = content;
                    }
                }
            }

            if (name && hours > 0) {
                partners.push({ name, number, hours });
            }
        }

        return partners;
    }

    /**
     * Fallback text parsing when table extraction fails
     */
    function parseTextContent(text) {
        const partners = [];
        const lines = text.split(/\r?\n/);

        const skipPatterns = [
            /partner\s*name/i,
            /home\s*store/i,
            /tippable.*hours/i,
            /total\s*tippable/i,
            /time\s*period/i,
            /executed/i,
            /store\s*number/i,
        ];

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.length < 3) continue;

            // Skip headers and metadata
            if (skipPatterns.some(p => p.test(line))) continue;

            // Try to match: Name [PartnerNumber] Hours
            let match = line.match(/^(.+?)\s+(US\d+|\d{6,})?\s*(\d+\.?\d*)$/i);
            if (match) {
                const name = cleanPartnerName(match[1].trim());
                const number = match[2] || '';
                const hours = parseFloat(match[3]);

                if (name && isFinite(hours) && hours > 0 && hours < 200) {
                    partners.push({ name, number, hours });
                }
            }
        }

        return partners;
    }

    /**
     * Clean partner name - remove dates, timestamps, prefixes
     */
    function cleanPartnerName(name) {
        if (!name) return '';

        return name
            .replace(/^\d{5}\s+/, '')  // Remove 5-digit store prefix
            .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')  // Remove dates
            .replace(/\d{2}:\d{2}(:\d{2})?/g, '')  // Remove times
            .replace(/^[~=\-\s]+/, '')  // Remove prefix symbols
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .trim();
    }

    // ============================================
    // HOLIDAY SPLIT CALCULATION
    // (Completely separate from app.js runCalculations)
    // ============================================

    /**
     * Calculate holiday split tips
     * This function is COMPLETELY INDEPENDENT from the main app.js calculation.
     * It handles two periods with potentially different rates.
     */
    function calculateHolidaySplitTips(regularPartners, regularCash, holidayPartners, holidayCash) {
        holidayLog('Calculating holiday split tips');
        holidayLog('Regular:', regularPartners.length, 'partners, $', regularCash);
        holidayLog('Holiday:', holidayPartners.length, 'partners, $', holidayCash);

        // Calculate totals for each rate type
        const regularTotalHours = regularPartners.reduce((sum, p) => sum + (p.hours || 0), 0);
        const holidayTotalHours = holidayPartners.reduce((sum, p) => sum + (p.hours || 0), 0);

        if (regularTotalHours <= 0 && holidayTotalHours <= 0) {
            throw new Error('No valid hours found for regular or holiday');
        }

        // Calculate hourly rates (truncated to 2 decimals)
        const regularRate = regularTotalHours > 0 ? truncateToTwoDecimals(regularCash / regularTotalHours) : 0;
        const holidayRate = holidayTotalHours > 0 ? truncateToTwoDecimals(holidayCash / holidayTotalHours) : 0;

        holidayLog('Regular rate: $', regularRate, '/hr');
        holidayLog('Holiday rate: $', holidayRate, '/hr');

        // Match partners across both rate types
        const matched = matchPartners(regularPartners, holidayPartners);

        // Calculate distribution for each partner
        const results = [];
        let totalBills = { twenties: 0, tens: 0, fives: 0, ones: 0 };

        for (const match of matched) {
            const regularHours = match.regular ? match.regular.hours : 0;
            const holidayHours = match.holiday ? match.holiday.hours : 0;

            const regularTip = roundToTwoDecimals(regularRate * regularHours);
            const holidayTip = roundToTwoDecimals(holidayRate * holidayHours);
            const totalTip = regularTip + holidayTip;

            // Round to whole dollars for cash payout
            const wholeDollarPayout = totalTip > 0 ? Math.round(totalTip) : 0;
            const breakdown = breakdownBills(wholeDollarPayout);

            totalBills.twenties += breakdown.twenties;
            totalBills.tens += breakdown.tens;
            totalBills.fives += breakdown.fives;
            totalBills.ones += breakdown.ones;

            results.push({
                name: match.name,
                number: match.regular?.number || match.holiday?.number || '',
                regularHours,
                holidayHours,
                regularTip,
                holidayTip,
                totalTip,
                wholeDollarPayout,
                breakdown
            });
        }

        // Sort by total payout descending
        results.sort((a, b) => b.wholeDollarPayout - a.wholeDollarPayout);

        return {
            regular: {
                partners: regularPartners.length,
                totalHours: regularTotalHours,
                totalCash: regularCash,
                rate: regularRate
            },
            holiday: {
                partners: holidayPartners.length,
                totalHours: holidayTotalHours,
                totalCash: holidayCash,
                rate: holidayRate
            },
            results,
            totalBills,
            calculatedAt: new Date()
        };
    }

    /**
     * Match partners across two periods by name
     * Uses fuzzy matching to handle OCR variations
     */
    function matchPartners(regularPartnersList, holidayPartnersList) {
        const matched = [];
        const usedHoliday = new Set();

        function normalizeNameForMatch(name) {
            return (name || '')
                .toLowerCase()
                .replace(/[^a-z]/g, '')
                .trim();
        }

        // First, try to match regular partners with holiday
        for (const p1 of regularPartnersList) {
            const norm1 = normalizeNameForMatch(p1.name);
            let bestMatch = null;
            let bestScore = 0;

            for (let i = 0; i < holidayPartnersList.length; i++) {
                if (usedHoliday.has(i)) continue;

                const p2 = holidayPartnersList[i];
                const norm2 = normalizeNameForMatch(p2.name);

                // Exact match
                if (norm1 === norm2) {
                    bestMatch = { index: i, partner: p2 };
                    bestScore = 1;
                    break;
                }

                // Partial match (one contains the other)
                if (norm1.includes(norm2) || norm2.includes(norm1)) {
                    const score = Math.min(norm1.length, norm2.length) / Math.max(norm1.length, norm2.length);
                    if (score > bestScore && score > 0.7) {
                        bestMatch = { index: i, partner: p2 };
                        bestScore = score;
                    }
                }
            }

            if (bestMatch) {
                usedHoliday.add(bestMatch.index);
                matched.push({
                    name: p1.name,
                    regular: p1,
                    holiday: bestMatch.partner
                });
            } else {
                matched.push({
                    name: p1.name,
                    regular: p1,
                    holiday: null
                });
            }
        }

        // Add unmatched holiday partners
        for (let i = 0; i < holidayPartnersList.length; i++) {
            if (!usedHoliday.has(i)) {
                const p2 = holidayPartnersList[i];
                matched.push({
                    name: p2.name,
                    regular: null,
                    holiday: p2
                });
            }
        }

        return matched;
    }

    // ============================================
    // MATH HELPERS (Isolated copies - don't depend on app.js)
    // ============================================

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
    // UI RENDERING
    // ============================================

    function createDashboardHTML() {
        return `
            <div class="holiday-dashboard">
                <!-- Header -->
                <header class="holiday-header">
                    <div class="holiday-header-left">
                        <div class="holiday-logo">
                            <div class="holiday-logo-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                                </svg>
                            </div>
                            <div>
                                <div class="holiday-title">Holiday Split Calculator</div>
                                <div class="holiday-subtitle">Beta Feature</div>
                            </div>
                        </div>
                    </div>
                    <button type="button" class="holiday-close-btn" id="holiday-close-btn" aria-label="Close Holiday Mode">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </header>

                <!-- Split Upload Container -->
                <div class="holiday-split-container">
                    <!-- Regular Tips Card -->
                    <div class="holiday-period-card week-1">
                        <div class="period-header">
                            <div class="period-title">
                                <div class="period-number">☕</div>
                                <span class="period-label">Regular Tips</span>
                            </div>
                            <span class="period-date-range" id="regular-date-range">Non-Holiday Hours</span>
                        </div>

                        <label class="holiday-upload-zone" id="regular-upload-zone">
                            <input type="file" accept="image/*" id="regular-file-input"/>
                            <div class="holiday-upload-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                    <polyline points="17 8 12 3 7 8"/>
                                    <line x1="12" y1="3" x2="12" y2="15"/>
                                </svg>
                            </div>
                            <div class="holiday-upload-text">Upload Regular Hours Report</div>
                            <div class="holiday-upload-hint">PNG, JPG, JPEG supported</div>
                        </label>
                        <div class="holiday-upload-status" id="regular-status"></div>

                        <div class="holiday-partners-preview" id="regular-partners-list" style="display: none;"></div>

                        <div class="holiday-cash-input-group">
                            <label class="holiday-cash-label">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="12" y1="1" x2="12" y2="23"/>
                                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                                </svg>
                                Regular Cash Tips
                            </label>
                            <div class="holiday-cash-input-wrapper">
                                <span class="currency-symbol">$</span>
                                <input type="number" class="holiday-cash-input" id="regular-cash" min="0" step="0.01" placeholder="0.00" inputmode="decimal"/>
                            </div>
                        </div>
                    </div>

                    <!-- Holiday Tips Card -->
                    <div class="holiday-period-card week-2">
                        <div class="period-header">
                            <div class="period-title">
                                <div class="period-number">🎄</div>
                                <span class="period-label">Holiday Tips</span>
                            </div>
                            <span class="period-date-range" id="holiday-date-range">Holiday Hours</span>
                        </div>

                        <label class="holiday-upload-zone" id="holiday-upload-zone">
                            <input type="file" accept="image/*" id="holiday-file-input"/>
                            <div class="holiday-upload-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                    <polyline points="17 8 12 3 7 8"/>
                                    <line x1="12" y1="3" x2="12" y2="15"/>
                                </svg>
                            </div>
                            <div class="holiday-upload-text">Upload Holiday Hours Report</div>
                            <div class="holiday-upload-hint">PNG, JPG, JPEG supported</div>
                        </label>
                        <div class="holiday-upload-status" id="holiday-status"></div>

                        <div class="holiday-partners-preview" id="holiday-partners-list" style="display: none;"></div>

                        <div class="holiday-cash-input-group">
                            <label class="holiday-cash-label">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="12" y1="1" x2="12" y2="23"/>
                                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                                </svg>
                                Holiday Cash Tips
                            </label>
                            <div class="holiday-cash-input-wrapper">
                                <span class="currency-symbol">$</span>
                                <input type="number" class="holiday-cash-input" id="holiday-cash" min="0" step="0.01" placeholder="0.00" inputmode="decimal"/>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Action Section -->
                <div class="holiday-action-section">
                    <div class="holiday-action-header">
                        <div class="holiday-match-status none" id="holiday-match-status">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="8" x2="12" y2="12"/>
                                <line x1="12" y1="16" x2="12.01" y2="16"/>
                            </svg>
                            <span>Upload reports to begin</span>
                        </div>
                    </div>
                    <button type="button" class="holiday-calculate-btn" id="holiday-calculate-btn" disabled>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                        Calculate Holiday Split
                    </button>
                </div>

                <!-- Results Section -->
                <div class="holiday-results-section" id="holiday-results-section">
                    <div class="holiday-results-header">
                        <h2 class="holiday-results-title">Holiday Split Results</h2>
                        <span class="holiday-results-date" id="holiday-results-date"></span>
                    </div>

                    <!-- Summary Cards -->
                    <div class="holiday-summary-grid">
                        <div class="holiday-summary-card">
                            <div class="holiday-summary-label">Regular Rate</div>
                            <div class="holiday-summary-value rate" id="summary-regular-rate">$0.00/hr</div>
                        </div>
                        <div class="holiday-summary-card">
                            <div class="holiday-summary-label">Holiday Rate</div>
                            <div class="holiday-summary-value rate" id="summary-holiday-rate">$0.00/hr</div>
                        </div>
                        <div class="holiday-summary-card">
                            <div class="holiday-summary-label">Total Distributed</div>
                            <div class="holiday-summary-value" id="summary-total">$0</div>
                        </div>
                    </div>

                    <!-- Partner Results -->
                    <div class="holiday-partner-results" id="holiday-partner-results"></div>
                </div>
            </div>
        `;
    }

    function renderPartnersList(containerId, partners) {
        const container = document.getElementById(containerId);
        if (!container || !partners.length) {
            if (container) container.style.display = 'none';
            return;
        }

        container.style.display = 'block';

        const totalHours = partners.reduce((sum, p) => sum + (p.hours || 0), 0);

        let html = partners.map(p => `
            <div class="holiday-partner-row">
                <span class="holiday-partner-name">${escapeHtml(p.name)}</span>
                <span class="holiday-partner-hours">${p.hours.toFixed(2)} hrs</span>
            </div>
        `).join('');

        html += `
            <div class="holiday-partners-count">
                <span>${partners.length} partner${partners.length !== 1 ? 's' : ''}</span>
                <strong>${totalHours.toFixed(2)} total hours</strong>
            </div>
        `;

        container.innerHTML = html;
    }

    function renderResults(data) {
        const section = document.getElementById('holiday-results-section');
        const resultsContainer = document.getElementById('holiday-partner-results');

        if (!section || !resultsContainer) return;

        // Update summary
        document.getElementById('summary-regular-rate').textContent = `$${data.regular.rate.toFixed(2)}/hr`;
        document.getElementById('summary-holiday-rate').textContent = `$${data.holiday.rate.toFixed(2)}/hr`;

        const totalDistributed = data.results.reduce((sum, r) => sum + r.wholeDollarPayout, 0);
        document.getElementById('summary-total').textContent = `$${totalDistributed}`;

        // Update date
        const dateEl = document.getElementById('holiday-results-date');
        if (dateEl) {
            const options = { month: 'short', day: 'numeric', year: 'numeric' };
            dateEl.textContent = data.calculatedAt.toLocaleDateString('en-US', options);
        }

        // Render partner cards
        let html = '';
        for (const r of data.results) {
            const billChips = [];
            if (r.breakdown.twenties > 0) billChips.push(`${r.breakdown.twenties}×$20`);
            if (r.breakdown.tens > 0) billChips.push(`${r.breakdown.tens}×$10`);
            if (r.breakdown.fives > 0) billChips.push(`${r.breakdown.fives}×$5`);
            if (r.breakdown.ones > 0) billChips.push(`${r.breakdown.ones}×$1`);

            html += `
                <div class="holiday-result-card">
                    <div class="holiday-result-header">
                        <span class="holiday-result-name">${escapeHtml(r.name)}</span>
                        <span class="holiday-result-total">$${r.wholeDollarPayout}</span>
                    </div>
                    <div class="holiday-result-breakdown">
                        <div class="holiday-result-period week-1">
                            <span class="holiday-result-period-label">Regular</span>
                            <span class="holiday-result-period-hours">${r.regularHours.toFixed(2)} hrs</span>
                            <span class="holiday-result-period-amount">$${r.regularTip.toFixed(2)}</span>
                        </div>
                        <div class="holiday-result-period week-2">
                            <span class="holiday-result-period-label">Holiday</span>
                            <span class="holiday-result-period-hours">${r.holidayHours.toFixed(2)} hrs</span>
                            <span class="holiday-result-period-amount">$${r.holidayTip.toFixed(2)}</span>
                        </div>
                    </div>
                    <div class="holiday-result-bills">
                        ${billChips.map(c => `<span class="holiday-bill-chip">${c}</span>`).join('')}
                    </div>
                </div>
            `;
        }

        resultsContainer.innerHTML = html;
        section.classList.add('visible');
    }

    function updateMatchStatus() {
        const statusEl = document.getElementById('holiday-match-status');
        const calcBtn = document.getElementById('holiday-calculate-btn');

        if (!statusEl || !calcBtn) return;

        const hasRegular = regularPartners.length > 0;
        const hasHoliday = holidayPartners.length > 0;
        const hasCash = regularCash > 0 || holidayCash > 0;

        if (hasRegular && hasHoliday && hasCash) {
            statusEl.className = 'holiday-match-status matched';
            statusEl.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                <span>Ready: ${regularPartners.length} regular + ${holidayPartners.length} holiday partners</span>
            `;
            calcBtn.disabled = false;
        } else if (hasRegular || hasHoliday) {
            statusEl.className = 'holiday-match-status partial';
            statusEl.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>${hasRegular ? '' : 'Upload Regular • '}${hasHoliday ? '' : 'Upload Holiday • '}${hasCash ? '' : 'Enter cash amounts'}</span>
            `;
            calcBtn.disabled = !hasCash;
        } else {
            statusEl.className = 'holiday-match-status none';
            statusEl.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>Upload reports to begin</span>
            `;
            calcBtn.disabled = true;
        }
    }

    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ============================================
    // EVENT HANDLERS
    // ============================================

    function handleFileUpload(type, file) {
        const statusEl = document.getElementById(`${type}-status`);
        const uploadZone = document.getElementById(`${type}-upload-zone`);

        if (!file || !statusEl) return;

        const updateStatus = (message, statusType) => {
            statusEl.className = `holiday-upload-status ${statusType}`;
            if (statusType === 'loading') {
                statusEl.innerHTML = `<div class="holiday-spinner"></div><span>${message}</span>`;
            } else {
                statusEl.textContent = message;
            }
        };

        // Convert file to base64 and process
        fileToBase64(file)
            .then(base64 => performOCR(base64, updateStatus))
            .then(partners => {
                if (type === 'regular') {
                    regularPartners = partners;
                    renderPartnersList('regular-partners-list', partners);
                } else {
                    holidayPartners = partners;
                    renderPartnersList('holiday-partners-list', partners);
                }

                updateStatus(`${partners.length} partners found`, 'success');
                uploadZone.classList.add('has-file');
                updateMatchStatus();
            })
            .catch(error => {
                updateStatus(`Error: ${error.message}`, 'error');
                holidayLog('Upload error:', error);
            });
    }

    function handleCalculate() {
        try {
            const regCash = parseFloat(document.getElementById('regular-cash').value) || 0;
            const holCash = parseFloat(document.getElementById('holiday-cash').value) || 0;

            if (regCash <= 0 && holCash <= 0) {
                alert('Please enter cash amounts for at least one category.');
                return;
            }

            const data = calculateHolidaySplitTips(regularPartners, regCash, holidayPartners, holCash);
            lastResults = data;
            renderResults(data);

        } catch (error) {
            alert(`Calculation error: ${error.message}`);
            holidayLog('Calculation error:', error);
        }
    }

    function handleCashInput() {
        regularCash = parseFloat(document.getElementById('regular-cash')?.value) || 0;
        holidayCash = parseFloat(document.getElementById('holiday-cash')?.value) || 0;
        updateMatchStatus();
    }

    // ============================================
    // PUBLIC API
    // ============================================

    function init() {
        // Create toggle button if it doesn't exist
        if (!document.getElementById('holiday-toggle-btn')) {
            createToggleButton();
        }

        // Create overlay if it doesn't exist
        if (!document.getElementById('holiday-dashboard-overlay')) {
            createOverlay();
        }
    }

    function createToggleButton() {
        const toggleContainer = document.createElement('div');
        toggleContainer.className = 'holiday-toggle-container';
        toggleContainer.innerHTML = `
            <button type="button" class="holiday-toggle-btn" id="holiday-toggle-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                <span>Try Holiday Automation Mode</span>
                <span class="beta-badge">Beta</span>
            </button>
        `;

        // Insert after header, before main content
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            mainContent.parentNode.insertBefore(toggleContainer, mainContent);
        }

        document.getElementById('holiday-toggle-btn').addEventListener('click', activate);
    }

    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'holiday-dashboard-overlay';
        overlay.className = 'holiday-dashboard-overlay';
        overlay.innerHTML = createDashboardHTML();
        document.body.appendChild(overlay);

        // Attach event listeners
        document.getElementById('holiday-close-btn').addEventListener('click', deactivate);

        document.getElementById('regular-file-input').addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) handleFileUpload('regular', file);
        });

        document.getElementById('holiday-file-input').addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) handleFileUpload('holiday', file);
        });

        document.getElementById('regular-cash').addEventListener('input', handleCashInput);
        document.getElementById('holiday-cash').addEventListener('input', handleCashInput);

        document.getElementById('holiday-calculate-btn').addEventListener('click', handleCalculate);

        // Drag and drop support
        [{ id: 'regular-upload-zone', type: 'regular' }, { id: 'holiday-upload-zone', type: 'holiday' }].forEach(({ id, type }) => {
            const zone = document.getElementById(id);
            if (!zone) return;

            zone.addEventListener('dragover', (e) => {
                e.preventDefault();
                zone.classList.add('dragover');
            });

            zone.addEventListener('dragleave', () => {
                zone.classList.remove('dragover');
            });

            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                zone.classList.remove('dragover');
                const file = e.dataTransfer?.files?.[0];
                if (file && file.type.startsWith('image/')) {
                    handleFileUpload(type, file);
                }
            });
        });

        // Close on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isActive) {
                deactivate();
            }
        });
    }

    function activate() {
        const overlay = document.getElementById('holiday-dashboard-overlay');
        if (overlay) {
            overlay.classList.add('active');
            isActive = true;
            document.body.style.overflow = 'hidden';
        }
    }

    function deactivate() {
        const overlay = document.getElementById('holiday-dashboard-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            isActive = false;
            document.body.style.overflow = '';
        }
    }

    function reset() {
        regularPartners = [];
        holidayPartners = [];
        regularCash = 0;
        holidayCash = 0;
        lastResults = null;

        // Reset UI
        ['regular', 'holiday'].forEach(type => {
            const listEl = document.getElementById(`${type}-partners-list`);
            const statusEl = document.getElementById(`${type}-status`);
            const cashEl = document.getElementById(`${type}-cash`);
            const zoneEl = document.getElementById(`${type}-upload-zone`);

            if (listEl) listEl.style.display = 'none';
            if (statusEl) statusEl.textContent = '';
            if (cashEl) cashEl.value = '';
            if (zoneEl) zoneEl.classList.remove('has-file');
        });

        const resultsSection = document.getElementById('holiday-results-section');
        if (resultsSection) resultsSection.classList.remove('visible');

        updateMatchStatus();
    }

    // Return public API
    return {
        init,
        activate,
        deactivate,
        reset,
        isActive: () => isActive,
        getResults: () => lastResults
    };

})();

// ============================================
// AUTO-INITIALIZE ON DOM READY
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Initialize the Holiday Automation module
    HolidayAutomation.init();
});
