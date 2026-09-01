'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateLocalAuditSql } = require('../src/openai');
const { assertSafeReadOnlySql } = require('../src/security');

test('groups 2014 spending by employee above a threshold', () => {
  const result = generateLocalAuditSql('Which employees spent more than $50,000 in 2014, sorted highest first?');
  assert.match(result.sql, /FullName AS Employee/);
  assert.match(result.sql, /HAVING TotalAmount > 50000/);
  assert.doesNotThrow(() => assertSafeReadOnlySql(result.sql));
});

test('finds positive charges in a range', () => {
  const result = generateLocalAuditSql('Find positive 2014 charges between $4,900 and $5,000');
  assert.match(result.sql, /Amount BETWEEN 4900 AND 5000/);
  assert.match(result.sql, /ORDER BY Amount DESC/);
  assert.doesNotThrow(() => assertSafeReadOnlySql(result.sql));
});

test('summarizes purchases by MCC', () => {
  const result = generateLocalAuditSql('Summarize 2014 purchases by MCC and total amount');
  assert.match(result.sql, /MCC AS MCC/);
  assert.match(result.sql, /SUM\(Amount\)/);
  assert.doesNotThrow(() => assertSafeReadOnlySql(result.sql));
});

test('escapes vendor keywords and caps output', () => {
  const result = generateLocalAuditSql("Show transactions for vendor named O'Reilly in 2013");
  assert.match(result.sql, /O''Reilly/);
  assert.match(result.sql, /LIMIT 200/);
  assert.doesNotThrow(() => assertSafeReadOnlySql(result.sql));
});
