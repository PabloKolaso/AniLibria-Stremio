/**
 * Chart.js helpers. Charts are created once per canvas and then updated in
 * place on refresh (no destroy/re-create flicker). When Chart.js could not
 * be loaded (offline, CDN blocked) the caller shows a text fallback.
 */

import { h } from './dom.js';

const charts = new WeakMap(); // canvas -> Chart

const GRID = 'rgba(255,255,255,0.06)';
const TICK = '#8f8fa9';

export function chartsAvailable() {
  return typeof window.Chart === 'function';
}

function baseOptions({ stacked = false, yFormat, tooltipFormat, legend = false }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, labels: { color: '#adadc4', boxWidth: 10, boxHeight: 10, padding: 12 } },
      tooltip: {
        callbacks: tooltipFormat ? { label: ctx => `${ctx.dataset.label}: ${tooltipFormat(ctx.parsed.y)}` } : {},
      },
    },
    scales: {
      x: { stacked, ticks: { color: TICK, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, grid: { color: GRID } },
      y: { stacked, beginAtZero: true, ticks: { color: TICK, precision: 0, callback: yFormat || (v => v) }, grid: { color: GRID } },
    },
  };
}

/**
 * Create or update a chart inside `holder` (a .chart-box element).
 * @param {HTMLElement} holder
 * @param {{ type: 'bar'|'line', labels: string[], datasets: object[], stacked?: boolean,
 *           yFormat?: Function, tooltipFormat?: Function, legend?: boolean }} spec
 */
export function renderChart(holder, spec) {
  if (!chartsAvailable()) {
    if (!holder.querySelector('.chart-fallback')) {
      holder.replaceChildren(h('div', { class: 'chart-fallback' }, 'Charts are unavailable (Chart.js could not be loaded). The numbers are shown in the summaries.'));
    }
    return null;
  }
  let canvas = holder.querySelector('canvas');
  if (!canvas) {
    canvas = h('canvas', { role: 'img', 'aria-label': spec.ariaLabel || 'chart' });
    holder.replaceChildren(canvas);
  }
  const existing = charts.get(canvas);
  if (existing && existing.config.type === spec.type) {
    existing.data.labels = spec.labels;
    // Keep dataset objects when the series are unchanged, so hidden (legend) state survives
    const same = existing.data.datasets.length === spec.datasets.length
      && existing.data.datasets.every((d, i) => d.label === spec.datasets[i].label);
    if (same) spec.datasets.forEach((d, i) => { existing.data.datasets[i].data = d.data; });
    else existing.data.datasets = spec.datasets;
    existing.update('none');
    return existing;
  }
  existing?.destroy();
  const chart = new window.Chart(canvas, {
    type: spec.type,
    data: { labels: spec.labels, datasets: spec.datasets },
    options: baseOptions(spec),
  });
  charts.set(canvas, chart);
  return chart;
}

export function barDataset(label, data, color) {
  return { label, data, backgroundColor: color, borderRadius: 2, borderSkipped: false, maxBarThickness: 36 };
}

export function lineDataset(label, data, color, { dashed = false, fill = false } = {}) {
  return {
    label, data, borderColor: color, backgroundColor: fill ? `${color}22` : color,
    borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.25, fill, spanGaps: true,
    borderDash: dashed ? [5, 4] : undefined,
  };
}
