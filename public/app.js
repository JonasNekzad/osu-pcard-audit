'use strict';

const state = {
  dashboardRows: [],
  dashboardFilename: 'pcard-search.csv'
};

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const integer = new Intl.NumberFormat('en-US');

function setStatus(element, message = '', isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function formatCell(value, column) {
  if (value === null || value === undefined) return '';
  if (/amount|spend|total|charges|credits/i.test(column) && typeof value === 'number') {
    return currency.format(value);
  }
  if (/pct|percentage/i.test(column) && typeof value === 'number') return `${value}%`;
  return String(value);
}

function renderTable(target, rows, columns) {
  target.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No matching transactions were found.';
    target.append(empty);
    return;
  }

  const resolvedColumns = columns?.length ? columns : Object.keys(rows[0]);
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of resolvedColumns) {
    const th = document.createElement('th');
    th.textContent = column.replace(/([a-z])([A-Z])/g, '$1 $2');
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const column of resolvedColumns) {
      const td = document.createElement('td');
      const value = row[column];
      td.textContent = formatCell(value, column);
      if (typeof value === 'number') td.classList.add('numeric');
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  target.append(wrap);
}

function initializeTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((candidate) => {
        const active = candidate === tab;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      document.getElementById(`${tab.dataset.tab}-panel`).classList.add('active');
    });
  });
}

async function initializeMetadata() {
  const metadata = await apiRequest('/api/meta');
  const select = document.getElementById('year-select');
  select.replaceChildren(...metadata.years.map((year) => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    if (year === 2014) option.selected = true;
    return option;
  }));
  document.getElementById('nl-config-warning').classList.toggle('hidden', metadata.naturalLanguageConfigured);
}

function initializeAskForm() {
  const form = document.getElementById('ask-form');
  const question = document.getElementById('question');
  const status = document.getElementById('ask-status');
  const results = document.getElementById('ask-results');
  const submit = form.querySelector('button[type="submit"]');

  document.querySelectorAll('.example-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      question.value = chip.textContent;
      question.focus();
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus(status, 'Generating a read-only query and running the analysis...');
    results.classList.add('hidden');
    submit.disabled = true;
    try {
      const data = await apiRequest('/api/ask', {
        method: 'POST',
        body: JSON.stringify({ question: question.value.trim() })
      });
      document.getElementById('ask-explanation').textContent = data.explanation;
      document.getElementById('ask-sql').textContent = data.sql;
      document.getElementById('ask-row-count').textContent = `${integer.format(data.rows.length)} row${data.rows.length === 1 ? '' : 's'}${data.truncated ? ' displayed' : ''}`;
      renderTable(document.getElementById('ask-table'), data.rows, data.columns);
      results.classList.remove('hidden');
      setStatus(status, data.truncated ? 'The output was capped at 500 rows.' : 'Analysis completed.');
    } catch (error) {
      setStatus(status, error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
}

function makeCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n');
}

function initializeDashboard() {
  const status = document.getElementById('dashboard-status');
  const results = document.getElementById('dashboard-results');
  let lastFocusedInput = document.getElementById('description-keyword');

  document.querySelectorAll('.search-card input').forEach((input) => {
    input.addEventListener('focus', () => { lastFocusedInput = input; });
  });

  document.querySelectorAll('.keyword-chips button').forEach((button) => {
    button.addEventListener('click', () => {
      lastFocusedInput.value = button.dataset.keyword;
      lastFocusedInput.focus();
    });
  });

  document.querySelectorAll('.search-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const field = form.dataset.field;
      const keyword = new FormData(form).get('keyword').trim();
      const year = Number(document.getElementById('year-select').value);
      const submit = form.querySelector('button[type="submit"]');
      setStatus(status, `Searching ${field.toLowerCase()} values for “${keyword}”...`);
      results.classList.add('hidden');
      submit.disabled = true;
      try {
        const data = await apiRequest('/api/search', {
          method: 'POST',
          body: JSON.stringify({ year, field, keyword })
        });
        state.dashboardRows = data.rows;
        state.dashboardFilename = `pcard-${year}-${field.toLowerCase()}-${keyword.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.csv`;
        document.getElementById('dashboard-result-title').textContent = `${field} contains “${keyword}” — ${year}`;
        document.getElementById('metric-matches').textContent = integer.format(data.summary.MatchCount);
        document.getElementById('metric-amount').textContent = currency.format(data.summary.NetAmount);
        document.getElementById('metric-employees').textContent = integer.format(data.summary.EmployeeCount);
        document.getElementById('metric-vendors').textContent = integer.format(data.summary.VendorCount);
        const truncation = document.getElementById('dashboard-truncated');
        truncation.classList.toggle('hidden', !data.truncated);
        truncation.textContent = data.truncated ? `The table displays the first ${integer.format(data.rows.length)} of ${integer.format(data.summary.MatchCount)} matches. Downloaded CSV contains the displayed rows.` : '';
        renderTable(document.getElementById('dashboard-table'), data.rows);
        results.classList.remove('hidden');
        setStatus(status, `Found ${integer.format(data.summary.MatchCount)} potential match${data.summary.MatchCount === 1 ? '' : 'es'}.`);
      } catch (error) {
        setStatus(status, error.message, true);
      } finally {
        submit.disabled = false;
      }
    });
  });

  document.getElementById('download-csv').addEventListener('click', () => {
    const blob = new Blob([makeCsv(state.dashboardRows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = state.dashboardFilename;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initializeTabs();
  initializeAskForm();
  initializeDashboard();
  try {
    await initializeMetadata();
  } catch (error) {
    setStatus(document.getElementById('dashboard-status'), `Unable to load database metadata: ${error.message}`, true);
  }
});
