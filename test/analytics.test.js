"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../js/analytics.js");

const HEADER = "id,date,department,supplier,category,amount_eur,processing_days\n";
const csv = (body) => HEADER + body;

const SAMPLE = csv(
  [
    "1,2024-11-05,Legal,Acme,Consulting,1000,10",
    "2,2024-11-20,Legal,Acme,Consulting,500,20",
    "3,2025-01-10,HR,Beta,Training,2500,5",
    "4,2025-01-15,Legal,Gamma,Consulting,1000,15",
  ].join("\n")
);

const rows = A.parseProcurements(SAMPLE);

describe("parseCsvRows", () => {
  test("handles quoted fields, escaped quotes and commas inside quotes", () => {
    const parsed = A.parseCsvRows('a,"b,c","say ""hi"""\n1,2,3');
    assert.deepEqual(parsed, [["a", "b,c", 'say "hi"'], ["1", "2", "3"]]);
  });

  test("handles CRLF line endings and a missing final newline", () => {
    assert.deepEqual(A.parseCsvRows("a,b\r\n1,2\r\n3,4"), [["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  test("ignores blank lines", () => {
    assert.deepEqual(A.parseCsvRows("a,b\n\n1,2\n"), [["a", "b"], ["1", "2"]]);
  });
});

describe("parseProcurements", () => {
  test("converts types and derives year and month", () => {
    assert.equal(rows.length, 4);
    assert.equal(rows[0].amount, 1000);
    assert.equal(rows[0].year, "2024");
    assert.equal(rows[0].month, "2024-11");
    assert.equal(typeof rows[0].days, "number");
  });

  test("accepts a file with a byte order mark and different column order", () => {
    const text = "\uFEFFdate,id,supplier,department,category,processing_days,amount_eur\n2025-02-01,9,Acme,IT,Training,3,50\n";
    assert.equal(A.parseProcurements(text)[0].supplier, "Acme");
  });

  test("names the row for each kind of error", () => {
    assert.throws(() => A.parseProcurements(csv("1,2025-13-01,IT,Acme,Training,10,2")), /Row 2: date/);
    assert.throws(() => A.parseProcurements(csv("1,2025-02-30,IT,Acme,Training,10,2")), /Row 2: date/);
    assert.throws(() => A.parseProcurements(csv("1,2025-01-01,IT,Acme,Training,abc,2")), /Row 2: amount_eur/);
    assert.throws(() => A.parseProcurements(csv("1,2025-01-01,IT,Acme,Training,-1,2")), /Row 2: amount_eur/);
    assert.throws(
      () => A.parseProcurements(csv("1,2025-01-01,IT,Acme,Training,10,2\n2,2025-01-02,IT,,Training,10,2")),
      /Row 3: supplier/
    );
  });

  test("rejects empty files, missing columns and header-only files", () => {
    assert.throws(() => A.parseProcurements(""), /empty/);
    assert.throws(() => A.parseProcurements("id,date\n1,2025-01-01"), /Missing columns: .*supplier/);
    assert.throws(() => A.parseProcurements(HEADER), /no data rows/);
  });
});

describe("filtering and summaries", () => {
  test("filters by year, department and category, combined", () => {
    assert.equal(A.filterRows(rows, { year: "2025" }).length, 2);
    assert.equal(A.filterRows(rows, { department: "Legal" }).length, 3);
    assert.equal(A.filterRows(rows, { year: "2025", department: "Legal", category: "Consulting" }).length, 1);
    assert.equal(A.filterRows(rows, { year: "all", department: "all" }).length, 4);
  });

  test("uniqueValues returns sorted distinct values", () => {
    assert.deepEqual(A.uniqueValues(rows, "year"), ["2024", "2025"]);
    assert.deepEqual(A.uniqueValues(rows, "department"), ["HR", "Legal"]);
  });

  test("summarise computes totals, average days and the largest purchase", () => {
    const s = A.summarise(rows);
    assert.equal(s.count, 4);
    assert.equal(s.total, 5000);
    assert.equal(s.averageDays, 12.5);
    assert.equal(s.largest.id, "3");
  });

  test("summarise copes with no rows", () => {
    assert.deepEqual(A.summarise([]), { count: 0, total: 0, averageDays: 0, largest: null });
  });
});

describe("spendBySupplier", () => {
  test("sorts by spend, breaks ties by name and reports shares", () => {
    const result = A.spendBySupplier(rows);
    assert.deepEqual(result.map((r) => r.supplier), ["Beta", "Acme", "Gamma"]);
    assert.equal(result[0].share, 0.5);
    assert.equal(result[1].count, 2);
  });

  test("respects the limit", () => {
    assert.equal(A.spendBySupplier(rows, 2).length, 2);
  });

  test("shares add up to one", () => {
    const sum = A.spendBySupplier(rows).reduce((s, r) => s + r.share, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

describe("monthlySpend", () => {
  test("fills empty months so the series has no gaps", () => {
    const result = A.monthlySpend(rows);
    assert.deepEqual(result.map((m) => m.month), ["2024-11", "2024-12", "2025-01"]);
    assert.equal(result[1].total, 0);
    assert.equal(result[0].total, 1500);
    assert.equal(result[2].count, 2);
  });

  test("works across a year boundary and with no rows", () => {
    assert.equal(A.monthlySpend(rows).length, 3);
    assert.deepEqual(A.monthlySpend([]), []);
  });
});

describe("sortRows", () => {
  test("sorts numbers and text in both directions without changing the input", () => {
    const before = rows.map((r) => r.id);
    assert.deepEqual(A.sortRows(rows, "amount", "desc").map((r) => r.id), ["3", "1", "4", "2"]);
    assert.deepEqual(A.sortRows(rows, "supplier", "asc").map((r) => r.supplier), ["Acme", "Acme", "Beta", "Gamma"]);
    assert.deepEqual(rows.map((r) => r.id), before);
  });
});

describe("formatEUR and describe", () => {
  test("formats full and compact amounts", () => {
    assert.match(A.formatEUR(48000), /€48,000/);
    assert.match(A.formatEUR(1234567, { compact: true }), /€1\.23M/);
    assert.equal(A.formatEUR(250000, { compact: true }), "€250.0K");
    assert.equal(A.formatEUR(250000, { compact: true, trim: true }), "€250K");
  });

  test("describes all data", () => {
    const text = A.describe(rows, {});
    assert.match(text, /^Over the full period, all departments spent €5.0K through 4 procurements\./);
    assert.match(text, /Beta received the largest share, 50% of the total\./);
  });

  test("mentions the active filters", () => {
    const filters = { year: "2025", department: "Legal", category: "Consulting" };
    const text = A.describe(A.filterRows(rows, filters), filters);
    assert.match(text, /^In 2025, the Legal department spent .* on Consulting through 1 procurement\./);
    assert.match(text, /All of it went to Gamma\./);
  });

  test("handles an empty selection", () => {
    assert.equal(A.describe([], {}), "No procurements match these filters.");
  });
});
