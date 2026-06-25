// Dark mode — apply immediately to prevent flash
(function() {
    const stored = localStorage.getItem('theme');
    if (stored !== 'light') {
        document.body.classList.add('dark');
    }
})();

function t(key, vars = {}) {
    return window.I18n ? window.I18n.t(key, vars) : key;
}

function tCommodity(name) {
    return window.I18n ? window.I18n.commodityLabel(name) : name;
}

function tPos(pos) {
    return window.I18n ? window.I18n.positionLabel(pos) : pos;
}

// Commodity list
const COMMODITIES = [
    'Gold',
    'Silver',
    'Copper',
    'Sugar',
    'Oil Brent',
    'Natural Gas',
    'Cotton',
    'Coffee',
    'Cocoa',
    'Aluminium'
];

// Yahoo Finance ticker mapping
const COMMODITY_TICKERS = {
    'Gold': 'GC=F',
    'Silver': 'SI=F',
    'Copper': 'HG=F',
    'Sugar': 'SB=F',
    'Oil Brent': 'BZ=F',
    'Natural Gas': 'NG=F',
    'Cotton': 'CT=F',
    'Coffee': 'KC=F',
    'Cocoa': 'CC=F',
    'Aluminium': 'ALI=F'
};

// Default signals (all zero — updated by signals.json)
const DEFAULT_SIGNALS = {
    'Gold': 0,
    'Silver': 0,
    'Copper': 0,
    'Sugar': 0,
    'Oil Brent': 0,
    'Natural Gas': 0,
    'Cotton': 0,
    'Coffee': 0,
    'Cocoa': 0,
    'Aluminium': 0
};

// State
let signals = { ...DEFAULT_SIGNALS };
let signalsDate = '';
let signalsTimestamp = ''; // Full ISO timestamp from signals.json

let longOnlyMode = false; // Toggle for Long-Only allocation mode
let relatedStocksData = null; // Cache for related stocks data
let signalHistory = []; // Historical signals from localStorage: [{date, signals}]

// Risk model toggle
let currentRiskModel = 'high'; // 'high' | 'low'
let signalsLowRisk = { ...DEFAULT_SIGNALS };
let historicalDataLowRisk = [];

// Historical performance data
// Format: { date: 'YYYY-MM-DD', predictions: { commodity: signal }, actuals: { commodity: priceChange } }
let historicalData = [];
let bestAnnualizedReturn = 0;

// Pre-computed equity curves from Python pipeline
let equityCurveData = null;
let metricsDataGlobal = null; // cached portfolio_metrics.json for risk model switching
let annReturnHigh = 0;
let annReturnLow = 0;

// Load signal history from localStorage
function loadSignalHistory() {
    try {
        const stored = localStorage.getItem('signalHistory');
        if (stored) {
            signalHistory = JSON.parse(stored);
        }
    } catch (e) {
        console.warn('Failed to load signal history:', e);
        signalHistory = [];
    }
}

// Save signal history to localStorage
function saveSignalHistory() {
    try {
        localStorage.setItem('signalHistory', JSON.stringify(signalHistory.slice(0, 30)));
    } catch (e) {
        console.warn('Failed to save signal history:', e);
    }
}

function saveAllocationSnapshot() {
    try {
        const result = calculatePortfolio(getActiveSignals());
        const snapshot = {
            date: signalsDate,
            longShort: {},
            longOnly: {}
        };
        result.longShort.forEach(a => { snapshot.longShort[a.commodity] = a.percentage; });
        result.longOnly.forEach(a => { snapshot.longOnly[a.commodity] = a.percentage; });
        let history = JSON.parse(localStorage.getItem('allocationHistory') || '[]');
        const existingIdx = history.findIndex(e => e.date === snapshot.date);
        if (existingIdx === -1) {
            history.unshift(snapshot);
            localStorage.setItem('allocationHistory', JSON.stringify(history.slice(0, 30)));
        }
    } catch (e) {
        console.warn('Failed to save allocation snapshot:', e);
    }
}

// Get last N trading days from history (excluding current)
function getRecentHistory(count) {
    return signalHistory.slice(1, count + 1);
}

// Compute allocation % change vs previous trading day
function computeAllocationChange() {
    const mode = longOnlyMode ? 'longOnly' : 'longShort';
    const todayResult = calculatePortfolio(getActiveSignals());
    const todayMap = {};
    todayResult[mode].forEach(a => { todayMap[a.commodity] = a.percentage; });

    const history = JSON.parse(localStorage.getItem('allocationHistory') || '[]');
    if (history.length < 2) return null;

    const yesterday = history[1][mode] || {};
    const changes = {};
    COMMODITIES.forEach(c => {
        changes[c] = (todayMap[c] || 0) - (yesterday[c] || 0);
    });
    return changes;
}

// Find yesterday's signals: try localStorage history first,
// fall back to most recent entry in daily_predictions.json
// Load daily signals from external source
async function loadDailySignals() {
    try {
        const response = await fetch('signals.json');
        if (!response.ok) {
            console.log('No signals file found, using defaults');
            return;
        }
        
        const data = await response.json();
        signalsDate = data.date;
        signalsTimestamp = data.timestamp || data.date;
        
        // Update signals (high risk)
        COMMODITIES.forEach(commodity => {
            if (data.signals.hasOwnProperty(commodity)) {
                signals[commodity] = data.signals[commodity];
            }
        });
        // Update low-risk signals
        if (data.signals_low_risk) {
            COMMODITIES.forEach(commodity => {
                if (data.signals_low_risk.hasOwnProperty(commodity)) {
                    signalsLowRisk[commodity] = data.signals_low_risk[commodity];
                }
            });
        }
        
        // Store in history if not already present
        const existingIdx = signalHistory.findIndex(e => e.date === data.date);
        if (existingIdx === -1) {
            signalHistory.unshift({ date: data.date, signals: { ...signals } });
            saveSignalHistory();
        }
        
        // Remove skeletons
        hideSkeletons();
        
        // Show notification
        const timestamp = new Date(data.timestamp || data.date).toLocaleString();
        console.log(`Signals loaded from ${timestamp}`);
        
        saveAllocationSnapshot();
        renderAllocation();
        
    } catch (error) {
        console.error('Error loading daily signals:', error);
        hideSkeletons();
    }
}

// Format date for display (skip to Monday if weekend)
function getAllocationDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const day = d.getDay();
    if (day === 0) d.setDate(d.getDate() + 1);  // Sunday → Monday
    if (day === 6) d.setDate(d.getDate() + 2);   // Saturday → Monday
    const locale = window.I18n && I18n.getLang() === 'sv' ? 'sv-SE' : 'en-US';
    return d.toLocaleDateString(locale, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function getForecastDate(dateStr, timestampStr) {
    const ts = timestampStr ? new Date(timestampStr) : new Date(dateStr);
    const date = new Date(dateStr);
    const marketOpenHourUTC = 13;
    const dayOfWeek = ts.getUTCDay();
    const hourUTC = ts.getUTCHours();
    const minuteUTC = ts.getUTCMinutes();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isBeforeMarketOpen = hourUTC < marketOpenHourUTC ||
        (hourUTC === marketOpenHourUTC && minuteUTC === 0);
    if (isWeekend) {
        const d = new Date(date);
        const day = d.getDay();
        if (day === 5) d.setDate(d.getDate() + 3);
        else if (day === 6) d.setDate(d.getDate() + 2);
        else if (day === 0) d.setDate(d.getDate() + 1);
        else d.setDate(d.getDate() + 1);
        return d;
    }
    if (isBeforeMarketOpen) {
        return date;
    }
    const d = new Date(dateStr);
    const day = d.getDay();
    if (day === 5) {
        d.setDate(d.getDate() + 3);
    } else if (day === 6) {
        d.setDate(d.getDate() + 2);
    } else {
        d.setDate(d.getDate() + 1);
    }
    return d;
}

function openSiteUpdateModal() {
    const modal = document.getElementById('siteUpdateModal');
    if (modal) {
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }
}

function closeSiteUpdateModal() {
    const modal = document.getElementById('siteUpdateModal');
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeSiteUpdateModal();
    }
});

// Close modal on overlay click
document.addEventListener('click', (e) => {
    if (e.target.id === 'siteUpdateModal') {
        closeSiteUpdateModal();
    }
});

// Initialize site update button — also set up inline as a fallback
function initSiteUpdateButton() {
    const btn = document.getElementById('siteUpdateBtn');
    if (btn) {
        btn.addEventListener('click', openSiteUpdateModal);
    }
}

// Direct onclick fallback for the button
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('siteUpdateBtn');
    if (btn && !btn._handlerAttached) {
        btn.addEventListener('click', openSiteUpdateModal);
        btn._handlerAttached = true;
    }
});

// Hide all skeleton loaders
function hideSkeletons() {
    document.querySelectorAll('.skeleton').forEach(el => el.remove());
}

// Toast notification system
function showToast(message, type = 'success', duration = 3500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
    toast.innerHTML = `<span style="font-size:1.1rem;font-weight:700">${icons[type] || 'ℹ'}</span> ${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 260);
    }, duration);
}

// Modal dialog
let modalResolve = null;

function showModal(title, bodyHTML) {
    return new Promise((resolve) => {
        modalResolve = resolve;
        const overlay = document.getElementById('modalOverlay');
        const titleEl = document.getElementById('modalTitle');
        const bodyEl = document.getElementById('modalBody');
        const confirmBtn = document.getElementById('modalConfirmBtn');
        const cancelBtn = document.getElementById('modalCancelBtn');
        const closeBtn = document.getElementById('modalCloseBtn');

        titleEl.textContent = title;
        bodyEl.innerHTML = bodyHTML;
        if (window.I18n) I18n.apply();
        overlay.classList.remove('hidden');

        function cleanup(result) {
            overlay.classList.add('hidden');
            modalResolve = null;
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
        }

        function onConfirm() {
            cleanup(true);
            resolve(true);
        }

        function onCancel() {
            cleanup(false);
            resolve(false);
        }

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) onCancel();
        });
        document.addEventListener('keydown', function handler(e) {
            if (e.key === 'Escape') { onCancel(); document.removeEventListener('keydown', handler); }
        });
    });
}

// Dark mode toggle
function setupThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const updateBtn = () => {
        btn.textContent = document.body.classList.contains('dark') ? '☀️' : '🌙';
        btn.setAttribute('aria-label', document.body.classList.contains('dark') ? t('switchLight') : t('switchDark'));
    };
    updateBtn();
    btn.addEventListener('click', () => {
        document.body.classList.toggle('dark');
        localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
        updateBtn();
        drawPerformanceChart();
    });
}

// Redraw chart on resize
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawPerformanceChart, 100);
});

// Initialize the application
function refreshLanguageUI() {
    if (window.I18n) I18n.apply();
    setupRiskModelBar();
    renderAllocation();
    renderHistoryAllocations();
    renderHistoryTable();
    renderPerformanceStats();
    loadModelPerformance();
    if (relatedStocksData) {
        displayRelatedStocks(relatedStocksData);
    }
    drawPerformanceChart();

    // Update HTML title/aria-label attributes
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        const isDark = document.body.classList.contains('dark');
        themeBtn.title = isDark ? t('switchLight') : t('switchDark');
        themeBtn.setAttribute('aria-label', isDark ? t('switchLight') : t('switchDark'));
    }
    const closeBtn = document.getElementById('modalCloseBtn');
    if (closeBtn) closeBtn.setAttribute('aria-label', t('modalCancel'));
    updateAllocModeLabel();
}

async function init() {
    try {
        if (window.I18n) {
            I18n.init();
            I18n.onLangChange(refreshLanguageUI);
        }
        setupThemeToggle();
        loadSignalHistory();
        setupEventListeners();
        setupTabNavigation();
        setupAboutModelPage();
        setupRiskModelBar();
        initSiteUpdateButton();
        await initializeHistoricalPerformance();
        loadRelatedStocks();
        loadDailySignals();
        loadModelPerformance();
        renderAllocation();
    } catch (e) {
        console.error('Init error:', e);
    }
}



// Get CSS class based on signal value
function getSignalClass(value) {
    if (value > 0) return 'positive';
    if (value < 0) return 'negative';
    return 'neutral';
}

// Setup event listeners
function setupEventListeners() {

    
    const allocToggle = document.getElementById('allocModeToggle');
    if (allocToggle) {
        allocToggle.addEventListener('click', () => {
            longOnlyMode = !longOnlyMode;
            updateAllocModeLabel();
            renderAllocation();
            renderHistoryAllocations();
        });
    }
}

function updateAllocModeLabel() {
    const textEl = document.getElementById('allocModeText');
    if (textEl) {
        textEl.textContent = longOnlyMode ? t('allocModeLongOnly') : t('allocModeLongShort');
        textEl.dataset.i18n = longOnlyMode ? 'allocModeLongOnly' : 'allocModeLongShort';
    }
    const toggleEl = document.getElementById('allocModeToggle');
    if (toggleEl) {
        toggleEl.title = longOnlyMode ? t('allocModeLongShort') : t('allocModeLongOnly');
        toggleEl.classList.toggle('long-only', longOnlyMode);
    }
}

// Calculate portfolio allocations
function calculatePortfolio(signalsToUse = signals) {
    return {
        longOnly: calculateLongOnly(signalsToUse),
        longShort: calculateLongShort(signalsToUse)
    };
}

// Commodity abbreviation map for signal dots
const COMMODITY_ABBR = {
    'Gold': 'GC',
    'Silver': 'SI',
    'Copper': 'HG',
    'Sugar': 'SB',
    'Oil Brent': 'BZ',
    'Natural Gas': 'NG',
    'Cotton': 'CT',
    'Coffee': 'KC',
    'Cocoa': 'CC',
    'Aluminium': 'ALI'
};

// Render signal strength dots
function getActiveSignals() {
    return currentRiskModel === 'high' ? signals : signalsLowRisk;
}

function getActiveHistoricalData() {
    return currentRiskModel === 'high' ? historicalData : historicalDataLowRisk;
}

function renderSignalDots() {
    const container = document.getElementById('signalDots');
    if (!container) return;

    const activeSignals = getActiveSignals();

    const headingEl = document.getElementById('signalStrengthHeading');
    const infoEl = document.getElementById('signalStrengthInfo');
    if (headingEl) headingEl.textContent = t('signalStrength');
    if (infoEl) infoEl.textContent = t('signalStrengthInfo');

    // Add update timestamp info next to heading
    if (headingEl && signalsDate) {
        let updateInfoEl = document.getElementById('signalUpdateInfo');
        if (!updateInfoEl) {
            updateInfoEl = document.createElement('span');
            updateInfoEl.id = 'signalUpdateInfo';
            updateInfoEl.className = 'signal-update-info';
            headingEl.insertAdjacentElement('afterend', updateInfoEl);
        }
        const updatedDate = new Date(signalsTimestamp || signalsDate);
        const locale = window.I18n && I18n.getLang() === 'sv' ? 'sv-SE' : 'en-US';
        const forecastDate = getForecastDate(signalsDate, signalsTimestamp);
        const updatedStr = updatedDate.toLocaleString(locale, {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).replace(',', '');
        const forecastStr = forecastDate.toLocaleDateString(locale, {
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        updateInfoEl.textContent = `  ${t('signalsUpdated')} ${updatedStr} ${t('forForecastOf')} ${forecastStr}`;
    }

    const hasData = COMMODITIES.some(c => activeSignals[c] !== 0);

    container.innerHTML = '';

    COMMODITIES.forEach(commodity => {
        const signal = activeSignals[commodity];
        const absSignal = Math.abs(signal);

        const dot = document.createElement('div');
        dot.className = 'signal-dot';
        dot.title = `${tCommodity(commodity)}: ${signal >= 0 ? '+' : ''}${signal.toFixed(2)}`;

        const circle = document.createElement('div');
        circle.className = 'signal-dot-circle';

        let bgColor;
        if (signal > 0) {
            const intensity = Math.min(absSignal, 1);
            const lightness = 52 - intensity * 22;
            bgColor = `hsl(142, 72%, ${lightness}%)`;
        } else if (signal < 0) {
            const intensity = Math.min(absSignal, 1);
            const lightness = 52 - intensity * 22;
            bgColor = `hsl(0, 72%, ${lightness}%)`;
        } else {
            bgColor = '#6b7280';
        }
        circle.style.background = bgColor;
        circle.textContent = COMMODITY_ABBR[commodity] || commodity.slice(0, 2).toUpperCase();

        const label = document.createElement('div');
        label.className = 'signal-dot-label';
        label.textContent = tCommodity(commodity);

        const value = document.createElement('div');
        value.className = `signal-dot-value ${getSignalClass(signal)}`;
        value.textContent = signal >= 0 ? '+' : '';
        value.textContent += signal.toFixed(2);

        dot.appendChild(circle);
        dot.appendChild(label);
        dot.appendChild(value);
        container.appendChild(dot);
    });
}

// Render current allocation
function renderAllocation() {
    const result = calculatePortfolio(getActiveSignals());
    const mode = longOnlyMode ? 'longOnly' : 'longShort';
    const alloc = result[mode];
    
    renderSignalDots();

    const dateEl = document.getElementById('allocationDate');
    if (dateEl) {
        dateEl.textContent = getAllocationDate(signalsDate);
    }
    
    const changes = computeAllocationChange() || {};
    displayAllocation(alloc, 'currentDayChart', 'currentDayTable', changes);
}

function displayAllocation(allocations, chartId, tableId, changes) {
    const chartContainer = document.getElementById(chartId);
    const tableContainer = document.getElementById(tableId);
    if (!chartContainer) return;
    
    chartContainer.innerHTML = '';
    
    const nonZeroAllocations = allocations.filter(item => Math.abs(item.percentage) > 0.1);
    
    if (nonZeroAllocations.length === 0) {
        chartContainer.innerHTML = `<p style="text-align: center; color: var(--text-secondary);">${t('noPositions')}</p>`;
        return;
    }
    
    const proportionalBar = document.createElement('div');
    proportionalBar.className = 'proportional-bar';
    
    nonZeroAllocations.forEach(item => {
        const segment = document.createElement('div');
        segment.className = `bar-segment ${item.allocation >= 0 ? 'positive' : 'negative'}`;
        segment.style.width = `${Math.abs(item.percentage)}%`;
        segment.title = `${tCommodity(item.commodity)}: ${item.percentage.toFixed(1)}%`;
        
        const label = document.createElement('div');
        label.className = 'segment-label';
        label.innerHTML = `<strong>${tCommodity(item.commodity)}</strong><br>${item.percentage.toFixed(1)}%`;
        segment.appendChild(label);
        
        proportionalBar.appendChild(segment);
    });
    
    chartContainer.appendChild(proportionalBar);
    
    if (!tableContainer) return;
    
    const table = document.createElement('table');
    
    const thead = document.createElement('thead');
    let headerHtml = `
        <tr>
            <th>${t('thCommodity')}</th>
            <th>${t('thSignal')}</th>
            <th>${t('thAllocation')}</th>
            <th>${t('thPosition')}</th>`;
    if (changes) {
        headerHtml += `<th class="change-col" title="${t('allocChangeTooltip')}">${t('allocChange')}</th>`;
    }
    headerHtml += '</tr>';
    thead.innerHTML = headerHtml;
    table.appendChild(thead);
    
    const tbody = document.createElement('tbody');
    
    allocations.forEach(item => {
        const row = document.createElement('tr');
        
        const positionKey = item.allocation > 0 ? 'Long' : item.allocation < 0 ? 'Short' : 'Neutral';
        const positionClass = item.allocation > 0 ? 'positive' : item.allocation < 0 ? 'negative' : 'neutral';
        
        const commodityCell = document.createElement('td');
        commodityCell.textContent = tCommodity(item.commodity);
        row.appendChild(commodityCell);
        
        const signalCell = document.createElement('td');
        signalCell.innerHTML = `<span class="table-number ${getSignalClass(item.signal)}">${item.signal >= 0 ? '+' : ''}${item.signal.toFixed(1)}</span>`;
        row.appendChild(signalCell);
        
        const allocationCell = document.createElement('td');
        allocationCell.innerHTML = `<span class="table-number ${positionClass}">${item.percentage >= 0 ? '+' : ''}${item.percentage.toFixed(1)}%</span>`;
        row.appendChild(allocationCell);
        
        const positionCell = document.createElement('td');
        positionCell.innerHTML = `<span class="table-number ${positionClass}">${tPos(positionKey)}</span>`;
        row.appendChild(positionCell);
        
        if (changes) {
            const changeCell = document.createElement('td');
            changeCell.className = 'change-col';
            const delta = changes[item.commodity] || 0;
            changeCell.innerHTML = `<span class="table-number ${getSignalClass(delta)}">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%</span>`;
            row.appendChild(changeCell);
        }
        
        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    
    tableContainer.innerHTML = '';
    tableContainer.appendChild(table);
}

// Historic overview is shown in the Historical Performance tab.
// Allocation % change vs previous day is shown inline in the allocation table
// when toggled via the `+` button.
function renderHistoryAllocations() {
    const container = document.getElementById('historyAllocations');
    if (container) {
        container.classList.add('hidden');
    }
}

// Calculate long-only portfolio (ignore negative signals)
function calculateLongOnly(signalsToUse = signals) {
    const allocations = [];
    let totalPositive = 0;
    
    // Calculate sum of positive signals
    COMMODITIES.forEach(commodity => {
        const signal = signalsToUse[commodity];
        if (signal > 0) {
            totalPositive += signal;
        }
    });
    
    // Calculate allocations
    COMMODITIES.forEach(commodity => {
        const signal = signalsToUse[commodity];
        const allocation = signal > 0 ? (signal / totalPositive) : 0;
        
        allocations.push({
            commodity,
            signal,
            allocation,
            percentage: allocation * 100
        });
    });
    
    return allocations.filter(a => a.allocation !== 0).sort((a, b) => b.allocation - a.allocation);
}

// Calculate long/short portfolio (use all signals)
function calculateLongShort(signalsToUse = signals) {
    const allocations = [];
    let totalAbsolute = 0;
    
    // Calculate sum of absolute signals
    COMMODITIES.forEach(commodity => {
        const signal = signalsToUse[commodity];
        totalAbsolute += Math.abs(signal);
    });
    
    // Calculate allocations
    COMMODITIES.forEach(commodity => {
        const signal = signalsToUse[commodity];
        const allocation = totalAbsolute > 0 ? (signal / totalAbsolute) : 0;
        
        allocations.push({
            commodity,
            signal,
            allocation,
            percentage: allocation * 100
        });
    });
    
    return allocations.filter(a => a.allocation !== 0).sort((a, b) => Math.abs(b.allocation) - Math.abs(a.allocation));
}

function activateTab(targetTab) {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const panel = document.getElementById(`${targetTab}Tab`);
    if (!panel) return;

    tabBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.tab === targetTab);
    });
    tabContents.forEach(c => c.classList.remove('active'));
    panel.classList.add('active');

    setupRiskModelBar();

    if (targetTab === 'history') {
        setTimeout(drawPerformanceChart, 50);
    }
}

// Setup tab navigation
function setupTabNavigation() {
    const tabBtns = document.querySelectorAll('.tab-btn');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            activateTab(btn.dataset.tab);
            history.replaceState(null, '', `#${btn.dataset.tab}`);
        });
    });

    const hashTab = window.location.hash.replace('#', '');
    if (hashTab && document.getElementById(`${hashTab}Tab`)) {
        activateTab(hashTab);
    }
}

function setupAboutModelPage() {
    if (window.Chatbot && document.getElementById('chatbot-container')) {
        window.Chatbot.init('chatbot-container');
    }
}

// Initialize historical performance tab
async function initializeHistoricalPerformance() {
    try {
        await loadHistoricalData();
        renderHistoryTable();
        renderPerformanceStats();
        setTimeout(drawPerformanceChart, 100);
    } catch (e) {
        console.error('initializeHistoricalPerformance error:', e);
    }
}

async function loadHistoricalData() {
    try {
        const resp = await fetch('daily_predictions.json');
        if (!resp.ok) {
            historicalData = [];
            historicalDataLowRisk = [];
            return;
        }
        const data = await resp.json();
        if (!data.entries || data.entries.length === 0) {
            historicalData = [];
            historicalDataLowRisk = [];
            return;
        }
        historicalData = data.entries.map(e => ({
            date: e.date,
            predictions: e.predictions,
            actuals: e.actuals,
        }));
        historicalDataLowRisk = data.entries.map(e => ({
            date: e.date,
            predictions: e.predictions_low_risk || e.predictions,
            actuals: e.actuals,
        }));
    } catch (e) {
        console.warn('Failed to load historical data:', e);
        const fallback = [
            { date: '2026-04-01', predictions: { 'Gold': 0.5, 'Silver': 0.3, 'Copper': -0.2, 'Sugar': 0, 'Oil Brent': 0.4, 'Natural Gas': -0.3, 'Cotton': 0.1, 'Coffee': 0, 'Cocoa': -0.1, 'Aluminium': 0.2 }, actuals: { 'Gold': 1.2, 'Silver': 0.8, 'Copper': -0.5, 'Sugar': -0.1, 'Oil Brent': 0.9, 'Natural Gas': 0.3, 'Cotton': 0.2, 'Coffee': -0.2, 'Cocoa': -0.3, 'Aluminium': 0.4 } },
            { date: '2026-04-02', predictions: { 'Gold': 0.7, 'Silver': 0.4, 'Copper': 0.2, 'Sugar': -0.1, 'Oil Brent': 0.6, 'Natural Gas': -0.5, 'Cotton': 0, 'Coffee': 0.3, 'Cocoa': 0.1, 'Aluminium': -0.2 }, actuals: { 'Gold': 0.5, 'Silver': 0.3, 'Copper': 0.4, 'Sugar': 0.2, 'Oil Brent': 0.7, 'Natural Gas': -0.8, 'Cotton': 0.1, 'Coffee': 0.5, 'Cocoa': 0.2, 'Aluminium': -0.3 } },
            { date: '2026-04-03', predictions: { 'Gold': 0.8, 'Silver': 0.6, 'Copper': -0.4, 'Sugar': 0, 'Oil Brent': 0, 'Natural Gas': 0, 'Cotton': 0, 'Coffee': 0, 'Cocoa': 0, 'Aluminium': 0 }, actuals: { 'Gold': 1.5, 'Silver': 0.9, 'Copper': -0.6, 'Sugar': 0, 'Oil Brent': 0, 'Natural Gas': 0, 'Cotton': 0, 'Coffee': 0, 'Cocoa': 0, 'Aluminium': 0 } },
            { date: '2026-04-04', predictions: { 'Gold': 0.6, 'Silver': 0.5, 'Copper': -0.3, 'Sugar': 0.2, 'Oil Brent': -0.4, 'Natural Gas': 0.3, 'Cotton': 0, 'Coffee': -0.2, 'Cocoa': 0.4, 'Aluminium': 0.1 }, actuals: null },
        ];
        historicalData = fallback;
        historicalDataLowRisk = fallback;
    }
}

// Group entries by year then month (newest first)
function groupEntriesByYearMonth(entries) {
    const groups = {};
    entries.forEach(e => {
        const d = new Date(e.date);
        const y = d.getFullYear();
        const m = d.getMonth();
        if (!groups[y]) groups[y] = {};
        if (!groups[y][m]) groups[y][m] = [];
        groups[y][m].push(e);
    });
    // Sort years descending
    const years = Object.keys(groups).map(Number).sort((a, b) => b - a);
    const result = [];
    for (const y of years) {
        const months = Object.keys(groups[y]).map(Number).sort((a, b) => b - a);
        const monthList = [];
        for (const m of months) {
            groups[y][m].sort((a, b) => b.date.localeCompare(a.date));
            monthList.push({ month: m, entries: groups[y][m] });
        }
        result.push({ year: y, months: monthList });
    }
    return result;
}

// Compute accuracy for a set of entries (flat/no-trend predictions excluded)
function computeAccuracy(entries) {
    let total = 0, correct = 0;
    entries.forEach(entry => {
        if (!entry.actuals) return;
        COMMODITIES.forEach(c => {
            const pred = entry.predictions[c] || 0;
            const act = entry.actuals[c];
            if (act == null) return;
            if (pred === 0) return; // skip flat predictions
            total++;
            if (Math.sign(pred) === Math.sign(act)) {
                correct++;
            }
        });
    });
    return total > 0 ? { total, correct, pct: (correct / total * 100) } : { total: 0, correct: 0, pct: 0 };
}

function getFilteredHistoricalData(data) {
    const src = data || historicalData;
    if (!src || src.length === 0) return [];
    const sorted = [...src].sort((a, b) => a.date.localeCompare(b.date));
    const newestDate = new Date(sorted[sorted.length - 1].date);
    const yearsToShow = 5;
    const cutoffDate = new Date(newestDate);
    cutoffDate.setFullYear(cutoffDate.getFullYear() - yearsToShow);
    return src.filter(e => new Date(e.date) >= cutoffDate);
}

// Render the historical performance table with year→month accordion
function renderHistoryTable() {
    const container = document.querySelector('.history-table-container');
    if (!container) return;

    const activeData = getActiveHistoricalData();

    container.innerHTML = '';

    if (!activeData || activeData.length === 0) {
        container.innerHTML = `<div class="history-empty">${t('noHistoryData')}</div>`;
        return;
    }

    const filteredData = getFilteredHistoricalData(activeData);
    const grouped = groupEntriesByYearMonth(filteredData);

    const accordion = document.createElement('div');
    accordion.className = 'history-accordion';

    grouped.forEach((yearGroup) => {
        const yearDiv = document.createElement('div');
        yearDiv.className = 'history-year';

        const yearAcc = computeAccuracy(
            yearGroup.months.reduce((acc, m) => acc.concat(m.entries), [])
        );
        const yearHeader = document.createElement('div');
        yearHeader.className = 'history-year-header';
        yearHeader.innerHTML = `
            <span class="accordion-chevron">▶</span>
            <span class="accordion-label">${yearGroup.year}</span>
            <span class="accordion-stats">(${yearAcc.total} entries, ${yearAcc.pct.toFixed(1)}% accuracy)</span>
        `;

        const monthContainer = document.createElement('div');
        monthContainer.className = 'history-month-container';

        yearGroup.months.forEach((monthGroup) => {
            const monthDiv = document.createElement('div');
            monthDiv.className = 'history-month';

            const monthAcc = computeAccuracy(monthGroup.entries);
            const monthName = new Date(yearGroup.year, monthGroup.month).toLocaleDateString(
                window.I18n && I18n.getLang() === 'sv' ? 'sv-SE' : 'en-US',
                { month: 'long' }
            );
            const monthHeader = document.createElement('div');
            monthHeader.className = 'history-month-header';
            monthHeader.innerHTML = `
                <span class="accordion-chevron">▶</span>
                <span class="accordion-label">${monthName}</span>
                <span class="accordion-stats">(${monthAcc.total} entries, ${monthAcc.pct.toFixed(1)}% accuracy)</span>
            `;

            const dayContainer = document.createElement('div');
            dayContainer.className = 'history-day-container';

            // ── Scrolling Commodity Strips ──
            const stripWrapper = document.createElement('div');
            stripWrapper.className = 'hist-strip-wrapper';

            const table = document.createElement('table');
            table.className = 'hist-strip-table';

            // Header row
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            const dateTh = document.createElement('th');
            dateTh.className = 'hist-strip-date';
            dateTh.textContent = t('thDate');
            headerRow.appendChild(dateTh);
            COMMODITIES.forEach(c => {
                const th = document.createElement('th');
                th.textContent = tCommodity(c);
                headerRow.appendChild(th);
            });
            thead.appendChild(headerRow);
            table.appendChild(thead);

            // Body rows
            const tbody = document.createElement('tbody');
            monthGroup.entries.forEach(entry => {
                const row = document.createElement('tr');

                const dateCell = document.createElement('td');
                dateCell.className = 'hist-strip-date-cell';
                const d = (() => { const x = new Date(entry.date); const w = x.getDay(); if (w === 5) x.setDate(x.getDate() + 3); else if (w === 6) x.setDate(x.getDate() + 2); else x.setDate(x.getDate() + 1); return x; })();
                dateCell.innerHTML = `
                    <span class="strip-date-dow">${d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                    <span class="strip-date-num">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                `;
                row.appendChild(dateCell);

                COMMODITIES.forEach(c => {
                    const cell = document.createElement('td');
                    const prediction = entry.predictions[c] || 0;
                    const actual = entry.actuals != null ? entry.actuals[c] : null;
                    const predStr = `${prediction >= 0 ? '+' : ''}${prediction.toFixed(2)}`;

                    if (prediction === 0 && (actual === null || actual === undefined)) {
                        cell.className = 'strip-cell strip-na';
                        cell.innerHTML = `<span class="strip-pred">0.00</span>`;
                    } else if (prediction === 0) {
                        cell.className = 'strip-cell strip-zero';
                        const actStr = actual != null ? `${actual >= 0 ? '+' : ''}${actual.toFixed(2)}%` : '';
                        cell.innerHTML = `
                            <span class="strip-arrow">−</span>
                            <span class="strip-pred">0.00</span>
                            ${actual != null ? `<span class="strip-act">${actStr}</span>` : ''}
                        `;
                    } else if (actual === null || actual === undefined) {
                        cell.className = 'strip-cell strip-pending';
                        cell.innerHTML = `
                            <span class="strip-arrow">→</span>
                            <span class="strip-pred">${predStr}</span>
                            <span class="strip-act">⏳</span>
                        `;
                    } else {
                        const predDir = Math.sign(prediction);
                        const actDir = Math.sign(actual);
                        const isCorrect = predDir === actDir || (predDir === 0 && actDir === 0);
                        cell.className = `strip-cell ${isCorrect ? 'strip-correct' : 'strip-incorrect'}`;
                        const arrow = prediction >= 0 ? '▲' : '▼';
                        const actStr = `${actual >= 0 ? '+' : ''}${actual.toFixed(2)}%`;
                        cell.innerHTML = `
                            <span class="strip-arrow">${arrow}</span>
                            <span class="strip-pred">${predStr}</span>
                            <span class="strip-act">${actStr}</span>
                        `;
                    }
                    row.appendChild(cell);
                });

                tbody.appendChild(row);
            });
            table.appendChild(tbody);
            stripWrapper.appendChild(table);
            dayContainer.appendChild(stripWrapper);

            // Accordion expand/collapse
            const now = new Date();
            const isCurrentMonth = yearGroup.year === now.getFullYear() && monthGroup.month === now.getMonth();

            if (isCurrentMonth) {
                monthHeader.classList.add('expanded');
                dayContainer.classList.add('expanded');
                monthHeader.querySelector('.accordion-chevron').textContent = '▼';
            }

            monthDiv.appendChild(monthHeader);
            monthDiv.appendChild(dayContainer);
            monthContainer.appendChild(monthDiv);

            monthHeader.addEventListener('click', () => {
                const isExpanded = dayContainer.classList.contains('expanded');
                dayContainer.classList.toggle('expanded');
                monthHeader.classList.toggle('expanded');
                monthHeader.querySelector('.accordion-chevron').textContent = isExpanded ? '▶' : '▼';
            });
        });

        yearDiv.appendChild(yearHeader);
        yearDiv.appendChild(monthContainer);
        accordion.appendChild(yearDiv);

        const now = new Date();
        const isCurrentYear = yearGroup.year === now.getFullYear();

        if (isCurrentYear) {
            yearHeader.classList.add('expanded');
            monthContainer.classList.add('expanded');
            yearHeader.querySelector('.accordion-chevron').textContent = '▼';
        }

        yearHeader.addEventListener('click', () => {
            const isExpanded = monthContainer.classList.contains('expanded');
            monthContainer.classList.toggle('expanded');
            yearHeader.classList.toggle('expanded');
            yearHeader.querySelector('.accordion-chevron').textContent = isExpanded ? '▶' : '▼';
        });
    });

    container.appendChild(accordion);
}

function computeLiveAnnualizedReturn(liveDate) {
    const curveKey = currentRiskModel === 'high' ? 'high_risk' : 'low_risk';
    const dates = equityCurveData.dates;
    const values = equityCurveData[curveKey];
    if (!values || values.length < 2) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const liveIdx = dates.indexOf(liveDate);
    if (liveIdx === -1 || liveIdx >= values.length - 1) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const eqLive = values[liveIdx];
    const eqLast = values[values.length - 1];
    if (!eqLive || eqLive === 0) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const days = values.length - 1 - liveIdx;
    if (days <= 0) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const totalReturn = eqLast / eqLive - 1;
    const annReturn = Math.pow(1 + totalReturn, 252 / days) - 1;
    const cssClass = annReturn >= 0 ? 'success' : 'danger';
    const formatted = `${annReturn >= 0 ? '+' : ''}${(annReturn * 100).toFixed(2)}%`;
    return { formatted, cssClass, numericValue: annReturn };
}

function computeEquitySinceLive(liveDate, curveKey) {
    if (!equityCurveData || !equityCurveData.dates || !equityCurveData[curveKey]) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const dates = equityCurveData.dates;
    const values = equityCurveData[curveKey];
    const liveIdx = dates.indexOf(liveDate);
    if (liveIdx === -1 || liveIdx >= values.length - 1) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const eqLive = values[liveIdx];
    const eqLast = values[values.length - 1];
    if (!eqLive || eqLive === 0) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const equityValue = (eqLast / eqLive) * 100;
    const cssClass = equityValue >= 100 ? 'success' : 'danger';
    const formatted = equityValue.toFixed(2);
    return { formatted, cssClass, numericValue: equityValue };
}

function computeEquitySinceStart(curveKey) {
    if (!equityCurveData || !equityCurveData[curveKey] || equityCurveData[curveKey].length === 0) {
        return { formatted: '-', cssClass: '', numericValue: null };
    }
    const values = equityCurveData[curveKey];
    const eqLast = values[values.length - 1];
    const cssClass = eqLast >= 100 ? 'success' : 'danger';
    const formatted = eqLast.toFixed(2);
    return { formatted, cssClass, numericValue: eqLast };
}

function renderPerformanceStats() {
    const container = document.getElementById('performanceStats');
    container.innerHTML = '';

    const activeData = getActiveHistoricalData();
    const filteredData = getFilteredHistoricalData(activeData);
    const LIVE_DATE = '2026-06-24';
    
    // Live statistics (date >= LIVE_DATE)
    let liveTotalPredictions = 0;
    let liveCorrectPredictions = 0;
    
    activeData.forEach(entry => {
        if (entry.date < LIVE_DATE) return;
        if (!entry.actuals) return;
        
        COMMODITIES.forEach(commodity => {
            const prediction = entry.predictions[commodity] || 0;
            if (prediction === 0) return;
            const actual = entry.actuals[commodity];
            if (actual == null) return;
            
            liveTotalPredictions++;
            if (Math.sign(prediction) === Math.sign(actual)) {
                liveCorrectPredictions++;
            }
        });
    });
    
    const liveAccuracy = liveTotalPredictions > 0 ? (liveCorrectPredictions / liveTotalPredictions * 100) : 0;
    
    // Row 1: Live stats
    const liveValue = liveTotalPredictions > 0 ? `${liveAccuracy.toFixed(1)}%` : '-';
    const liveClass = liveTotalPredictions > 0 ? (liveAccuracy >= 50 ? 'success' : 'danger') : '';
    const liveCard = createStatCard(t('liveAccuracy'), liveValue, liveClass, liveTotalPredictions > 0 ? liveAccuracy : null);
    liveCard.querySelector('.stat-label').title = t('liveAccuracyHint');
    container.appendChild(liveCard);
    
    const totalCard = createStatCard(t('totalPredictions'), liveTotalPredictions.toString(), '', liveTotalPredictions, t('livePredictionsHint'));
    container.appendChild(totalCard);
    
    // Live portfolio value (third box) from portfolio_value.json
    const liveValCard = createStatCard(t('livePortfolioValue'), '...', '', null);
    liveValCard.id = 'livePortfolioValueCard';
    container.appendChild(liveValCard);
    (async () => {
        try {
            const resp = await fetch('portfolio_value.json?v=' + Date.now());
            if (resp.ok) {
                const pv = await resp.json();
                const val = pv.latest_value;
                const cssClass = val >= 100 ? 'success' : 'danger';
                liveValCard.querySelector('.stat-value').textContent = val.toFixed(2);
                liveValCard.querySelector('.stat-value').className = `stat-value ${cssClass}`;
                liveValCard._numericTarget = val;
            }
        } catch (e) {
            console.warn('Failed to load portfolio_value.json:', e);
        }
    })();
    
    const liveAnnRet = computeLiveAnnualizedReturn(LIVE_DATE);
    const livePerfCard = createStatCard(t('liveAvgPortfolioPerf'), liveAnnRet.formatted, liveAnnRet.cssClass, liveAnnRet.numericValue);
    livePerfCard.id = 'livePortfolioCard';
    container.appendChild(livePerfCard);
    
    // Live equity value (last / live * 100)
    const curveKey = currentRiskModel === 'high' ? 'high_risk' : 'low_risk';
    const liveEqValue = computeEquitySinceLive('2026-06-09', curveKey);
    const liveEqCard = createStatCard(t('livePortfolioValue'), liveEqValue.formatted, liveEqValue.cssClass, liveEqValue.numericValue);
    const subDiv = document.createElement('div');
    subDiv.className = 'stat-subtitle';
    subDiv.textContent = t('livePortfolioValueSubtitle');
    liveEqCard.querySelector('.stat-value').after(subDiv);
    liveEqCard.id = 'liveEqCard';
    container.appendChild(liveEqCard);
    
    // Test statistics (date < LIVE_DATE within filteredData)
    let testTotalPredictions = 0;
    let testCorrectPredictions = 0;
    
    filteredData.forEach(entry => {
        if (entry.date >= LIVE_DATE) return;
        if (!entry.actuals) return;
        
        COMMODITIES.forEach(commodity => {
            const prediction = entry.predictions[commodity] || 0;
            if (prediction === 0) return;
            const actual = entry.actuals[commodity];
            if (actual == null) return;
            
            testTotalPredictions++;
            if (Math.sign(prediction) === Math.sign(actual)) {
                testCorrectPredictions++;
            }
        });
    });
    
    const testAccuracy = testTotalPredictions > 0 ? (testCorrectPredictions / testTotalPredictions * 100) : 0;
    
    // Row 2: Test stats
    const testValue = testTotalPredictions > 0 ? `${testAccuracy.toFixed(1)}%` : '-';
    const testClass = testTotalPredictions > 0 ? (testAccuracy >= 50 ? 'success' : 'danger') : '';
    const testCard = createStatCard(t('testAccuracy'), testValue, testClass, testTotalPredictions > 0 ? testAccuracy : null);
    testCard.querySelector('.stat-label').title = t('testAccuracyHint');
    container.appendChild(testCard);
    
    const testCountCard = createStatCard(t('testPredictions'), testTotalPredictions.toString(), '', testTotalPredictions);
    container.appendChild(testCountCard);
    
    const currentAnnRet = currentRiskModel === 'high' ? annReturnHigh : annReturnLow;
    const testPerfCard = createStatCard(t('testAvgPortfolioPerf'),
        `${currentAnnRet >= 0 ? '+' : ''}${(currentAnnRet * 100).toFixed(2)}%`,
        currentAnnRet >= 0 ? 'success' : 'danger',
        currentAnnRet);
    testPerfCard.id = 'testPortfolioCard';
    container.appendChild(testPerfCard);
    
    // Training equity value (last value, starts at ~100)
    const trainEqValue = computeEquitySinceStart(curveKey);
    const trainEqCard = createStatCard(t('trainPortfolioValue'), trainEqValue.formatted, trainEqValue.cssClass, trainEqValue.numericValue);
    const trainSubDiv = document.createElement('div');
    trainSubDiv.className = 'stat-subtitle';
    trainSubDiv.textContent = t('trainPortfolioValueSubtitle');
    trainEqCard.querySelector('.stat-value').after(trainSubDiv);
    trainEqCard.id = 'trainEqCard';
    container.appendChild(trainEqCard);

    drawPerformanceChart();
}

// Create a stat card element with optional counter animation
function createStatCard(label, displayValue, valueClass, numericTarget, tooltip) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    if (tooltip) card.title = tooltip;
    
    const labelDiv = document.createElement('div');
    labelDiv.className = 'stat-label';
    labelDiv.textContent = label;
    
    const valueDiv = document.createElement('div');
    valueDiv.className = `stat-value ${valueClass}`;
    valueDiv.textContent = displayValue;
    
    card.appendChild(labelDiv);
    card.appendChild(valueDiv);

    // Animate numeric values counting up
    if (numericTarget !== undefined && numericTarget !== null) {
        const isPercent = typeof displayValue === 'string' && displayValue.includes('%');
        const isSigned = typeof displayValue === 'string' && (displayValue.startsWith('+') || displayValue.startsWith('-'));
        const startVal = 0;
        const endVal = numericTarget;
        const duration = 600;
        const startTime = performance.now();

        // Parse the display format
        let prefix = '';
        let suffix = '';
        let decimals = 1;
        if (isPercent) {
            suffix = '%';
            decimals = 1;
        } else if (Number.isInteger(endVal)) {
            decimals = 0;
        } else {
            decimals = 2;
        }

        function animate(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = startVal + (endVal - startVal) * eased;
            const formatted = (isSigned && current >= 0 ? '+' : '') + current.toFixed(decimals) + suffix;
            valueDiv.textContent = formatted;
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                valueDiv.textContent = displayValue;
            }
        }
        requestAnimationFrame(animate);
    }
    
    return card;
}

// Draw portfolio performance line chart (two curves: high risk, low risk)
function drawPerformanceChart() {
    const canvas = document.getElementById('performanceChart');
    if (!canvas) return;

    const isDark = document.body.classList.contains('dark');
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const HIGH_COLOR = '#dc2626';
    const LOW_COLOR = '#4682B4';
    const zeroLineColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';

    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = rect.width - 32;
    const h = 300;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    if (!equityCurveData || !equityCurveData.dates || equityCurveData.dates.length === 0) {
        ctx.fillStyle = textColor;
        ctx.font = '14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t('noHistoryData'), w / 2, h / 2);
        return;
    }

    const dates = equityCurveData.dates;
    const highRisk = equityCurveData.high_risk;
    const lowRisk = equityCurveData.low_risk;

    const pad = { top: 20, bottom: 64, left: 55, right: 30 };
    const chartW = w - pad.left - pad.right;
    const chartH = h - pad.top - pad.bottom;

    let minVal = Math.min(...highRisk, ...lowRisk);
    let maxVal = Math.max(...highRisk, ...lowRisk);
    const range = maxVal - minVal || 1;
    const yPadding = range * 0.1;
    const yMin = minVal - yPadding;
    const yMax = maxVal + yPadding;
    const yRange = yMax - yMin || 1;

    const xScale = (i) => pad.left + (i / (dates.length - 1)) * chartW;
    const yScale = (v) => pad.top + chartH - ((v - yMin) / yRange) * chartH;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    const gridCount = 5;
    for (let i = 0; i <= gridCount; i++) {
        const y = pad.top + (i / gridCount) * chartH;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();

        const val = yMax - (i / gridCount) * yRange;
        ctx.fillStyle = textColor;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(val.toFixed(1), pad.left - 8, y + 4);
    }

    const yHundred = yScale(100);
    ctx.strokeStyle = zeroLineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yHundred);
    ctx.lineTo(w - pad.right, yHundred);
    ctx.stroke();
    ctx.setLineDash([]);

    // "Start = 100" label above the dotted line, just before the last x-value
    const startLabelX = xScale(dates.length - 2);
    const startLabelY = yHundred - 8;
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t('startEqual100'), startLabelX, startLabelY);
    ctx.restore();

    // Vertical dashed line for "Went live" date
    const GO_LIVE_DATE = '2026-06-24';
    const liveIdx = dates.indexOf(GO_LIVE_DATE);
    if (liveIdx !== -1) {
        const liveX = xScale(liveIdx);
        ctx.save();
        ctx.strokeStyle = textColor;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(liveX, pad.top);
        ctx.lineTo(liveX, pad.top + chartH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = textColor;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(t('goLiveLabel'), liveX, pad.top - 4);
        ctx.restore();
    }

    ctx.textAlign = 'right';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = textColor;
    const maxLabels = 9;
    const xLabelCount = Math.min(dates.length, maxLabels);
    const xStep = xLabelCount > 1
        ? Math.max(1, Math.floor((dates.length - 1) / (xLabelCount - 1)))
        : 1;
    for (let i = 0; i < dates.length; i += xStep) {
        const x = xScale(i);
        const label = dates[i];
        ctx.save();
        ctx.translate(x, h - pad.bottom + 14);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(label, 0, 0);
        ctx.restore();
    }

    function drawCurve(data, color) {
        const points = data.map((v, i) => ({ x: xScale(i), y: yScale(v) }));
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) {
            const xc = (points[i].x + points[i + 1].x) / 2;
            const yc = (points[i].y + points[i + 1].y) / 2;
            ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();

        const last = points[points.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
    }

    const highAlpha = currentRiskModel === 'high' ? 1 : 0.5;
    const lowAlpha = currentRiskModel === 'low' ? 1 : 0.5;
    ctx.globalAlpha = highAlpha;
    drawCurve(highRisk, HIGH_COLOR);
    ctx.globalAlpha = lowAlpha;
    drawCurve(lowRisk, LOW_COLOR);
    ctx.globalAlpha = 1;

    // Legend
    const legendX = pad.left + 8;
    const legendY = pad.top + 8;
    ctx.font = '12px system-ui, sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5;

    ctx.globalAlpha = highAlpha;
    ctx.strokeStyle = HIGH_COLOR;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY + 6);
    ctx.lineTo(legendX + 20, legendY + 6);
    ctx.stroke();
    const isSv = window.I18n && I18n.getLang() === 'sv';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.fillText(isSv ? 'Högriskmodell' : 'High risk', legendX + 24, legendY + 10);

    ctx.globalAlpha = lowAlpha;
    ctx.strokeStyle = LOW_COLOR;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY + 22);
    ctx.lineTo(legendX + 20, legendY + 22);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(isSv ? 'Lågriskmodell' : 'Low risk', legendX + 24, legendY + 26);

    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const yLabel = window.I18n ? I18n.t('cumulativeReturn') : 'Cumulative Return';
    ctx.fillText(yLabel, pad.left + chartW / 2, h - 1);

    // Store chart state for hover
    canvas._chartState = { dates, highRisk, lowRisk, xScale, yScale, pad, h, w };
    setupPerformanceChartHover(canvas);
}

// Performance chart hover tooltip
(function() {
    let tooltip = null;
    let hoverActive = false;

    function initTooltip(canvas) {
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'chart-tooltip';
            tooltip.style.cssText =
                'position:absolute;pointer-events:none;background:rgba(0,0,0,0.8);color:#fff;'
                + 'font:11px system-ui,sans-serif;padding:6px 10px;border-radius:4px;'
                + 'white-space:nowrap;display:none;z-index:100;';
            canvas.parentElement.style.position = 'relative';
            canvas.parentElement.appendChild(tooltip);
        }
        if (!hoverActive) {
            hoverActive = true;
            canvas.addEventListener('mousemove', onMove);
            canvas.addEventListener('mouseleave', onLeave);
        }
    }

    function onMove(e) {
        const canvas = document.getElementById('performanceChart');
        const state = canvas && canvas._chartState;
        if (!state || !tooltip) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (mx < state.pad.left || mx > state.w - state.pad.right || my < state.pad.top || my > state.h - state.pad.bottom) {
            tooltip.style.display = 'none';
            return;
        }

        let closest = 0;
        let minDist = Infinity;
        for (let i = 0; i < state.dates.length; i++) {
            const d = Math.abs(state.xScale(i) - mx);
            if (d < minDist) {
                minDist = d;
                closest = i;
            }
        }

        const xVal = state.xScale(closest);
        const isSv = window.I18n && I18n.getLang() === 'sv';
        const hrLabel = isSv ? 'Högrisk' : 'High';
        const lrLabel = isSv ? 'Lågrisk' : 'Low';
        const hVal = state.highRisk[closest];
        const lVal = state.lowRisk[closest];
        tooltip.innerHTML =
            '<div>' + state.dates[closest] + '</div>'
            + '<div style="color:#dc2626">' + hrLabel + ': ' + hVal.toFixed(2) + '</div>'
            + '<div style="color:#4682B4">' + lrLabel + ': ' + lVal.toFixed(2) + '</div>';
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(xVal + 12, state.w - 130) + 'px';
        tooltip.style.top = Math.max(0, state.yScale(Math.max(hVal, lVal)) - 8) + 'px';
    }

    function onLeave() {
        if (tooltip) tooltip.style.display = 'none';
    }

    window.setupPerformanceChartHover = initTooltip;
})();

// Format date for display
function formatDate(dateString) {
    const date = new Date(dateString);
    const locale = window.I18n && I18n.getLang() === 'sv' ? 'sv-SE' : 'en-US';
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}




// Check if date is a US bank holiday (major holidays affecting commodity markets)




// Load and display related stocks
async function loadRelatedStocks() {
    try {
        // Try loading multiplatform data first with cache busting
        const cacheBuster = new Date().getTime();
        let response = await fetch(`commodity_instruments_multiplatform.json?v=${cacheBuster}`);
        if (!response.ok) {
            // Fallback to old format
            response = await fetch('commodity_stocks_output.json');
        }
        
        const data = await response.json();
        
        relatedStocksData = data.commodities; // Cache the data
        hideSkeletons();
        displayRelatedStocks(relatedStocksData);
        
        if (data.metadata && data.metadata.analysis_date) {
            console.log('Data updated:', data.metadata.analysis_date);
        }
    } catch (error) {
        console.error('Error loading related stocks:', error);
        hideSkeletons();
        const containers = ['stocksContainer', 'etfsContainer', 'trackersContainer'];
        containers.forEach(id => {
            const container = document.getElementById(id);
            if (container) {
                container.innerHTML = `<p class="no-stock">${t('dataNotAvailable')}</p>`;
            }
        });
    }
}

function displayRelatedStocks(commodities) {
    const container = document.getElementById('unifiedInstrumentsContainer');
    if (!container) return;
    container.innerHTML = '';

    // ── Broker cell renderer ──
    const BROKER_LABELS = { A: 'Avanza', N: 'Nordnet', M: 'Montrose' };
    function renderBrokerCell(brokers) {
        if (!brokers || brokers.length === 0) return '<span class="inst-none">—</span>';
        return brokers.map(b => {
            const cls = b === 'A' ? 'brk-avanza' : b === 'N' ? 'brk-nordnet' : 'brk-montrose';
            return `<span class="brk-pill ${cls}" title="${BROKER_LABELS[b] || b}">${b}</span>`;
        }).join(' ');
    }

    const table = document.createElement('table');
    table.className = 'unified-related-table';

    // ── Header ──
    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>${t('thCommodity')}</th>
            <th title="${t('thInstrumentsTitle')}">${t('thInstruments')}</th>
            <th>${t('thType')}</th>
            <th title="${t('thBrokerTitle')}">${t('thBroker')}</th>
            <th title="${t('thCorrTitle')}"><span class="greek-symbol">ρ</span></th>
            <th title="${t('thBetaTitle')}"><span class="greek-symbol">β</span></th>
            <th title="${t('thR2Title')}">${t('thR2')}</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // ── Category config ──
    const categories = [
        { key: 'stocks',   title: t('stocksTitle'),   desc: t('stocksDesc'),   icon: '', cssClass: 'cat-stocks',   typeLabel: 'STK' },
        { key: 'etfs',     title: t('etfsTitle'),      desc: t('etfsDesc'),      icon: '', cssClass: 'cat-etfs',    typeLabel: 'ETF' },
        { key: 'trackers', title: t('trackersTitle'),  desc: t('trackersDesc'),  icon: '', cssClass: 'cat-trackers', typeLabel: 'ETC' },
    ];

    const globalTickerData = {};

    categories.forEach((cat) => {
        // ── Collect instruments for each commodity in this category ──
        const rows = [];

        commodities.forEach(commodityData => {
            if (!commodityData[cat.key]) return;

            const commodity = commodityData.name;

            // Gather all instruments from all platforms
            const allInstruments = [];
            let hasRegionalPicks = false;
            if (cat.key === 'stocks') {
                // Try explicit regional picks first
                const regionOrder = ['nordic', 'european', 'world'];
                regionOrder.forEach(region => {
                    const pick = commodityData.regional?.[region];
                    if (pick) {
                        allInstruments.push({ ...pick, region });
                        hasRegionalPicks = true;
                    }
                });
                // Also include negatively correlated picks ("negatives")
                const reg = commodityData.regional;
                if (reg && Array.isArray(reg["negatives"])) {
                    reg["negatives"].forEach(pick => {
                        allInstruments.push({ ...pick, region: "negatives" });
                        hasRegionalPicks = true;
                    });
                }
            }
            if (!hasRegionalPicks) {
                // Fall back to platform-based lookup
                const platforms = ['avanza', 'nordnet', 'montrose'];
                platforms.forEach(platform => {
                    if (commodityData[cat.key] && commodityData[cat.key][platform]) {
                        commodityData[cat.key][platform].forEach(inst => {
                            allInstruments.push({ ...inst, platform });
                        });
                    }
                });
            }

            // For ETCs/Trackers, always show a row even without data
            const noData = allInstruments.length === 0;
            if (noData && cat.key === 'stocks') return;

            // Best instrument = highest absolute correlation
            const best = noData ? null : allInstruments.reduce((a, b) =>
                Math.abs(a.correlation) > Math.abs(b.correlation) ? a : b
            );

            // Regional picks for stocks (up to 3, sorted by |correlation| desc)
            let regionalPicks = [];
            if (cat.key === 'stocks' && !noData) {
                const regionOrder = ['nordic', 'european', 'world'];
                regionOrder.forEach(region => {
                    const pick = commodityData.regional?.[region];
                    if (pick) regionalPicks.push({ ...pick, region });
                });
                const reg2 = commodityData.regional;
                if (reg2 && Array.isArray(reg2["negatives"])) {
                    reg2["negatives"].forEach(pick => {
                        regionalPicks.push({ ...pick, region: "negatives" });
                    });
                }
                regionalPicks.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
                // If no explicit regional picks, infer region from ticker suffix
                if (regionalPicks.length === 0) {
                    const platforms = ['avanza', 'nordnet', 'montrose'];
                    const all = [];
                    platforms.forEach(p => {
                        if (commodityData.stocks?.[p]) {
                            commodityData.stocks[p].forEach(inst => all.push(inst));
                        }
                    });
                    all.forEach(inst => {
                        let region = 'world';
                        if (inst.ticker.includes('.ST') || inst.ticker.includes('.OL') ||
                            inst.ticker.includes('.HE') || inst.ticker.includes('.CO')) {
                            region = 'nordic';
                        } else if (inst.ticker.includes('.L') || inst.ticker.includes('.DE') ||
                                   inst.ticker.includes('.PA') || inst.ticker.includes('.AS')) {
                            region = 'european';
                        }
                        regionalPicks.push({ ...inst, region });
                    });
                    regionalPicks.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
                }
            }

            // Store globally for click selection
            const instKey = `${commodity}-${cat.key}`;
            if (!noData) {
                globalTickerData[instKey] = { allInstruments, best };
            }

            rows.push({ commodity, allInstruments, best, regionalPicks, instKey, noData });
        });

        if (rows.length === 0) return;

        // ── Category separator row ──
        const sepRow = document.createElement('tr');
        sepRow.className = 'cat-separator';
        const sepColspan = 7;
        sepRow.innerHTML = `
            <td colspan="${sepColspan}">
                <div class="cat-sep-inner ${cat.cssClass}" title="${cat.desc}">
                    ${cat.icon ? `<span class="cat-sep-icon">${cat.icon}</span>` : ''}
                    <span class="cat-sep-title">${cat.title}</span>
                    <span class="cat-sep-count">${t('countCommodities', { n: rows.length })}</span>
                </div>
            </td>
        `;
        tbody.appendChild(sepRow);

        // ── Data rows ──
        rows.forEach(({ commodity, allInstruments, best, regionalPicks, instKey, noData }) => {
            const row = document.createElement('tr');
            row.className = 'data-row' + (noData ? ' row-no-data' : '');
            row.dataset.commodity = commodity;
            row.dataset.category = cat.key;
            if (noData) {
                const missingKey = cat.key === 'etfs' ? 'noEtfDataTooltip' : 'noTrackerDataTooltip';
                row.title = t(missingKey);
            }

            // Commodity name
            const commCell = document.createElement('td');
            commCell.innerHTML = `<span class="comm-name">${tCommodity(commodity)}</span>`;
            row.appendChild(commCell);

            // Instruments cell
            const instCell = document.createElement('td');
            if (cat.key === 'stocks' && regionalPicks.length > 0) {
                // Show up to 3 regional picks in a compact row
                const wrapper = document.createElement('div');
                wrapper.className = 'inst-cell';
                regionalPicks.forEach((pick, i) => {
                    if (i > 0) {
                        const sep = document.createElement('span');
                        sep.className = 'inst-sep';
                        sep.textContent = '·';
                        wrapper.appendChild(sep);
                    }
                    const pickEl = document.createElement('span');
                    const isBest = pick.ticker === best.ticker;
                    pickEl.className = `inst-pick ${isBest ? 'selected' : ''}`;
                    pickEl.dataset.ticker = pick.ticker;
                    pickEl.dataset.instKey = instKey;
                    pickEl.dataset.region = pick.region || '';
                    pickEl.innerHTML = `
                        <span class="inst-ticker">${pick.ticker}</span>
                    `;
                    pickEl.title = `${pick.name} · ρ: ${pick.correlation >= 0 ? '+' : ''}${pick.correlation.toFixed(3)} · β: ${pick.beta.toFixed(3)}`;
                    wrapper.appendChild(pickEl);
                });
                instCell.appendChild(wrapper);
            } else if (best) {
                const wrapper = document.createElement('div');
                wrapper.className = 'inst-cell';
                const pickEl = document.createElement('span');
                pickEl.className = 'inst-pick selected';
                pickEl.dataset.ticker = best.ticker;
                pickEl.dataset.instKey = instKey;
                pickEl.title = best.name;
                pickEl.innerHTML = `
                    <span class="inst-ticker">${best.ticker}</span>
                    <span class="inst-name">${best.name || ''}</span>
                `;
                wrapper.appendChild(pickEl);
                instCell.appendChild(wrapper);
            } else {
                instCell.innerHTML = '<span class="inst-none">—</span>';
            }
            row.appendChild(instCell);

            // Type badge
            const typeCell = document.createElement('td');
            if (best) {
                if (cat.key === 'stocks') {
                    const regionLabels =                 { nordic: t('thNordic'), european: t('thEuropean'), world: t('thWorld') };
                    const region = best.region || (best.ticker.includes('.ST') ? 'nordic' : 'world');
                    typeCell.innerHTML = `<span class="type-badge stk">${regionLabels[region] || region}</span>`;
                } else if (cat.key === 'etfs') {
                    typeCell.innerHTML = `<span class="type-badge etf">ETF</span>`;
                } else {
                    typeCell.innerHTML = `<span class="type-badge etc">ETC</span>`;
                }
            } else {
                typeCell.innerHTML = '<span class="inst-none">—</span>';
            }
            row.appendChild(typeCell);

            // Broker
            const brokerCell = document.createElement('td');
            brokerCell.className = 'broker-cell';
            brokerCell.innerHTML = renderBrokerCell(best?.brokers || []);
            row.appendChild(brokerCell);

            // ρ (correlation)
            const corrCell = document.createElement('td');
            if (best) {
                const cls = best.correlation >= 0 ? 'pos' : 'neg';
                const sign = best.correlation >= 0 ? '+' : '';
                corrCell.innerHTML = `<span class="metric-val ${cls}">${sign}${best.correlation.toFixed(3)}</span>`;
            } else {
                corrCell.innerHTML = '<span class="metric-val">—</span>';
            }
            row.appendChild(corrCell);

            // β (beta)
            const betaCell = document.createElement('td');
            if (best) {
                betaCell.innerHTML = `<span class="metric-val">${best.beta.toFixed(3)}</span>`;
            } else {
                betaCell.innerHTML = '<span class="metric-val">—</span>';
            }
            row.appendChild(betaCell);

            // R²
            const r2Cell = document.createElement('td');
            if (best) {
                r2Cell.innerHTML = `<span class="metric-val">${(best.r_squared * 100).toFixed(1)}%</span>`;
            } else {
                r2Cell.innerHTML = '<span class="metric-val">—</span>';
            }
            row.appendChild(r2Cell);

            tbody.appendChild(row);
        });
    });

    // ── Click handler for instrument selection ──
    tbody.addEventListener('click', (e) => {
        const pickEl = e.target.closest('.inst-pick');
        const ticker = pickEl?.dataset?.ticker;
        const instKey = pickEl?.dataset?.instKey;
        if (!ticker || !instKey) return;

        const data = globalTickerData[instKey];
        if (!data) return;

        const instrumentData = data.allInstruments.find(inst => inst.ticker === ticker);
        if (!instrumentData) return;

        // Find the row
        const row = e.target.closest('tr.data-row');
        if (!row) return;

        // Update selected state in this row's instruments
        row.querySelectorAll('.inst-pick').forEach(el => el.classList.remove('selected'));
        if (pickEl) pickEl.classList.add('selected');

        // Update metric cells in this row (column order: Commodity, Instruments, Type, Broker, ρ, β, R²)
        const cls = instrumentData.correlation >= 0 ? 'pos' : 'neg';
        const sign = instrumentData.correlation >= 0 ? '+' : '';
        row.cells[4].innerHTML = `<span class="metric-val ${cls}">${sign}${instrumentData.correlation.toFixed(3)}</span>`;
        row.cells[5].innerHTML = `<span class="metric-val">${instrumentData.beta.toFixed(3)}</span>`;
        row.cells[6].innerHTML = `<span class="metric-val">${(instrumentData.r_squared * 100).toFixed(1)}%</span>`;

        // Update Broker cell
        const brokerCell = row.cells[3];
        if (brokerCell && brokerCell.classList.contains('broker-cell')) {
            brokerCell.innerHTML = renderBrokerCell(instrumentData.brokers || []);
        }

        // Update Type badge for stocks when a different regional pick is clicked
        if (pickEl && pickEl.dataset.region) {
            const regionLabels =                 { nordic: t('thNordic'), european: t('thEuropean'), world: t('thWorld') };
            const region = pickEl.dataset.region;
            row.cells[2].innerHTML = `<span class="type-badge stk">${regionLabels[region] || region}</span>`;
        }
    });

    table.appendChild(tbody);
    container.appendChild(table);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', init);

// Load portfolio model performance
async function loadModelPerformance() {
    const container = document.getElementById('modelPerformance');
    if (!container) return;

    try {
        const [metricsResp, commResp, eqResp] = await Promise.all([
            fetch('portfolio_metrics.json?v=' + Date.now()),
            fetch('commodity_metrics.json?v=' + Date.now()),
            fetch('equity_curves.json?v=' + Date.now()),
        ]);

        if (!metricsResp.ok) {
            hideSkeletons();
            container.innerHTML = `<p class="no-stock">${t('modelNotAvailable')}</p>`;
            return;
        }

        const metricsData = await metricsResp.json();
        metricsDataGlobal = metricsData;
        annReturnHigh = metricsData.metrics ? (metricsData.metrics.annualized_return || 0) : 0;
        annReturnLow = metricsData.metrics_symmetric ? (metricsData.metrics_symmetric.annualized_return || 0) : 0;
        const commData = commResp.ok ? await commResp.json() : null;
        if (eqResp.ok) {
            equityCurveData = await eqResp.json();
        } else {
            equityCurveData = null;
        }

        const signalDate = new Date(metricsData.date);
        const today = new Date();
        const daysDiff = Math.floor((today - signalDate) / (1000 * 60 * 60 * 24));
        if (daysDiff > 30) {
            container.innerHTML = `<p class="no-stock">${t('modelStale')}</p>`;
            return;
        }

        function fmtPct(v) { return v != null ? (v * 100).toFixed(2) + '%' : '—'; }
        function fmtNum(v) { return v != null ? v.toFixed(2) : '—'; }
        function riskClass(v) { return v >= 0 ? 'positive' : 'negative'; }

        const isSv = window.I18n && I18n.getLang() === 'sv';
        const highRiskLabel = isSv ? 'Högriskmodell' : 'High risk model';
        const lowRiskLabel = isSv ? 'Lågriskmodell' : 'Low risk model';
        const sharpeHint = isSv
            ? 'Sharpe-kvot: riskjusterad avkastning. Högre är bättre, >1 är bra, >2 är utmärkt'
            : 'Sharpe ratio: risk-adjusted return. Higher is better, >1 is good, >2 is excellent';

        let html = '';

        const m1 = metricsData.metrics;
        const m2 = metricsData.metrics_symmetric;
        if (m1 && m2) {
            const rows = [
                [t('metricCumRet'), fmtPct(m1.cumulative_return), fmtPct(m2.cumulative_return), riskClass(m1.cumulative_return), riskClass(m2.cumulative_return)],
                [t('metricAnnRet'), fmtPct(m1.annualized_return), fmtPct(m2.annualized_return), riskClass(m1.annualized_return), riskClass(m2.annualized_return)],
                [t('metricTestPeriod'), (metricsData.window_days / 252).toFixed(2) + ' ' + t('years'), (metricsData.window_days / 252).toFixed(2) + ' ' + t('years'), '', ''],
                [t('metricSharpe'), fmtNum(m1.sharpe_ratio), fmtNum(m2.sharpe_ratio), riskClass(m1.sharpe_ratio), riskClass(m2.sharpe_ratio)],
                [t('metricMaxDD'),
                    fmtPct(m1.max_drawdown), fmtPct(m2.max_drawdown), riskClass(m1.max_drawdown), riskClass(m2.max_drawdown)],
                [t('metricWinRate'), fmtPct(m1.win_rate), fmtPct(m2.win_rate), '', ''],
                [t('metricProfitFactor'),
                    fmtNum(m1.profit_factor), fmtNum(m2.profit_factor), riskClass(m1.profit_factor - 1), riskClass(m2.profit_factor - 1)],
                [t('metricAvgTrades'),
                    metricsData.avg_trades_per_year != null ? metricsData.avg_trades_per_year.toFixed(1) : '—',
                    metricsData.avg_trades_per_year_sym != null ? metricsData.avg_trades_per_year_sym.toFixed(1) : '—',
                    '', ''],
                [t('metricAvgHold'),
                    metricsData.avg_hold_days != null ? metricsData.avg_hold_days.toFixed(1) : '—',
                    metricsData.avg_hold_days_sym != null ? metricsData.avg_hold_days_sym.toFixed(1) : '—',
                    '', ''],
                [t('metricStdHold'),
                    metricsData.std_hold_days != null ? metricsData.std_hold_days.toFixed(1) : '—',
                    metricsData.std_hold_days_sym != null ? metricsData.std_hold_days_sym.toFixed(1) : '—',
                    '', ''],
            ];
            html += `<div class="model-perf-block">`;
            html += `<table class="model-perf-table" style="width:100%">`;
            html += `<thead><tr><th style="text-align:left;width:55%">${t('metricColumn')}</th><th style="text-align:right;width:22.5%">${highRiskLabel}</th><th style="text-align:right;width:22.5%">${lowRiskLabel}</th></tr></thead><tbody>`;
            rows.forEach(r => {
                html += `<tr><td>${r[0]}</td><td class="${r[3]}" style="text-align:right">${r[1]}</td><td class="${r[4]}" style="text-align:right">${r[2]}</td></tr>`;
            });
            html += `</tbody></table></div>`;
        }

        // ── Per-commodity table with tabs ──
        if (commData && commData.commodities && commData.commodities.length > 0) {
            const riskTabPanelHigh = 'riskPanelHigh';
            const riskTabPanelLow = 'riskPanelLow';

            html += `<h4 style="margin:0.75rem 0 0.4rem;color:var(--text-primary);font-size:0.95rem">${t('perCommoditySummary')}</h4>`;

            // High risk table
            html += `<div id="${riskTabPanelHigh}" class="risk-panel">`;
            html += `<div class="comm-perf-table-wrap"><table class="comm-perf-table">
                <thead><tr><th>${t('thCommodity')}</th><th>${t('thCumRet')}</th><th>${t('thAnnRet')}</th><th title="${sharpeHint}">${t('thSharpe')}</th><th title="${t('thMaxDDTitle')}">${t('thMaxDD')}</th><th title="${t('thTradesTitle')}">${t('thTrades')}</th><th title="${t('thAvgHoldTitle')}">${t('thAvgHold')}</th><th title="${t('thStdHoldTitle')}">${t('thStdHold')}</th></tr></thead><tbody>`;
            commData.commodities.forEach(c => {
                const sv = c.semi_vol || {};
                html += `<tr>
                    <td class="comm-name">${tCommodity(c.label)}</td>
                    <td class="${riskClass(sv.cum_ret)}">${fmtPct(sv.cum_ret)}</td>
                    <td class="${riskClass(sv.ann_ret)}">${fmtPct(sv.ann_ret)}</td>
                    <td class="${riskClass(sv.sharpe)}">${fmtNum(sv.sharpe)}</td>
                    <td class="${riskClass(sv.max_dd)}">${fmtPct(sv.max_dd)}</td>
                    <td>${c.trades != null ? c.trades : '—'}</td>
                    <td>${c.avg_hold != null ? c.avg_hold : '—'}</td>
                    <td>${c.std_hold != null ? c.std_hold : '—'}</td>
                </tr>`;
            });
            html += `</tbody></table></div></div>`;

            // Low risk table
            html += `<div id="${riskTabPanelLow}" class="risk-panel" style="display:none">`;
            html += `<div class="comm-perf-table-wrap"><table class="comm-perf-table">
                <thead><tr><th>${t('thCommodity')}</th><th>${t('thCumRet')}</th><th>${t('thAnnRet')}</th><th title="${sharpeHint}">${t('thSharpe')}</th><th title="${t('thMaxDDTitle')}">${t('thMaxDD')}</th><th title="${t('thTradesTitle')}">${t('thTrades')}</th><th title="${t('thAvgHoldTitle')}">${t('thAvgHold')}</th><th title="${t('thStdHoldTitle')}">${t('thStdHold')}</th></tr></thead><tbody>`;
            commData.commodities.forEach(c => {
                const sym = c.symmetric_vol || {};
                html += `<tr>
                    <td class="comm-name">${tCommodity(c.label)}</td>
                    <td class="${riskClass(sym.cum_ret)}">${fmtPct(sym.cum_ret)}</td>
                    <td class="${riskClass(sym.ann_ret)}">${fmtPct(sym.ann_ret)}</td>
                    <td class="${riskClass(sym.sharpe)}">${fmtNum(sym.sharpe)}</td>
                    <td class="${riskClass(sym.max_dd)}">${fmtPct(sym.max_dd)}</td>
                    <td>${c.trades_sym != null ? c.trades_sym : (c.trades != null ? c.trades : '—')}</td>
                    <td>${c.avg_hold_sym != null ? c.avg_hold_sym : (c.avg_hold != null ? c.avg_hold : '—')}</td>
                    <td>${c.std_hold_sym != null ? c.std_hold_sym : (c.std_hold != null ? c.std_hold : '—')}</td>
                </tr>`;
            });
            html += `</tbody></table></div></div>`;
        }

        hideSkeletons();
        container.innerHTML = html;

        bestAnnualizedReturn = Math.max(annReturnHigh, annReturnLow);
        const testPerfCardEl = document.getElementById('testPortfolioCard');
        if (testPerfCardEl) {
            const valueDiv = testPerfCardEl.querySelector('.stat-value');
            if (valueDiv) {
                const r = currentRiskModel === 'high' ? annReturnHigh : annReturnLow;
                valueDiv.textContent = `${r >= 0 ? '+' : ''}${(r * 100).toFixed(2)}%`;
                valueDiv.className = `stat-value ${r >= 0 ? 'success' : 'danger'}`;
            }
        }
        const livePerfCardEl = document.getElementById('livePortfolioCard');
        if (livePerfCardEl) {
            const valueDiv = livePerfCardEl.querySelector('.stat-value');
            if (valueDiv) {
                const result = computeLiveAnnualizedReturn('2026-06-09');
                valueDiv.textContent = result.formatted;
                valueDiv.className = `stat-value ${result.cssClass}`;
            }
        }
        const curveKey = currentRiskModel === 'high' ? 'high_risk' : 'low_risk';
        const liveEqCardEl = document.getElementById('liveEqCard');
        if (liveEqCardEl) {
            const valueDiv = liveEqCardEl.querySelector('.stat-value');
            if (valueDiv) {
                const result = computeEquitySinceLive('2026-06-09', curveKey);
                valueDiv.textContent = result.formatted;
                valueDiv.className = `stat-value ${result.cssClass}`;
            }
        }
        const trainEqCardEl = document.getElementById('trainEqCard');
        if (trainEqCardEl) {
            const valueDiv = trainEqCardEl.querySelector('.stat-value');
            if (valueDiv) {
                const result = computeEquitySinceStart(curveKey);
                valueDiv.textContent = result.formatted;
                valueDiv.className = `stat-value ${result.cssClass}`;
            }
        }

        drawPerformanceChart();

    } catch (err) {
        console.error('Error loading model performance:', err);
        hideSkeletons();
        container.innerHTML = `<p class="no-stock">${t('modelNotAvailable')}</p>`;
    }
}

function switchRiskModel(model) {
    currentRiskModel = model;
    document.querySelectorAll('.risk-tab').forEach(btn => {
        btn.classList.toggle('risk-tab-active', btn.dataset.model === model);
    });
    document.querySelectorAll('.risk-panel').forEach(p => {
        p.style.display = 'none';
    });
    const panel = document.getElementById(model === 'high' ? 'riskPanelHigh' : 'riskPanelLow');
    if (panel) panel.style.display = '';
    renderSignalDots();
    renderAllocation();
    renderPerformanceStats();
    renderHistoryTable();
    drawPerformanceChart();
}

function switchRiskTab(tab) {
    switchRiskModel(tab);
}

function setupRiskModelBar() {
    const bar = document.getElementById('riskModelBar');
    if (!bar) return;

    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
    if (activeTab !== 'portfolio' && activeTab !== 'history') {
        bar.innerHTML = '';
        return;
    }

    const isSv = window.I18n && I18n.getLang() === 'sv';
    const highLabel = isSv ? 'Högriskmodell' : 'High risk model';
    const lowLabel = isSv ? 'Lågriskmodell' : 'Low risk model';
    bar.innerHTML = `
        <button class="risk-tab risk-tab-active" data-model="high" onclick="switchRiskModel('high')">${highLabel}</button>
        <button class="risk-tab" data-model="low" onclick="switchRiskModel('low')">${lowLabel}</button>
    `;
}