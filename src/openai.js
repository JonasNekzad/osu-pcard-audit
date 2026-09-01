'use strict';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

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
5. Exclude returns with Amount > 0 when the user asks about purchases or spending, unless the user explicitly asks about credits or net spending.
6. Use ROUND(..., 2) for dollar summaries.
7. Add LIMIT 200 to transaction-level output. Aggregate output may omit LIMIT.
8. If the question is unrelated to this database, return a SELECT with a short Message column explaining that it cannot be answered from the available fields.
9. Provide a brief plain-English explanation of what the query measures.
`;

function extractOutputText(response) {
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  throw new Error('The model response did not contain structured text.');
}

async function generateAuditSql(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('Natural-language questions require an OPENAI_API_KEY environment variable.');
    error.statusCode = 503;
    throw error;
  }

  const payload = {
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    instructions: INSTRUCTIONS,
    input: question,
    max_output_tokens: 900,
    text: {
      format: {
        type: 'json_schema',
        name: 'audit_sql_query',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
            explanation: { type: 'string' }
          },
          required: ['sql', 'explanation'],
          additionalProperties: false
        }
      }
    }
  };

  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI API request failed with status ${response.status}.`;
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }

  return JSON.parse(extractOutputText(data));
}

module.exports = { generateAuditSql };
