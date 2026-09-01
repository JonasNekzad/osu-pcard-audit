'use strict';

const BLOCKED_SQL = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|replace|trigger|analyze|load_extension)\b/i;
const BLOCKED_INTERNALS = /\b(sqlite_schema|sqlite_master|sqlite_temp_schema|readfile|writefile|pragma_[a-z0-9_]+)\b/i;

function normalizeSql(rawSql) {
  if (typeof rawSql !== 'string') {
    throw new Error('The generated query was not text.');
  }

  let sql = rawSql.trim();
  if (sql.startsWith('```')) {
    sql = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  if (sql.endsWith(';')) {
    sql = sql.slice(0, -1).trim();
  }
  return sql;
}

function assertSafeReadOnlySql(rawSql) {
  const sql = normalizeSql(rawSql);

  if (!sql || sql.length > 8000) {
    throw new Error('The generated query is empty or too long.');
  }
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('Only SELECT and WITH queries are permitted.');
  }
  if (sql.includes(';') || sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
    throw new Error('Multiple statements and SQL comments are not permitted.');
  }
  if (BLOCKED_SQL.test(sql)) {
    throw new Error('The generated query contains a prohibited SQL operation.');
  }
  if (BLOCKED_INTERNALS.test(sql)) {
    throw new Error('The generated query may access only the P-card dataset.');
  }

  return sql;
}

function escapeLikeTerm(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

module.exports = {
  assertSafeReadOnlySql,
  escapeLikeTerm,
  normalizeSql,
};
