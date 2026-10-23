/* Browser UI: reads data, applies filters and renders the dashboard. */
(function () {
  "use strict";

  const A = window.Analytics;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const FILTERS = [
    { id: "filter-year", key: "year", all: "All years" },
    { id: "filter-department", key: "department", all: "All departments" },
    { id: "filter-category", key: "category", all: "All categories" },
  ];

  const COLUMNS = [
    { key: "date", label: "Date" },
    { key: "supplier", label: "Supplier" },
    { key: "category", label: "Category" },
    { key: "department", label: "Department" },
    { key: "amount", label: "Amount", numeric: true },
    { key: "days", label: "Processing days", numeric: true },
  ];

  const TABLE_ROWS = 12;

  const state = {
    rows: [],
    filters: { year: "all", department: "all", category: "all" },
    sort: { key: "amount", direction: "desc" },
  };

  const $ = (id) => document.getElementById(id);

  function make(tag, props = {}, children = [], namespace) {
    const node = namespace ? document.createElementNS(namespace, tag) : document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (name === "class") node.setAttribute("class", value);
      else if (name === "text") node.textContent = value;
      else node.setAttribute(name, value);
    }
    for (const child of [].concat(children)) node.append(child);
    return node;
  }

  const svg = (tag, props, children) => make(tag, props, children, SVG_NS);

  function monthLabel(month, style = "short") {
    const [year, number] = month.split("-").map(Number);
    return new Date(Date.UTC(year, number - 1, 1)).toLocaleString("en-IE", {
      month: "short",
      year: style === "short" ? "2-digit" : "numeric",
      timeZone: "UTC",
    });
  }

  function showMessage(text) {
    const box = $("message");
    box.textContent = text || "";
    box.hidden = !text;
  }

  /* Filters */

  function fillFilters() {
    for (const { id, key, all } of FILTERS) {
      const select = $(id);
      const values = A.uniqueValues(state.rows, key);
      if (!values.includes(state.filters[key])) state.filters[key] = "all";
      select.replaceChildren(
        make("option", { value: "all", text: all }),
        ...values.map((value) => make("option", { value, text: value }))
      );
      select.value = state.filters[key];
    }
  }

  /* Summary */

  function renderSummary(rows) {
    $("headline").textContent = A.describe(rows, state.filters);

    const summary = A.summarise(rows);
    const facts = $("facts");
    facts.replaceChildren();
    if (rows.length === 0) return;

    const entries = [
      ["Procurements", String(summary.count), null],
      ["Average processing time", `${summary.averageDays.toFixed(1)} days`, null],
      [
        "Largest single procurement",
        A.formatEUR(summary.largest.amount),
        `${summary.largest.supplier}, ${summary.largest.date}`,
      ],
    ];
    for (const [term, value, sub] of entries) {
      const detail = make("dd", { text: value });
      if (sub) detail.append(make("span", { class: "sub", text: sub }));
      facts.append(make("div", {}, [make("dt", { text: term }), detail]));
    }
  }

  /* Supplier bars */

  function renderSuppliers(rows) {
    const container = $("suppliers");
    const suppliers = A.spendBySupplier(rows, 8);
    if (suppliers.length === 0) {
      container.replaceChildren(make("p", { class: "empty", text: "No data for these filters. Change a filter to see suppliers." }));
      return;
    }
    const max = suppliers[0].total;
    const items = suppliers.map((s) =>
      make("li", {}, [
        make("span", { class: "bar-label", title: s.supplier, text: s.supplier }),
        make("div", { class: "bar-track", role: "img", "aria-label": `${s.supplier}: ${Math.round(s.share * 100)}% of spend` }, [
          make("div", { class: "bar-fill", style: `width: ${((s.total / max) * 100).toFixed(1)}%` }),
        ]),
        make("span", { class: "bar-value", text: A.formatEUR(s.total, { compact: true }) }),
      ])
    );
    container.replaceChildren(make("ul", { class: "bars" }, items));
  }

  /* Monthly chart */

  function niceCeil(value) {
    if (value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    const fraction = value / power;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * power;
  }

  function renderMonthly(rows) {
    const container = $("monthly");
    const months = A.monthlySpend(rows);
    if (months.length === 0) {
      container.replaceChildren(make("p", { class: "empty", text: "No data for these filters. Change a filter to see monthly spend." }));
      return;
    }

    const width = 640;
    const height = 280;
    const margin = { top: 12, right: 8, bottom: 30, left: 56 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const top = niceCeil(Math.max(...months.map((m) => m.total)));
    const slot = plotWidth / months.length;
    const barWidth = Math.max(2, slot * 0.7);
    const peak = months.reduce((best, m) => (m.total > best.total ? m : best), months[0]);
    const y = (value) => margin.top + plotHeight - (value / top) * plotHeight;

    const parts = [];
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = (top / 4) * tick;
      parts.push(svg("line", { class: "grid-line", x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value) }));
      parts.push(svg("text", { class: "axis-text", x: margin.left - 8, y: y(value) + 4, "text-anchor": "end" }, A.formatEUR(value, { compact: true, trim: true })));
    }

    const labelEvery = Math.ceil(months.length / 8);
    months.forEach((m, index) => {
      const x = margin.left + index * slot + (slot - barWidth) / 2;
      const barHeight = (m.total / top) * plotHeight;
      const noun = m.count === 1 ? "procurement" : "procurements";
      parts.push(
        svg("rect", {
          class: m === peak ? "bar-month peak" : "bar-month",
          x,
          y: y(m.total),
          width: barWidth,
          height: Math.max(barHeight, m.total > 0 ? 1 : 0),
        }, svg("title", {}, `${monthLabel(m.month, "long")}: ${A.formatEUR(m.total)} (${m.count} ${noun})`))
      );
      if (index % labelEvery === 0) {
        parts.push(svg("text", { class: "axis-text", x: x + barWidth / 2, y: height - 8, "text-anchor": "middle" }, monthLabel(m.month)));
      }
    });

    const description = `Monthly spend from ${monthLabel(months[0].month, "long")} to ${monthLabel(months[months.length - 1].month, "long")}. Highest month: ${monthLabel(peak.month, "long")}, ${A.formatEUR(peak.total, { compact: true })}.`;
    const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": description }, parts);
    container.replaceChildren(
      chart,
      make("p", { class: "chart-note", text: `Highest month: ${monthLabel(peak.month, "long")}, ${A.formatEUR(peak.total, { compact: true })}. Hover over a bar for details.` })
    );
  }

  /* Table */

  function renderTable(rows) {
    const table = $("table");
    if (rows.length === 0) {
      table.replaceChildren(make("caption", { class: "empty", text: "No procurements match these filters." }));
      return;
    }

    const headers = COLUMNS.map((column) => {
      const active = state.sort.key === column.key;
      const button = make("button", { type: "button", text: column.label });
      button.addEventListener("click", () => {
        state.sort = {
          key: column.key,
          direction: active && state.sort.direction === "desc" ? "asc" : "desc",
        };
        renderTable(rows);
      });
      const attributes = { scope: "col" };
      if (column.numeric) attributes.class = "num";
      if (active) attributes["aria-sort"] = state.sort.direction === "asc" ? "ascending" : "descending";
      return make("th", attributes, button);
    });

    const body = A.sortRows(rows, state.sort.key, state.sort.direction)
      .slice(0, TABLE_ROWS)
      .map((row) =>
        make("tr", {}, [
          make("td", { text: row.date }),
          make("td", { text: row.supplier }),
          make("td", { text: row.category }),
          make("td", { text: row.department }),
          make("td", { class: "num", text: A.formatEUR(row.amount) }),
          make("td", { class: "num", text: String(row.days) }),
        ])
      );

    table.replaceChildren(
      make("caption", { class: "visually-hidden", text: `The ${body.length} procurements selected, sorted by ${state.sort.key}.` }),
      make("thead", {}, make("tr", {}, headers)),
      make("tbody", {}, body)
    );
  }

  /* Wiring */

  function render() {
    const rows = A.filterRows(state.rows, state.filters);
    renderSummary(rows);
    renderSuppliers(rows);
    renderMonthly(rows);
    renderTable(rows);
  }

  function setData(rows, label) {
    state.rows = rows;
    state.filters = { year: "all", department: "all", category: "all" };
    $("dataset-label").textContent = `${label}: ${rows.length} procurement records`;
    fillFilters();
    render();
  }

  function handleFile(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showMessage("The file could not be read. Try again or choose another file.");
    reader.onload = () => {
      try {
        setData(A.parseProcurements(reader.result), file.name);
        showMessage("");
      } catch (error) {
        showMessage(`${error.message} The previous data is still shown.`);
      }
      input.value = "";
    };
    reader.readAsText(file);
  }

  function init() {
    for (const { id, key } of FILTERS) {
      $(id).addEventListener("change", (event) => {
        state.filters[key] = event.target.value;
        render();
      });
    }
    $("reset-filters").addEventListener("click", () => {
      state.filters = { year: "all", department: "all", category: "all" };
      fillFilters();
      render();
    });
    $("csv-input").addEventListener("change", handleFile);

    try {
      setData(A.parseProcurements(window.SAMPLE_CSV), "Sample data (synthetic)");
    } catch (error) {
      showMessage(`The sample data could not be loaded: ${error.message}`);
    }
  }

  init();
})();
