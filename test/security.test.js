'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeReadOnlySql, escapeLikeTerm, normalizeSql } = require('../src/security');

test('accepts SELECT and WITH queries', () => {
  assert.equal(assertSafeReadOnlySql('SELECT FullName FROM pcards LIMIT 5'), 'SELECT FullName FROM pcards LIMIT 5');
  assert.match(assertSafeReadOnlySql('WITH totals AS (SELECT SUM(Amount) AS total FROM pcards) SELECT * FROM totals'), /^WITH/);
});

test('removes a single trailing semicolon and SQL fence', () => {
  assert.equal(normalizeSql('```sql\nSELECT 1;\n```'), 'SELECT 1');
});

test('rejects writes, multiple statements, and comments', () => {
  assert.throws(() => assertSafeReadOnlySql('DELETE FROM pcards'));
  assert.throws(() => assertSafeReadOnlySql('SELECT 1; SELECT 2'));
  assert.throws(() => assertSafeReadOnlySql('SELECT * FROM pcards -- comment'));
  assert.throws(() => assertSafeReadOnlySql('PRAGMA table_info(pcards)'));
  assert.throws(() => assertSafeReadOnlySql('SELECT * FROM sqlite_master'));
  assert.throws(() => assertSafeReadOnlySql("SELECT readfile('/etc/passwd')"));
});

test('escapes LIKE wildcards', () => {
  assert.equal(escapeLikeTerm('50%_off\\today'), '50\\%\\_off\\\\today');
});
