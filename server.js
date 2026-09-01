'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');

const { generateAuditSql } = require('./src/openai');
const { assertSafeReadOnlySql, escapeLikeTerm } = require('./src/security');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 25_000;
const MAX_QUERY_ROWS = 500;

let db;
let resolvedDatabasePath;

async function resolveDatabasePath() {
  const override = process.env.PCARDS_DB_PATH;
  if (override) {
    await fsp.access(override, fs.constants.R_OK);
    return path.resolve(override);
  }

  const uncompressed = path.join(ROOT, 'data', 'pcards.db');
  if (fs.existsSync(uncompressed)) {
    return uncompressed;
  }

  const compressed = path.join(ROOT, 'data', 'pcards.db.gz');
  await fsp.access(compressed, fs.constants.R_OK);
  const stat = await fsp.stat(compressed);
  const cacheName = `pcards-${stat.size}-${Math.trunc(stat.mtimeMs)}.db`;
  const destination = path.join(os.tmpdir(), cacheName);

  if (!fs.existsSync(destination)) {
    const temporary = `${destination}.${process.pid}.tmp`;
    await pipeline(
      fs.createReadStream(compressed),
      zlib.createGunzip(),
      fs.createWriteStream(temporary)
    );
    await fsp.rename(temporary, destination);
  }

  return destination;
}

async function initializeDatabase() {
  resolvedDatabasePath = await resolveDatabasePath();
  db = new DatabaseSync(resolvedDatabasePath, {
    readOnly: true,
    timeout: 3000
  });
  db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;');
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
    if (length > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must contain valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function getYears() {
  return db.prepare('SELECT DISTINCT Year FROM pcards ORDER BY Year DESC').all().map((row) => row.Year);
}

function searchTransactions({ year, field, keyword }) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear) || !getYears().includes(numericYear)) {
    const error = new Error('Select a valid year.');
    error.statusCode = 400;
    throw error;
  }
  if (!['Description', 'Vendor'].includes(field)) {
    const error = new Error('Search field must be Description or Vendor.');
    error.statusCode = 400;
    throw error;
  }

  const term = String(keyword || '').trim();
  if (term.length < 2 || term.length > 80) {
    const error = new Error('Enter a keyword between 2 and 80 characters.');
    error.statusCode = 400;
    throw error;
  }

  const pattern = `%${escapeLikeTerm(term.toLowerCase())}%`;
  const predicate = `lower(coalesce("${field}", '')) LIKE ? ESCAPE '\\'`;
  const summary = db.prepare(`
    SELECT COUNT(*) AS MatchCount,
           ROUND(COALESCE(SUM(Amount), 0), 2) AS NetAmount,
           COUNT(DISTINCT FullName) AS EmployeeCount,
           COUNT(DISTINCT Vendor) AS VendorCount
    FROM pcards
    WHERE Year = ? AND ${predicate}
  `).get(numericYear, pattern);

  const rows = db.prepare(`
    SELECT ID, Amount, FullName, Description, Vendor,
           TransactionDate, PostedDate, MCC
    FROM pcards
    WHERE Year = ? AND ${predicate}
    ORDER BY Month ASC,
             CAST(substr(TransactionDate, instr(TransactionDate, '/') + 1,
                  instr(substr(TransactionDate, instr(TransactionDate, '/') + 1), '/') - 1) AS INTEGER) ASC,
             Amount DESC, ID ASC
    LIMIT 1000
  `).all(numericYear, pattern);

  return {
    summary,
    rows,
    truncated: summary.MatchCount > rows.length
  };
}

function executeGeneratedQuery(rawSql) {
  const sql = assertSafeReadOnlySql(rawSql);
  const wrappedSql = `SELECT * FROM (${sql}) AS generated_query LIMIT ${MAX_QUERY_ROWS + 1}`;
  const statement = db.prepare(wrappedSql);
  const resultRows = statement.all();
  const truncated = resultRows.length > MAX_QUERY_ROWS;
  const rows = truncated ? resultRows.slice(0, MAX_QUERY_ROWS) : resultRows;
  const columns = statement.columns().map((column) => column.name);
  return { sql, columns, rows, truncated };
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
  const [filename, contentType] = entry;
  const body = await fsp.readFile(path.join(PUBLIC_DIR, filename));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': filename === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
  return true;
}

async function requestHandler(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return jsonResponse(res, 200, { status: 'ok', database: Boolean(db) });
    }

    if (req.method === 'GET' && pathname === '/api/meta') {
      return jsonResponse(res, 200, {
        years: getYears(),
        naturalLanguageConfigured: Boolean(process.env.OPENAI_API_KEY)
      });
    }

    if (req.method === 'POST' && pathname === '/api/search') {
      const body = await readJsonBody(req);
      return jsonResponse(res, 200, searchTransactions(body));
    }

    if (req.method === 'POST' && pathname === '/api/ask') {
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim();
      if (question.length < 5 || question.length > 500) {
        const error = new Error('Enter an audit question between 5 and 500 characters.');
        error.statusCode = 400;
        throw error;
      }
      const generated = await generateAuditSql(question);
      const result = executeGeneratedQuery(generated.sql);
      return jsonResponse(res, 200, {
        question,
        explanation: generated.explanation,
        ...result
      });
    }

    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    jsonResponse(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    jsonResponse(res, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'The request could not be completed.'
    });
  }
}

async function start() {
  await initializeDatabase();
  const server = http.createServer(requestHandler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OSU P-card Audit Console listening on port ${PORT}`);
    console.log(`Read-only database: ${resolvedDatabasePath}`);
  });
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start application:', error);
    process.exitCode = 1;
  });
}

module.exports = { executeGeneratedQuery, initializeDatabase, searchTransactions, start };
