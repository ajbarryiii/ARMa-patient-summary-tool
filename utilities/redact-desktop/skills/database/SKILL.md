---
name: database
description: Inspect an operator-selected redacted report and convert it to SQLite using the operator's description of the source and desired database layout.
---

# Database

For a conversion, the operator describes a permitted report and the desired database structure. For follow-up questions, inspect the existing database or source and answer directly; do not start another conversion unless requested. Inspect it before deciding how to convert it. Formats vary: do not assume this report uses the columns, sheets, or patient boundaries of an earlier report. If the description leaves an essential relationship ambiguous, ask a focused question in chat. No manual review or approval step is required.

1. Use `report_sql` to inspect `source_sheets` and representative `source_rows`, including headers, record boundaries, and totals. Read more wherever the layout changes. Use `open_report` to select another permitted report or an existing SQLite file when needed.
2. Write SQL to create the requested tables from those source rows. Choose the schema and extraction logic after inspection. For patient events, attach the explicit patient/member and employer context to each event, including group deductible and contract period where present. Use a source-block key when there is no patient ID; matching names and blank cells alone do not establish identity. Follow the operator's stated grouping rules.
3. Preserve identifiers, missing values, signed amounts, and source sheet/row evidence. Use integer cents for money. Exclude subtotals from event tables; preserve group information even on sheets without events. Keep original codes and any recorded descriptions. Always enrich every CPT/HCPCS and ICD-10-CM code with the bundled `code_lookup` descriptions, status, and reference ID, using its service date. Keep a plaintext description column next to each original code. Medicare procedure references supply the CPT field descriptions. Revenue codes remain a separate system. Unknown codes retain NULL descriptions and an explicit status; never invent descriptions or diagnoses. A lookup returns one object, so enrichment must never multiply financial rows.
4. Query the result to check row coverage, patient links, duplicate observations, and sums against available source totals. Investigate discrepancies. Report missing or unresolved information honestly. Keep any useful checks or exceptions in the database.
5. Include all requested information, including records for employers/sheets with no events, before calling `save_database`. Do not publish an incomplete subset and ask the operator to start again. Call `save_database` with every required output table name once the conversion checks pass. It saves a new SQLite file directly in `redacted/`, without a review screen. Report its path, event count, and material exceptions. Do not claim completion until the tool confirms the save.

## Local SQL tools

`report_sql` runs SQLite SQL in a temporary in-memory database. It supports queries and creating/updating output tables, not shell commands or JavaScript. Results are bounded; query counts and targeted samples instead of dumping entire sheets. Follow-up turns reopen the latest saved database, or the selected report when nothing has been saved. Use `open_report(path)` to switch files; this discards unsaved in-memory tables, so finish necessary saves first. Within a turn, queries and corrections remain available after saving.

- `open_report(path)` opens a permitted workspace report or SQLite file. Existing databases retain their stored schema; inspect `sqlite_master` before querying. Queries operate on a copy; saving creates a new file and leaves existing files unchanged.
- `source_sheets(sheet TEXT, position INTEGER, metadata_json TEXT)`: sheet names/order and workbook metadata, including merges, date system, and number formats.
- `source_rows(sheet TEXT, row INTEGER, cells_json TEXT, types_json TEXT)`: every populated source row, with Excel column letters as JSON keys. Values are original text, including numeric decimal text and date serials. `types_json` records cell types, styles, and formulas. CSV/TSV uses the same letter keys. Formula values are saved caches, never recalculated.
- Read a value with `json_extract(cells_json, '$.B')`. Do not modify source tables. `save_database` copies only the named ordinary output tables plus app-owned provenance into a fresh database; sources remain available during the turn.
- `money_cents(text)` converts a decimal amount exactly, preserving its sign and returning NULL for blanks. It rejects nonzero fractional cents and unsafe integer sizes instead of rounding.
- `excel_date(serial, date1904)` converts an Excel date to ISO text. Use the sheet's recorded date system.
- `regexp_extract(text, pattern, group)` returns a regex match/group or NULL. Patterns are bounded and run inside the cancellable worker.
- `code_lookup(system, code, service_date)` returns JSON with `description`, `system`, `code`, `status`, and `reference_id`. Systems: `cpt`, `hcpcs`, `icd` (ICD-10-CM), `revenue`. Extract fields with `json_extract`. Use ISO service dates or NULL when absent. References cover April 2025–September 2026; preserve flags for missing dates, out-of-period dates, category headers, codes absent from that date’s reference, and unknown codes. Lookup normalizes codes only for matching; preserve original report codes.
- `save_database` takes `tables` (an array of table names). Use materialized tables, not views requiring source tables or custom SQL functions.

Normal chat also provides guarded text-file and directory tools; every path is checked by the app. The agent has no shell or unrestricted filesystem/network access. Code descriptions come from bundled official CMS references; the saved database includes their source URLs, versions, and checksums.
