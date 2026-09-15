'use strict';

const form = document.querySelector('#query-form');
const input = document.querySelector('#policy-question');
const button = document.querySelector('#compare-button');
const error = document.querySelector('#form-error');
const methodGrid = document.querySelector('#method-grid');
const tableWrap = document.querySelector('#results-table-wrap');
const resultsBody = document.querySelector('#results-body');
const resultsTitle = document.querySelector('#results-title');
const questionLabel = document.querySelector('#question-label');

function cell(text, className) {
  const td = document.createElement('td');
  const div = document.createElement('div');
  if (className) div.className = className;
  div.textContent = text;
  td.append(div);
  return td;
}

function renderResults(payload) {
  resultsBody.replaceChildren();
  for (const result of payload.results) {
    const row = document.createElement('tr');
    const methodCell = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'method-name';
    name.textContent = result.method;
    const approach = document.createElement('div');
    approach.className = 'method-approach';
    approach.textContent = result.approach;
    const status = document.createElement('span');
    status.className = `status ${result.status === 'complete' ? 'status-ready' : result.status === 'error' ? 'status-error' : 'status-pending'}`;
    status.textContent = result.status === 'complete' ? 'Complete' : result.status === 'error' ? 'Method error' : 'API key needed';
    methodCell.append(name, approach, status);

    const answerCell = document.createElement('td');
    const answer = document.createElement('div');
    answer.className = 'answer';
    answer.textContent = result.answer;
    const policy = document.createElement('div');
    policy.className = 'policy-reference';
    policy.textContent = `▤ ${result.relevantPolicy}`;
    answerCell.append(answer, policy);

    const riskClass = result.unsupported === 'Flagged' ? 'risk risk-flagged' :
      result.unsupported === 'Not flagged' ? 'risk risk-clear' : 'risk risk-neutral';
    row.append(methodCell, answerCell,
      cell(`${Number(result.responseTimeMs).toLocaleString()} ms`, 'metric'),
      cell(Number(result.tokenUse).toLocaleString(), 'metric'),
      cell(result.unsupported, riskClass));
    resultsBody.append(row);
  }
  methodGrid.hidden = true;
  tableWrap.hidden = false;
  resultsTitle.textContent = 'Comparison results';
  questionLabel.textContent = `Question: ${payload.question}`;
}

async function compare(question) {
  const response = await fetch('/api/compare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The comparison failed.');
  renderResults(payload);
  return payload;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (question.length < 3) {
    error.textContent = 'Enter a policy question.';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  button.disabled = true;
  button.querySelector('span').textContent = 'Comparing…';
  try {
    await compare(question);
  } catch (caught) {
    error.textContent = caught instanceof Error ? caught.message : 'The comparison failed.';
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Compare';
  }
});

for (const sample of document.querySelectorAll('.samples button')) {
  sample.addEventListener('click', () => {
    input.value = sample.textContent;
    error.hidden = true;
    input.focus();
  });
}

const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  Promise.resolve(modelContext.registerTool({
    name: 'compare_policy_answers',
    title: 'Compare policy answers',
    description: 'Run one company-policy question through the three visible retrieval methods.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', minLength: 3, maxLength: 400 } },
      required: ['question'], additionalProperties: false
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(value) {
      const question = typeof value?.question === 'string' ? value.question.trim() : '';
      if (question.length < 3 || question.length > 400) throw new Error('Question must be between 3 and 400 characters.');
      input.value = question;
      const payload = await compare(question);
      return {
        question: payload.question,
        results: payload.results.map((result) => ({ method: result.method, relevantPolicy: result.relevantPolicy, status: result.status }))
      };
    }
  }, { signal: lifecycle.signal })).catch(() => {});
}
