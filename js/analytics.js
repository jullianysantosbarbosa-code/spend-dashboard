/*
 * Pure data functions for the dashboard: CSV parsing, filtering, summaries and
 * plain-language descriptions. No DOM access, so everything here is unit tested
 * in Node and reused unchanged in the browser (exposed as window.Analytics).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Analytics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const REQUIRED_COLUMNS = [
    "id",
    "date",
    "department",
    "supplier",
    "category",
    "amount_eur",
    "processing_days",
  ];

  /** Split CSV text into rows of fields. Handles quotes, escaped quotes, CRLF and LF. */
  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
      } else {
        field += char;
      }
    }
    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  /**
   * Parse and validate procurement CSV text.
   * Throws an Error with a human-readable message that names the offending row
   * (row 1 is the header).
   */
  function parseProcurements(text) {
    const table = parseCsvRows(String(text).replace(/^\uFEFF/, ""));
    if (table.length === 0) throw new Error("The file is empty.");

    const header = table[0].map((h) => h.trim());
    const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
    if (missing.length > 0) throw new Error(`Missing columns: ${missing.join(", ")}.`);
    if (table.length === 1) throw new Error("The file has a header but no data rows.");

    const index = Object.fromEntries(header.map((name, position) => [name, position]));

    return table.slice(1).map((cells, i) => {
      const rowNumber = i + 2;
      const get = (name) => (cells[index[name]] ?? "").trim();

      const date = get("date");
      if (!isValidDate(date)) throw new Error(`Row ${rowNumber}: date must be a real date in YYYY-MM-DD format.`);

      const amount = Number(get("amount_eur"));
      if (get("amount_eur") === "" || !Number.isFinite(amount) || amount < 0) {
        throw new Error(`Row ${rowNumber}: amount_eur must be a number of zero or more.`);
      }

      const days = Number(get("processing_days"));
      if (get("processing_days") === "" || !Number.isFinite(days) || days < 0) {
        throw new Error(`Row ${rowNumber}: processing_days must be a number of zero or more.`);
      }

      for (const field of ["department", "supplier", "category"]) {
        if (get(field) === "") throw new Error(`Row ${rowNumber}: ${field} must not be empty.`);
      }

      return {
        id: get("id"),
        date,
        year: date.slice(0, 4),
        month: date.slice(0, 7),
        department: get("department"),
        supplier: get("supplier"),
        category: get("category"),
        amount,
        days,
      };
    });
  }

  const isActive = (value) => value !== undefined && value !== null && value !== "" && value !== "all";

  /** Keep rows that match every active filter (year, department, category). */
  function filterRows(rows, filters = {}) {
    return rows.filter(
      (row) =>
        (!isActive(filters.year) || row.year === String(filters.year)) &&
        (!isActive(filters.department) || row.department === filters.department) &&
        (!isActive(filters.category) || row.category === filters.category)
    );
  }

  function uniqueValues(rows, key) {
    return [...new Set(rows.map((row) => row[key]))].sort((a, b) => String(a).localeCompare(String(b)));
  }

  /** Headline numbers for a set of rows. */
  function summarise(rows) {
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const days = rows.reduce((sum, row) => sum + row.days, 0);
    const largest = rows.reduce((best, row) => (best === null || row.amount > best.amount ? row : best), null);
    return {
      count: rows.length,
      total,
      averageDays: rows.length ? days / rows.length : 0,
      largest,
    };
  }

  /** Total spend per supplier, largest first, with each supplier's share of the total. */
  function spendBySupplier(rows, limit = 8) {
    const totals = new Map();
    for (const row of rows) {
      const entry = totals.get(row.supplier) || { supplier: row.supplier, total: 0, count: 0 };
      entry.total += row.amount;
      entry.count += 1;
      totals.set(row.supplier, entry);
    }
    const grandTotal = [...totals.values()].reduce((sum, e) => sum + e.total, 0);
    return [...totals.values()]
      .sort((a, b) => b.total - a.total || a.supplier.localeCompare(b.supplier))
      .slice(0, limit)
      .map((entry) => ({ ...entry, share: grandTotal ? entry.total / grandTotal : 0 }));
  }

  function nextMonth(month) {
    const [year, number] = month.split("-").map(Number);
    return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
  }

  /** Spend per month, with empty months filled in so charts have no gaps. */
  function monthlySpend(rows) {
    if (rows.length === 0) return [];
    const totals = new Map();
    for (const row of rows) {
      const entry = totals.get(row.month) || { month: row.month, total: 0, count: 0 };
      entry.total += row.amount;
      entry.count += 1;
      totals.set(row.month, entry);
    }
    const months = [...totals.keys()].sort();
    const result = [];
    for (let month = months[0]; month <= months[months.length - 1]; month = nextMonth(month)) {
      result.push(totals.get(month) || { month, total: 0, count: 0 });
    }
    return result;
  }

  /** Sort a copy of the rows. Ties fall back to date and id so the order is stable. */
  function sortRows(rows, key, direction = "desc") {
    const factor = direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const order =
        typeof a[key] === "number" ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]));
      return order * factor || a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
    });
  }

  /** Format a euro amount. `compact` gives short forms such as EUR 1.20M; `trim` drops trailing zeros. */
  function formatEUR(value, { compact = false, trim = false } = {}) {
    return new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: "EUR",
      notation: compact ? "compact" : "standard",
      minimumFractionDigits: compact && !trim ? 1 : 0,
      maximumFractionDigits: compact ? 2 : 0,
    }).format(value);
  }

  /** One plain-language sentence describing the current selection. */
  function describe(rows, filters = {}) {
    if (rows.length === 0) return "No procurements match these filters.";

    const { count, total } = summarise(rows);
    const when = isActive(filters.year) ? `In ${filters.year}` : "Over the full period";
    const who = isActive(filters.department) ? `the ${filters.department} department` : "all departments";
    const what = isActive(filters.category) ? ` on ${filters.category}` : "";
    const noun = count === 1 ? "procurement" : "procurements";
    let text = `${when}, ${who} spent ${formatEUR(total, { compact: true })}${what} through ${count} ${noun}.`;

    const suppliers = spendBySupplier(rows, Infinity);
    if (suppliers.length === 1) {
      text += ` All of it went to ${suppliers[0].supplier}.`;
    } else {
      const top = suppliers[0];
      text += ` ${top.supplier} received the largest share, ${Math.round(top.share * 100)}% of the total.`;
    }
    return text;
  }

  return {
    parseCsvRows,
    parseProcurements,
    filterRows,
    uniqueValues,
    summarise,
    spendBySupplier,
    monthlySpend,
    sortRows,
    formatEUR,
    describe,
  };
});
