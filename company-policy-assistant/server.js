'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 20_000;
const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'company', 'employee', 'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it',
  'may', 'must', 'of', 'on', 'or', 'our', 'policy', 'the', 'their', 'to',
  'we', 'what', 'when', 'where', 'which', 'who', 'with', 'work', 'you', 'your'
]);

function parseCsv(value) {
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && value[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some(Boolean)) records.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    records.push(row);
  }
  const [headers, ...data] = records;
  const index = Object.fromEntries(headers.map((header, i) => [header.trim(), i]));
  return data.map((record) => ({
    title: record[index.title]?.trim() || '',
    department: record[index.department]?.trim() || '',
    policyText: record[index.policy_text]?.trim() || '',
    category: record[index.category]?.trim() || ''
  })).filter((policy) => policy.title && policy.policyText);
}

function stem(word) {
  if (word.length > 7 && word.endsWith('ation')) return word.slice(0, -5);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function tokenize(value) {
  return (value.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => !STOP_WORDS.has(token))
    .map(stem);
}

const policies = parseCsv(fs.readFileSync(path.join(ROOT, 'data', 'company_policies.csv'), 'utf8'));

function ruleRank(query, sourcePolicies, limit = 3) {
  const queryTokens = tokenize(query);
  return sourcePolicies.map((policy) => {
    const title = new Set(tokenize(policy.title));
    const category = new Set(tokenize(policy.category));
    const department = new Set(tokenize(policy.department));
    const body = new Set(tokenize(policy.policyText));
    const phraseBonus = query.toLowerCase().includes(policy.title.toLowerCase()) ? 20 : 0;
    const score = phraseBonus + queryTokens.reduce((sum, token) => sum +
      (title.has(token) ? 5 : 0) +
      (category.has(token) ? 2 : 0) +
      (department.has(token) ? 1 : 0) +
      (body.has(token) ? 1 : 0), 0);
    return { policy, score };
  }).sort((a, b) => b.score - a.score || a.policy.title.localeCompare(b.policy.title)).slice(0, limit);
}

function vectorRank(query, sourcePolicies, limit = 5) {
  const documents = sourcePolicies.map((policy) => tokenize([
    policy.title, policy.title, policy.title, policy.category,
    policy.category, policy.department, policy.policyText
  ].join(' ')));
  const documentFrequency = new Map();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const idf = (term) => Math.log((sourcePolicies.length + 1) /
    ((documentFrequency.get(term) || 0) + 1)) + 1;
  const makeVector = (tokens) => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return new Map([...counts].map(([term, count]) => [term, (count / Math.max(tokens.length, 1)) * idf(term)]));
  };
  const queryVector = makeVector(tokenize(query));
  const queryNorm = Math.sqrt([...queryVector.values()].reduce((sum, value) => sum + value * value, 0));
  return sourcePolicies.map((policy, index) => {
    const documentVector = makeVector(documents[index]);
    const dot = [...queryVector].reduce((sum, [term, value]) => sum + value * (documentVector.get(term) || 0), 0);
    const documentNorm = Math.sqrt([...documentVector.values()].reduce((sum, value) => sum + value * value, 0));
    return { policy, score: queryNorm && documentNorm ? dot / (queryNorm * documentNorm) : 0 };
  }).sort((a, b) => b.score - a.score || a.policy.title.localeCompare(b.policy.title)).slice(0, limit);
}

function rulesBasedResult(query) {
  const started = performance.now();
  const [match] = ruleRank(query, policies, 1);
  const found = Boolean(match && match.score >= 5);
  return {
    method: 'Rules-based search',
    approach: 'Weighted keyword matching',
    answer: found ? match.policy.policyText : 'No policy in the database matched the question.',
    relevantPolicy: found ? match.policy.title : 'No matching policy',
    responseTimeMs: Math.max(1, Math.round(performance.now() - started)),
    tokenUse: 0,
    unsupported: 'Not flagged',
    status: 'complete'
  };
}

function contextText(sourcePolicies) {
  return sourcePolicies.map((policy, index) =>
    `${index + 1}. TITLE: ${policy.title}\nDEPARTMENT: ${policy.department}\nCATEGORY: ${policy.category}\nPOLICY: ${policy.policyText}`
  ).join('\n\n');
}

function outputText(payload) {
  for (const candidate of payload.candidates || []) {
    const text = (candidate.content?.parts || [])
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text) return text;
  }
  throw new Error('Gemini returned no structured text.');
}

async function llmResult(query, contextPolicies, method, approach) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return {
      method, approach,
      answer: 'This method becomes available when GEMINI_API_KEY is configured.',
      relevantPolicy: 'Not evaluated', responseTimeMs: 0, tokenUse: 0,
      unsupported: 'Not assessed', status: 'unavailable'
    };
  }
  const started = performance.now();
  try {
    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const response = await fetch(`${GEMINI_API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text:
          'Answer only from the supplied policy database. Identify one exact policy title and include one exact supporting sentence copied from that policy. ' +
          'If the database is insufficient, answer exactly: The policy database does not contain enough information to answer this question. ' +
          'Then use No matching policy as the title and an empty support quote.'
        }] },
        contents: [{ role: 'user', parts: [{ text: `QUESTION:\n${query}\n\nPOLICY DATABASE:\n${contextText(contextPolicies)}` }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object', additionalProperties: false,
            properties: {
              answer: { type: 'string' },
              policy_title: { type: 'string' },
              support_quote: { type: 'string' }
            },
            required: ['answer', 'policy_title', 'support_quote']
          },
          maxOutputTokens: 800
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed (${response.status}).`);
    const parsed = JSON.parse(outputText(payload));
    if (typeof parsed.answer !== 'string' || typeof parsed.policy_title !== 'string' || typeof parsed.support_quote !== 'string') {
      throw new Error('Gemini returned an invalid policy response.');
    }
    const matchingPolicy = contextPolicies.find((policy) =>
      policy.title.toLowerCase() === parsed.policy_title.toLowerCase());
    const expectedNoMatch = 'The policy database does not contain enough information to answer this question.';
    const noMatch = parsed.policy_title === 'No matching policy';
    const quoteSupported = Boolean(matchingPolicy && parsed.support_quote &&
      matchingPolicy.policyText.toLowerCase().includes(parsed.support_quote.toLowerCase()));
    return {
      method, approach, answer: parsed.answer, relevantPolicy: parsed.policy_title,
      responseTimeMs: Math.round(performance.now() - started),
      tokenUse: payload.usageMetadata?.totalTokenCount || 0,
      unsupported: noMatch ? (parsed.answer === expectedNoMatch ? 'Not flagged' : 'Flagged') :
        (quoteSupported ? 'Not flagged' : 'Flagged'),
      status: 'complete'
    };
  } catch (error) {
    return {
      method, approach,
      answer: error instanceof Error ? error.message : 'The method failed.',
      relevantPolicy: 'Not evaluated',
      responseTimeMs: Math.round(performance.now() - started),
      tokenUse: 0, unsupported: 'Not assessed', status: 'error'
    };
  }
}

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 });
  }
}

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

async function serveStatic(pathname, res) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  const body = await fsp.readFile(path.join(PUBLIC_DIR, entry[0]));
  res.writeHead(200, {
    'Content-Type': entry[1], 'Content-Length': body.length,
    'Cache-Control': entry[0] === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
  return true;
}

async function handler(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return jsonResponse(res, 200, { status: 'ok', policyCount: policies.length });
    }
    if (req.method === 'POST' && pathname === '/api/compare') {
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim();
      if (question.length < 3 || question.length > 400) {
        throw Object.assign(new Error('Enter a policy question between 3 and 400 characters.'), { statusCode: 400 });
      }
      const vectorPolicies = vectorRank(question, policies, 5).map((entry) => entry.policy);
      const [withoutVector, withVector] = await Promise.all([
        llmResult(question, policies, 'LLM without vector index', 'Full policy database in the prompt'),
        llmResult(question, vectorPolicies, 'LLM with vector index', 'TF-IDF cosine retrieval, top 5 policies')
      ]);
      return jsonResponse(res, 200, {
        question, policyCount: policies.length,
        results: [rulesBasedResult(question), withoutVector, withVector]
      });
    }
    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    return jsonResponse(res, 404, { error: 'Not found.' });
  } catch (error) {
    return jsonResponse(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'The request could not be completed.'
    });
  }
}

function start() {
  const server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Company Policy Assistant listening on port ${PORT}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { handler, llmResult, parseCsv, ruleRank, rulesBasedResult, start, vectorRank };
