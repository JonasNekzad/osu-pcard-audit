'use strict';

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

const SCHEMA_DESCRIPTION = `
SQLite table: pcards
Columns:
- Year INTEGER
- Month INTEGER
- FullName TEXT
- ID INTEGER
- AgencyNumber INTEGER
- AgencyName TEXT
- CardholderLastName TEXT
- CardholderFirstInitial TEXT
- Description TEXT (may be NULL)
- Amount REAL (positive = charge, negative = return/credit)
- Vendor TEXT
- TransactionDate TEXT in M/D/YYYY 0:00:00 format
- PostedDate TEXT in M/D/YYYY 0:00:00 format
- MCC TEXT

Important database facts:
- The database contains Oklahoma State University transactions.
- Use Year and Month for filtering and chronological sorting.
- TransactionDate is not ISO formatted. To sort days within a month, extract the day between the first and second slash.
`;

const INSTRUCTIONS = `You convert an auditor's natural-language question into one safe SQLite query.

${SCHEMA_DESCRIPTION}

Rules:
1. Return exactly one read-only SELECT query, optionally beginning with WITH.
2. Query only the pcards table. Never use PRAGMA, DDL, DML, comments, or semicolons.
3. Use only columns listed above. Do not invent fields.
4. Treat fraud and control matches as risk indicators, not proof of wrongdoing.
5. Exclude returns with Amount < 0 when the user asks about purchases or spending, unless the user explicitly asks about credits or net spending.
6. Use ROUND(..., 2) for dollar summaries.
7. Add LIMIT 200 to transaction-level output. Aggregate output may omit LIMIT.
8. If the question is unrelated to this database, return a SELECT with a short Message column explaining that it cannot be answered from the available fields.
9. Provide a brief plain-English explanation of what the query measures.
`;

function dollarNumber(text) {
  return Number(String(text).replace(/[$,\s]/g, ''));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function extractYear(question) {
  const match = question.match(/\b(201[0-4])\b/);
  return match ? Number(match[1]) : 2014;
}

function extractLimit(question, fallback = 200) {
  const match = question.match(/\b(?:top|first|largest|highest)\s+(\d{1,3})\b/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(500, Number(match[1])));
}

function extractRange(question) {
  const match = question.match(/\bbetween\s+(\$?[\d,]+(?:\.\d+)?)\s+and\s+(\$?[\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const low = dollarNumber(match[1]);
  const high = dollarNumber(match[2]);
  return Number.isFinite(low) && Number.isFinite(high)
    ? [Math.min(low, high), Math.max(low, high)]
    : null;
}

function extractThreshold(question) {
  const match = question.match(/\b(more than|over|above|greater than|at least|less than|under|below|at most)\s+(\$?[\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const amount = dollarNumber(match[2]);
  if (!Number.isFinite(amount)) return null;
  const phrase = match[1].toLowerCase();
  const operator = ['less than', 'under', 'below'].includes(phrase)
    ? '<'
    : phrase === 'at most'
      ? '<='
      : phrase === 'at least'
        ? '>='
        : '>';
  return { operator, amount };
}

function extractKeyword(question, field) {
  const quoted = question.match(new RegExp(`${field}\\s+(?:contains?|matching|like)?\\s*[“\"']([^”\"']+)[”\"']`, 'i'));
  if (quoted) return quoted[1].trim();

  const direct = question.match(new RegExp(`${field}\\s+(?:contains?|matching|like|named|is|=)\\s+(.+?)(?:\\s+in\\s+201[0-4]|\\s+for\\s+201[0-4]|\\s+sorted|\\s+order(?:ed)?|$)`, 'i'));
  if (!direct) return null;
  return direct[1].replace(/\btransactions?\b/gi, '').trim();
}

function transactionColumns() {
  return 'ID, Amount, FullName, Description, Vendor, TransactionDate, PostedDate, MCC';
}

function generateLocalAuditSql(question) {
  const normalized = String(question || '').trim();
  const year = extractYear(normalized);
  const limit = extractLimit(normalized);
  const range = extractRange(normalized);
  const threshold = extractThreshold(normalized);
  const wantsCredits = /\b(credit|credits|refund|refunds|return|returns|negative)\b/i.test(normalized);
  const wantsAllAmounts = /\b(net|including credits|including returns|all amounts)\b/i.test(normalized);
  const wantsPositive = /\b(positive|charge|charges|purchase|purchases)\b/i.test(normalized);
  const amountPredicate = wantsAllAmounts ? '' : wantsCredits ? ' AND Amount < 0' : wantsPositive ? ' AND Amount > 0' : '';

  const vendorKeyword = extractKeyword(normalized, 'vendor');
  const descriptionKeyword = extractKeyword(normalized, 'description');
  const keywordPredicate = vendorKeyword
    ? ` AND lower(coalesce(Vendor, '')) LIKE lower(${sqlString(`%${vendorKeyword}%`)})`
    : descriptionKeyword
      ? ` AND lower(coalesce(Description, '')) LIKE lower(${sqlString(`%${descriptionKeyword}%`)})`
      : '';

  const group = /\b(by|per)\s+employee\b|\bemployees?\s+(?:spent|spending|totals?)\b/i.test(normalized)
    ? { column: 'FullName', label: 'Employee' }
    : /\b(by|per)\s+vendor\b|\btop\s+\d*\s*vendors?\b/i.test(normalized)
      ? { column: 'Vendor', label: 'Vendor' }
      : /\b(by|per)\s+mcc\b|merchant category/i.test(normalized)
        ? { column: 'MCC', label: 'MCC' }
        : /\b(by|per)\s+month\b|monthly/i.test(normalized)
          ? { column: 'Month', label: 'Month' }
          : /\b(by|per)\s+year\b|yearly|annual trend/i.test(normalized)
            ? { column: 'Year', label: 'Year' }
            : null;

  const wantsCount = /\bhow many\b|\bcount\b|\bnumber of\b/i.test(normalized);
  const wantsAverage = /\baverage\b|\bmean\b/i.test(normalized);
  const wantsAggregate = Boolean(group) || /\b(total|totals|spent|spending|summarize|summary)\b/i.test(normalized);

  if (group && wantsAggregate) {
    const yearPredicate = group.column === 'Year' && !/\b201[0-4]\b/.test(normalized) ? '1 = 1' : `Year = ${year}`;
    const metric = wantsCount
      ? 'COUNT(*) AS TransactionCount'
      : wantsAverage
        ? 'ROUND(AVG(Amount), 2) AS AverageAmount'
        : 'ROUND(SUM(Amount), 2) AS TotalAmount';
    const metricAlias = wantsCount ? 'TransactionCount' : wantsAverage ? 'AverageAmount' : 'TotalAmount';
    const having = threshold ? ` HAVING ${metricAlias} ${threshold.operator} ${threshold.amount}` : '';
    const order = group.column === 'Month' || group.column === 'Year'
      ? `${group.column} ASC`
      : `${metricAlias} DESC`;
    const sql = `SELECT ${group.column} AS ${group.label}, ${metric}\n` +
      `FROM pcards\nWHERE ${yearPredicate}${amountPredicate}${keywordPredicate}\n` +
      `GROUP BY ${group.column}${having}\nORDER BY ${order}\nLIMIT ${limit}`;
    return {
      sql,
      explanation: `Groups ${wantsCredits ? 'credits/returns' : amountPredicate ? 'positive charges' : 'net activity'} by ${group.label.toLowerCase()} and reports the requested ${wantsCount ? 'transaction count' : wantsAverage ? 'average amount' : 'total amount'}.`
    };
  }

  const predicates = [`Year = ${year}`];
  if (range) predicates.push(`Amount BETWEEN ${range[0]} AND ${range[1]}`);
  else if (threshold) predicates.push(`Amount ${threshold.operator} ${threshold.amount}`);
  if (!range && !threshold && amountPredicate) predicates.push(amountPredicate.replace(/^ AND /, ''));
  if (keywordPredicate) predicates.push(keywordPredicate.replace(/^ AND /, ''));

  if (wantsCount) {
    return {
      sql: `SELECT COUNT(*) AS TransactionCount\nFROM pcards\nWHERE ${predicates.join(' AND ')}`,
      explanation: `Counts matching ${year} transactions using the amount and keyword conditions found in the question.`
    };
  }

  if (range || threshold || vendorKeyword || descriptionKeyword || /\b(transaction|transactions|charges|purchases|largest|highest)\b/i.test(normalized)) {
    return {
      sql: `SELECT ${transactionColumns()}\nFROM pcards\nWHERE ${predicates.join(' AND ')}\nORDER BY Amount ${wantsCredits ? 'ASC' : 'DESC'}, ID ASC\nLIMIT ${limit}`,
      explanation: `Returns transaction-level details for ${year}, ordered by amount, using the conditions identified in the question.`
    };
  }

  return {
    sql: `SELECT 'Try asking for transactions above a dollar amount, spending by employee, totals by vendor, monthly spending, MCC summaries, credits, or a vendor/description keyword.' AS Message`,
    explanation: 'The question did not contain a supported audit measure. The result suggests examples that the local natural-language parser can answer.'
  };
}

function extractOutputText(response) {
  for (const candidate of response.candidates || []) {
    const text = (candidate.content?.parts || [])
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    if (text) return text;
  }
  throw new Error('The Gemini response did not contain structured text.');
}

async function generateAuditSql(question) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return generateLocalAuditSql(question);
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const payload = {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          explanation: { type: 'string' }
        },
        required: ['sql', 'explanation'],
        additionalProperties: false
      },
      maxOutputTokens: 900
    }
  };

  const response = await fetch(`${GEMINI_API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Gemini API request failed with status ${response.status}.`;
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  const parsed = JSON.parse(extractOutputText(data));
  if (typeof parsed.sql !== 'string' || typeof parsed.explanation !== 'string') {
    const error = new Error('Gemini returned an invalid audit query response.');
    error.statusCode = 502;
    throw error;
  }
  return parsed;
}

module.exports = { extractOutputText, generateAuditSql, generateLocalAuditSql };
