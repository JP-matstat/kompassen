import React, { useState, useEffect, useRef, useMemo, useCallback } from 'https://esm.sh/react@18.2.0';
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client';
import { format, parseISO, differenceInDays } from 'https://esm.sh/date-fns@3.3.1';

// ===================================================================
// Helpers
// ===================================================================

const nf = new Intl.NumberFormat('sv-SE', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const nf0 = new Intl.NumberFormat('sv-SE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const pct = (v) =>
  v == null ? '—' : nf.format(v * 100) + '%';
const two = (v) =>
  v == null ? '—' : nf0.format(v);

function getLabel(labels, searchDate) {
  if (!labels || !searchDate) return null;
  const d = typeof searchDate === 'string' ? searchDate : format(searchDate, 'yyyy-MM-dd');
  for (const row of labels) {
    if (row.dates && Array.isArray(row.dates)) {
      if (row.dates.includes(d)) return row.name;
    }
    if (row.date === d) return row.name;
  }
  return null;
}

function getLabelAfterDate(labels, afterDate) {
  if (!labels || !afterDate) return null;
  const d = typeof afterDate === 'string' ? afterDate : format(afterDate, 'yyyy-MM-dd');
  let best = null;
  let bestDate = null;
  for (const row of labels) {
    if (row.dates && Array.isArray(row.dates)) {
      for (const dd of row.dates) {
        if (dd > d && (!bestDate || dd < bestDate)) {
          bestDate = dd;
          best = row.name;
        }
      }
    } else if (row.date) {
      if (row.date > d && (!bestDate || row.date < bestDate)) {
        bestDate = row.date;
        best = row.name;
      }
    }
  }
  return { name: best, date: bestDate };
}

function getLabelAtDate(labels, searchDate) {
  if (!labels || !searchDate) return null;
  const d = typeof searchDate === 'string' ? searchDate : format(searchDate, 'yyyy-MM-dd');
  for (const row of labels) {
    if (row.dates && Array.isArray(row.dates)) {
      if (row.dates.includes(d)) return row.name;
    }
    if (row.date === d) return row.name;
  }
  return null;
}

function fmt(v) {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (Math.abs(v) >= 100) return nf0.format(v);
    if (Math.abs(v) >= 1) return nf.format(v);
    return v.toFixed(1);
  }
  return String(v);
}

function deltaClass(v) {
  if (v == null) return '';
  return v > 0 ? 'positive' : v < 0 ? 'negative' : '';
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  return differenceInDays(new Date(), parseISO(dateStr));
}

// 63-day offset for friendly week labelling
function offsetDateStr(dateStr, offset = 0) {
  if (!dateStr) return '';
  return format(parseISO(dateStr), 'yyyy-MM-dd');
}

// ===================================================================
// Label colour
// ===================================================================

const LABEL_COLORS = {
  grön: '#4caf50',
  orange: '#ff9800',
  röd: '#f44336',
  vit: '#ffffff',
  default: '#9e9e9e',
};
function labelColor(name) {
  if (!name) return LABEL_COLORS.default;
  const key = name.toLowerCase();
  return LABEL_COLORS[key] || LABEL_COLORS.default;
}

// ===================================================================
// Constants
// ===================================================================

const STAT_CARDS = [
  { key: 'sharpe', labelKey: 'sharpe' },
  { key: 'return', labelKey: 'return' },
  { key: 'vol', labelKey: 'vol' },
  { key: 'max_dd', labelKey: 'maxDd' },
  { key: 'win_rate', labelKey: 'winRate' },
  { key: 'profit_factor', labelKey: 'profitFactor' },
];
const SYM_STAT_CARDS = [
  { key: 'sharpe_sym', labelKey: 'sharpe' },
  { key: 'return_sym', labelKey: 'return' },
  { key: 'vol_sym', labelKey: 'vol' },
  { key: 'max_dd_sym', labelKey: 'maxDd' },
  { key: 'win_rate_sym', labelKey: 'winRate' },
  { key: 'profit_factor_sym', labelKey: 'profitFactor' },
];

// ===================================================================
// i18n
// ===================================================================

const DEFAULT_LOCALE = 'en';
let i18n = { en: {}, sv: {} };

export function setI18n(data) {
  i18n = data;
}

function t(key) {
  const locale = localStorage.getItem('locale') || DEFAULT_LOCALE;
  return i18n?.[locale]?.[key] || i18n?.[DEFAULT_LOCALE]?.[key] || key;
}

// ===================================================================
// Sub-components
// ===================================================================

function Card({ title, children, className = '' }) {
  return (
    <div className={`card ${className}`}>
      <div className="card-title">{title}</div>
      {children}
    </div>
  );
}

function StatCard({ title, value, cls = '' }) {
  return (
    <div className={`stat-card ${cls}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{title}</div>
    </div>
  );
}

function MiniTable({ rows, sym }) {
  // rows: [{ label, value, cls }]
  const borderColor = sym ? 'var(--sym-border)' : 'var(--semi-border)';
  return (
    <div className="mini-table" style={{ borderColor }}>
      {rows.map((r, i) => (
        <div key={i} className="mini-row">
          <span className="mini-label">{r.label}</span>
          <span className={`mini-value ${r.cls || ''}`}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function ExtendedRow({ rows }) {
  return (
    <div className="extended-row">
      {rows.map((r, i) => (
        <div key={i} className="extended-cell">
          <span className="extended-value">{r.value}</span>
          <span className="extended-label">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

// ===================================================================
// S-Strategy list (deterministic top-K)
// ===================================================================

function SStrategyList({ sData, title, commodityKey, topK = 15 }) {
  if (!sData || Object.keys(sData).length === 0) return null;

  const entries = Object.entries(sData)
    .filter(([, v]) => v != null && typeof v === 'number')
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  if (entries.length === 0) return null;

  return (
    <Card title={`${title} (${commodityKey})`}>
      <div className="s-strategy-list">
        {entries.map(([k, v]) => (
          <div key={k} className="s-strategy-row">
            <span className="s-strategy-name">{k}</span>
            <span className={`s-strategy-value ${deltaClass(v)}`}>{pct(v)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ===================================================================
// Commodity dashboard component
// ===================================================================
function CommodityDashboard({
  data,
  labelData,
  labelDefs,
  todayStr,
}) {
  // ── label state ─────────────────────────────────────────────
  const labelNow = useMemo(
    () => getLabel(labelDefs, todayStr),
    [labelDefs, todayStr],
  );
  const nextLabel = useMemo(
    () => getLabelAfterDate(labelDefs, todayStr),
    [labelDefs, todayStr],
  );
  const [hoverLabel, setHoverLabel] = useState(null);
  const displayLabel = hoverLabel || labelNow;

  const labelDate = useMemo(() => {
    if (!labelDefs || !todayStr) return null;
    const d = typeof todayStr === 'string' ? todayStr : format(todayStr, 'yyyy-MM-dd');
    for (const row of labelDefs) {
      if (row.dates && Array.isArray(row.dates)) {
        if (row.dates.includes(d)) return d;
      }
      if (row.date === d) return row.date;
    }
    return null;
  }, [labelDefs, todayStr]);

  const labelColorMap = useMemo(() => {
    const m = {};
    if (!labelDefs) return m;
    for (const row of labelDefs) {
      if (row.dates && Array.isArray(row.dates)) {
        for (const d of row.dates) {
          m[d] = row.name;
        }
      } else if (row.date) {
        m[row.date] = row.name;
      }
    }
    return m;
  }, [labelDefs]);

  // Label history: last 10 label changes
  const labelHistory = useMemo(() => {
    if (!labelDefs || !labelColorMap || !todayStr) return [];
    const sortedDates = Object.keys(labelColorMap)
      .filter((d) => d <= todayStr)
      .sort()
      .reverse()
      .slice(0, 10);
    return sortedDates.map((d) => ({
      date: d,
      name: labelColorMap[d],
    }));
  }, [labelDefs, labelColorMap, todayStr]);

  // ── metrics ────────────────────────────────────────────────
  const { metrics, metrics_sym, signal_count } = data || {};
  const daysSinceLive = data?.days_since_live ?? daysSince(data?.live_date);

  // ── stat-card renderers ────────────────────────────────────
  const renderStatCards = useCallback((m, cardDefs) => {
    if (!m) return null;
    return (
      <div className="stat-row">
        {cardDefs.map(({ key, labelKey }) => (
          <StatCard
            key={key}
            title={t(labelKey)}
            value={
              key === 'win_rate' || key === 'win_rate_sym'
                ? pct(m[key])
                : key === 'profit_factor' || key === 'profit_factor_sym'
                  ? fmt(m[key])
                  : pct(m[key])
            }
            cls={deltaClass(m[key])}
          />
        ))}
      </div>
    );
  }, []);

  // ── signal direction rows (return_by_direction) ────────────
  const directionRows = useMemo(() => {
    if (!metrics?.return_by_direction) return null;
    const d = metrics.return_by_direction;
    return [
      { label: t('long'), value: pct(d.long), cls: deltaClass(d.long) },
      { label: t('short'), value: pct(d.short), cls: deltaClass(d.short) },
      { label: t('neutral'), value: pct(d.neutral), cls: deltaClass(d.neutral) },
    ];
  }, [metrics]);

  const directionRowsSym = useMemo(() => {
    if (!metrics_sym?.return_by_direction) return null;
    const d = metrics_sym.return_by_direction;
    return [
      { label: t('long'), value: pct(d.long), cls: deltaClass(d.long) },
      { label: t('short'), value: pct(d.short), cls: deltaClass(d.short) },
      { label: t('neutral'), value: pct(d.neutral), cls: deltaClass(d.neutral) },
    ];
  }, [metrics_sym]);

  // ── daily breakdown (last 10) ──────────────────────────────
  const dailyRows = useMemo(() => {
    if (!data?.all_commodity_series) return null;
    const series = data.all_commodity_series;
    if (series.length === 0) return null;
    const last10 = series
      .filter((d) => d.date <= todayStr)
      .sort((a, b) => (a.date > b.date ? -1 : 1))
      .slice(0, 10);
    return last10.map((d) => {
      const lab = getLabelAtDate(labelDefs, d.date);
      const icon = d.pred_today === 1 ? '▲' : d.pred_today === -1 ? '▼' : '●';
      const predVal = d.pred_today === 1 ? 0.05 : d.pred_today === -1 ? -0.05 : 0;
      return (
        <div key={d.date} className="daily-row">
          <span className="daily-date">{d.date}</span>
          <span className="daily-icon">{icon}</span>
          <span className="daily-label" style={{ color: lab ? labelColor(lab) : undefined }}>
            {lab || '—'}
          </span>
        </div>
      );
    });
  }, [data, todayStr, labelDefs]);

  // ── commodities mini-table ─────────────────────────────────
  const commodityRows = useMemo(() => {
    if (!data?.per_commodity_metrics) return null;
    return Object.entries(data.per_commodity_metrics)
      .filter(([, v]) => v != null)
      .map(([k, v]) => ({
        label: k,
        value: pct(v.return),
        cls: deltaClass(v.return),
      }));
  }, [data]);

  const commodityRowsSym = useMemo(() => {
    if (!data?.per_commodity_metrics) return null;
    return Object.entries(data.per_commodity_metrics)
      .filter(([, v]) => v != null)
      .map(([k, v]) => ({
        label: k,
        value: pct(v.return_sym),
        cls: deltaClass(v.return_sym),
      }));
  }, [data]);

  // ── extended stats ─────────────────────────────────────────
  const extendedStats = useMemo(() => {
    if (!metrics) return null;
    return [
      { label: t('signalCount'), value: fmt(signal_count) },
      { label: t('avgReturn'), value: pct(metrics.avg_return) },
      { label: t('avgAbsReturn'), value: pct(metrics.avg_abs_return) },
      { label: t('bestDay'), value: pct(metrics.best_day) },
      { label: t('worstDay'), value: pct(metrics.worst_day) },
      { label: t('posDays'), value: metrics.positive_days + '/' + (metrics.positive_days + metrics.negative_days) },
      { label: t('avgWin'), value: pct(metrics.avg_win) },
      { label: t('avgLoss'), value: pct(metrics.avg_loss) },
      { label: t('avgLength'), value: two(metrics.avg_length) + 'd' },
      { label: t('avgWinLength'), value: two(metrics.avg_win_length) + 'd' },
      { label: t('avgLossLength'), value: two(metrics.avg_loss_length) + 'd' },
      { label: t('maxConsecWin'), value: two(metrics.max_consec_win) },
      { label: t('maxConsecLoss'), value: two(metrics.max_consec_loss) },
      { label: t('currentStreak'), value: two(Math.abs(metrics.current_streak)) + (metrics.current_streak > 0 ? 'W' : metrics.current_streak < 0 ? 'L' : '—') },
    ];
  }, [metrics, signal_count]);

  const extendedStatsSym = useMemo(() => {
    if (!metrics_sym) return null;
    return [
      { label: t('avgReturn'), value: pct(metrics_sym.avg_return) },
      { label: t('avgAbsReturn'), value: pct(metrics_sym.avg_abs_return) },
      { label: t('bestDay'), value: pct(metrics_sym.best_day) },
      { label: t('worstDay'), value: pct(metrics_sym.worst_day) },
      { label: t('posDays'), value: metrics_sym.positive_days + '/' + (metrics_sym.positive_days + metrics_sym.negative_days) },
      { label: t('avgWin'), value: pct(metrics_sym.avg_win) },
      { label: t('avgLoss'), value: pct(metrics_sym.avg_loss) },
      { label: t('avgLength'), value: two(metrics_sym.avg_length) + 'd' },
      { label: t('avgWinLength'), value: two(metrics_sym.avg_win_length) + 'd' },
      { label: t('avgLossLength'), value: two(metrics_sym.avg_loss_length) + 'd' },
      { label: t('maxConsecWin'), value: two(metrics_sym.max_consec_win) },
      { label: t('maxConsecLoss'), value: two(metrics_sym.max_consec_loss) },
      { label: t('currentStreak'), value: two(Math.abs(metrics_sym.current_streak)) + (metrics_sym.current_streak > 0 ? 'W' : metrics_sym.current_streak < 0 ? 'L' : '—') },
    ];
  }, [metrics_sym]);

  // ── live dates for Days since Live tooltip ─────────────────
  const liveDatesWithActuals = useMemo(() => {
    if (!data?.all_commodity_series) return new Set();
    const set = new Set();
    for (const row of data.all_commodity_series) {
      if (row.pred_today === 1 || row.pred_today === -1) {
        set.add(row.date);
      }
    }
    return set;
  }, [data]);

  const liveDaysCount = useMemo(() => {
    if (!data?.all_commodity_series) return null;
    let cnt = 0;
    for (const row of data.all_commodity_series) {
      if (
        row.date <= todayStr &&
        (row.pred_today === 1 || row.pred_today === -1)
      ) {
        cnt++;
      }
    }
    return cnt;
  }, [data, todayStr]);

  // ── render ─────────────────────────────────────────────────
  return (
    <div className="dashboard-grid">
      {/* LEFT COLUMN: Semi-vol */}
      <div className="dash-col dash-col-semi">
        <h2 className="col-heading">{t('highRisk')}</h2>
        {renderStatCards(metrics, STAT_CARDS)}

        {daysSinceLive != null && (
          <StatCard
            title={t('daysSinceLive')}
            value={fmt(daysSinceLive)}
            cls=""
          />
        )}

        {liveDaysCount != null && (
          <StatCard
            title={t('liveDaysCount')}
            value={fmt(liveDaysCount)}
            cls=""
          />
        )}

        {directionRows && (
          <Card title={t('returnByDirection')}>
            <div className="mini-table">
              {directionRows.map((r, i) => (
                <div key={i} className="mini-row">
                  <span className="mini-label">{r.label}</span>
                  <span className={`mini-value ${r.cls}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {commodityRows && (
          <Card title={t('perCommodity')}>
            <div className="mini-table">
              {commodityRows.map((r, i) => (
                <div key={i} className="mini-row">
                  <span className="mini-label">{r.label}</span>
                  <span className={`mini-value ${r.cls}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {extendedStats && (
          <Card title={t('extendedStats')}>
            <div className="extended-grid">
              {extendedStats.map((r, i) => (
                <div key={i} className="extended-cell">
                  <span className="extended-value">{r.value}</span>
                  <span className="extended-label">{r.label}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* CENTRE COLUMN: Daily breakdown + S-Strategies */}
      <div className="dash-col dash-col-centre">
        {/* Daily indicator + Label history */}
        <Card title={t('dailyIndicator')}>
          <div
            className="label-badge"
            style={{ backgroundColor: labelColor(displayLabel) }}
            onMouseEnter={() => {}}
            onMouseLeave={() => {}}
          >
            {displayLabel || '—'}
            {labelDate && <span className="label-date">{labelDate}</span>}
          </div>
          <div className="label-next">
            <span className="mini-label">{t('nextLabel')}</span>
            <span
              className="mini-value"
              style={{ color: nextLabel?.name ? labelColor(nextLabel.name) : undefined }}
            >
              {nextLabel?.name || '—'}
            </span>
          </div>
          <div className="label-history">
            <div className="mini-label">{t('labelHistory')}</div>
            {labelHistory.length === 0 && <div className="mini-value" style={{ fontSize: '0.75rem' }}>{t('noLabelHistory')}</div>}
            {labelHistory.map((lh, i) => (
              <div key={i} className="label-history-row">
                <span className="mini-label" style={{ fontSize: '0.7rem' }}>{lh.date}</span>
                <span className="mini-value" style={{ color: labelColor(lh.name), fontSize: '0.7rem' }}>
                  {lh.name}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title={t('dailyBreakdown')}>
          <div className="daily-list">
            {dailyRows}
          </div>
        </Card>

        {data?.s_strategies && Object.keys(data.s_strategies).length > 0 && (
          <SStrategyList
            sData={data.s_strategies}
            title={t('topSStrategies')}
            commodityKey={data.commodity || ''}
          />
        )}
      </div>

      {/* RIGHT COLUMN: Symmetric-vol */}
      <div className="dash-col dash-col-sym">
        <h2 className="col-heading">{t('lowRisk')}</h2>
        {renderStatCards(metrics_sym, SYM_STAT_CARDS)}

        {directionRowsSym && (
          <Card title={t('returnByDirection')}>
            <div className="mini-table">
              {directionRowsSym.map((r, i) => (
                <div key={i} className="mini-row">
                  <span className="mini-label">{r.label}</span>
                  <span className={`mini-value ${r.cls}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {commodityRowsSym && (
          <Card title={t('perCommodity')}>
            <div className="mini-table">
              {commodityRowsSym.map((r, i) => (
                <div key={i} className="mini-row">
                  <span className="mini-label">{r.label}</span>
                  <span className={`mini-value ${r.cls}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {extendedStatsSym && (
          <Card title={t('extendedStats')}>
            <div className="extended-grid">
              {extendedStatsSym.map((r, i) => (
                <div key={i} className="extended-cell">
                  <span className="extended-value">{r.value}</span>
                  <span className="extended-label">{r.label}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ===================================================================
// Top-level App
// ===================================================================

function App() {
  const [data, setData] = useState(null);
  const [labelData, setLabelData] = useState(null);
  const [labelDefs, setLabelDefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const todayStr = useMemo(() => format(new Date(), 'yyyy-MM-dd'), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [dataResp, labelDefResp] = await Promise.all([
          fetch('./data.json'),
          fetch('./label_defs.json'),
        ]);
        if (!dataResp.ok) throw new Error(`data.json: ${dataResp.status}`);
        const d = await dataResp.json();
        if (cancelled) return;
        setData(d);

        try {
          const ld = await labelDefResp.json();
          if (!cancelled) setLabelDefs(ld);
        } catch {
          // label_defs.json is optional
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="loading">{t('loading')}</div>;
  if (error) return <div className="error">{t('error')}: {error}</div>;
  if (!data) return <div className="error">{t('noData')}</div>;

  return <CommodityDashboard data={data} labelDefs={labelDefs} todayStr={todayStr} />;
}

// ===================================================================
// Mount
// ===================================================================

const root = createRoot(document.getElementById('root'));
root.render(<App />);
