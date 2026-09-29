"use strict";
// Trusted interpreter: model output is declarative data, never JavaScript.
const { parentPort, workerData } = require("node:worker_threads");
const { randomBytes } = require("node:crypto");
const { redactXlsx } = require("./xlsx-redaction.cjs");
const {
  validateSchema,
  RedactionError,
  LIMIT,
} = require("./redaction-schema.cjs");
const columnName = (value) => {
  let result = "";
  while (value) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
};
const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;

function transformer(schema) {
  const mapping = new Map();
  let items = 0;
  const rules = schema.rules.map((rule) => ({
    ...rule,
    regex:
      rule.pattern === undefined
        ? null
        : new RegExp(rule.pattern, `gd${rule.flags || ""}`),
  }));
  return {
    get items() {
      return items;
    },
    csv() {
      return (
        require("./mapping-format.cjs").HEADERS.join(",") + "\r\n" +
        [...mapping.values()]
          .map((item) =>
            [item.field, item.original, item.replacement, item.occurrences]
              .map(quote)
              .join(","),
          )
          .join("\r\n") +
        "\r\n"
      );
    },
    transform(value, context = {}) {
      if (!value) return value;
      const spans = [];
      for (const rule of rules) {
        if (rule.sheet && rule.sheet !== context.sheet) continue;
        if (rule.scope === "column" && rule.column !== context.column) continue;
        if (
          context.row &&
          (context.row < (rule.startRow ?? (rule.scope === "column" ? 2 : 1)) ||
            context.row > (rule.endRow ?? Infinity))
        )
          continue;
        if (
          !context.row &&
          (rule.scope === "column" ||
            rule.sheet ||
            rule.startRow ||
            rule.endRow)
        )
          continue;
        if (!rule.regex) {
          spans.push({ start: 0, end: value.length, rule });
          continue;
        }
        rule.regex.lastIndex = 0;
        let match;
        while ((match = rule.regex.exec(value))) {
          const range = match.indices[rule.capture ?? 0];
          if (range && range[1] > range[0])
            spans.push({ start: range[0], end: range[1], rule });
          if (spans.length + items > 100000)
            throw new RedactionError(
              "A run is limited to 100,000 replacements.",
            );
          if (!match[0].length)
            rule.regex.lastIndex =
              match.index +
              (rule.regex.unicode && value.codePointAt(match.index) > 0xffff
                ? 2
                : 1);
        }
      }
      spans.sort((a, b) => a.start - b.start || a.end - b.end);
      let cursor = 0,
        result = "";
      for (const span of spans) {
        if (span.start < cursor)
          throw new RedactionError(
            "Redaction rules overlap. Use separate, non-overlapping field captures.",
          );
        const original = value.slice(span.start, span.end),
          key = JSON.stringify([span.rule.field, original]);
        let replacement = mapping.get(key);
        if (!replacement) {
          replacement = {
            field: span.rule.field,
            original,
            replacement: `${span.rule.prefix}_${randomBytes(8).toString("hex").toUpperCase()}`,
            occurrences: 0,
          };
          mapping.set(key, replacement);
        }
        replacement.occurrences++;
        if (++items > 100000)
          throw new RedactionError("A run is limited to 100,000 replacements.");
        result += value.slice(cursor, span.start) + replacement.replacement;
        cursor = span.end;
      }
      return result + value.slice(cursor);
    },
  };
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [],
    value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (character === '"') {
        quoted = false;
        closed = true;
      } else value += character;
    } else if (character === '"' && !value && !closed) quoted = true;
    else if (character === delimiter) {
      row.push(value);
      value = "";
      closed = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      closed = false;
    } else {
      if (closed || character === '"')
        throw new RedactionError("This delimited file has invalid quoting.");
      value += character;
    }
  }
  if (quoted)
    throw new RedactionError(
      "This delimited file has an unfinished quoted field.",
    );
  if (value || row.length || closed) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

async function redact({ bytes, extension, schema: input }) {
  const schema = validateSchema(JSON.stringify(input)),
    transform = transformer(schema);
  let output;
  if (extension === ".xlsx")
    output = await redactXlsx(Buffer.from(bytes), transform, schema);
  else {
    const data = Buffer.from(bytes);
    if (data.includes(0))
      throw new RedactionError("Only UTF-8 text is supported.");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        data,
      );
    } catch {
      throw new RedactionError("Save the text file as UTF-8 first.");
    }
    const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
    text = text.slice(bom.length);
    if (extension === ".csv" || extension === ".tsv") {
      const delimiter = extension === ".csv" ? "," : "\t",
        newline = text.includes("\r\n") ? "\r\n" : "\n";
      const rows = parseDelimited(text, delimiter);
      if (rows.reduce((sum, row) => sum + row.length, 0) > 300000)
        throw new RedactionError("Redaction is limited to 300,000 cells.");
      if (schema.rules.some((rule) => rule.sheet))
        throw new RedactionError(
          "CSV and TSV rules must not specify a worksheet name.",
        );
      output = Buffer.from(
        bom +
          rows
            .map((row, r) =>
              row
                .map((value, c) =>
                  quote(
                    transform.transform(value, {
                      row: r + 1,
                      column: columnName(c + 1),
                    }),
                  ),
                )
                .join(delimiter),
            )
            .join(newline) +
          (/[\r\n]$/.test(text) ? newline : ""),
      );
    } else {
      if (
        schema.rules.some(
          (rule) =>
            rule.scope === "column" ||
            rule.sheet ||
            rule.startRow ||
            rule.endRow,
        )
      )
        throw new RedactionError(
          "Use text patterns without worksheet or column settings for text files.",
        );
      output = Buffer.from(bom + transform.transform(text));
    }
  }
  if (output.length > LIMIT)
    throw new RedactionError("The redacted copy exceeds the 40 MiB limit.");
  return { bytes: output, mapping: transform.csv(), items: transform.items };
}
if (parentPort)
  redact(workerData)
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) =>
      parentPort.postMessage({
        error:
          error instanceof RedactionError
            ? error.message
            : "This document could not be redacted. Check the file locally and try a simpler copy.",
      }),
    );
module.exports = { redact, parseDelimited };
