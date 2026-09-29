"use strict";

class RedactionError extends Error {}
const EXTENSIONS = new Set([
  ".xlsx",
  ".csv",
  ".tsv",
  ".txt",
  ".md",
  ".log",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
]);
const LIMIT = 40 * 1024 * 1024;
function validateSchema(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 32768)
    throw new RedactionError("Supply a JSON schema of at most 32 KiB.");
  let schema;
  try {
    schema = JSON.parse(input);
  } catch {
    throw new RedactionError("The schema must be valid JSON.");
  }
  const keys = (object, allowed) =>
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).every((key) => allowed.includes(key));
  if (
    !keys(schema, ["version", "rules"]) ||
    schema.version !== 1 ||
    !Array.isArray(schema.rules) ||
    !schema.rules.length ||
    schema.rules.length > 32
  )
    throw new RedactionError("Use schema version 1 with 1–32 rules.");
  const prefixes = new Map();
  for (const rule of schema.rules) {
    if (
      !keys(rule, [
        "field",
        "prefix",
        "scope",
        "sheet",
        "column",
        "startRow",
        "endRow",
        "pattern",
        "flags",
        "capture",
      ]) ||
      typeof rule.field !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(rule.field) ||
      typeof rule.prefix !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,19}$/.test(rule.prefix) ||
      !["text", "column"].includes(rule.scope)
    )
      throw new RedactionError(
        "Each rule needs a field, uppercase replacement prefix, and text or column scope.",
      );
    if (prefixes.has(rule.field) && prefixes.get(rule.field) !== rule.prefix)
      throw new RedactionError(
        "Rules for the same field must use the same prefix.",
      );
    prefixes.set(rule.field, rule.prefix);
    if (
      rule.sheet !== undefined &&
      (typeof rule.sheet !== "string" || !rule.sheet || rule.sheet.length > 100)
    )
      throw new RedactionError("Sheet must be a worksheet name.");
    if (
      rule.scope === "column" &&
      (typeof rule.column !== "string" || !/^[A-Z]{1,3}$/.test(rule.column))
    )
      throw new RedactionError("Column rules need a column letter, such as B.");
    if (rule.scope === "text" && rule.column !== undefined)
      throw new RedactionError("Only column rules may specify a column.");
    for (const key of ["startRow", "endRow"])
      if (
        rule[key] !== undefined &&
        (!Number.isInteger(rule[key]) || rule[key] < 1 || rule[key] > 1048576)
      )
        throw new RedactionError(
          "Row bounds must be positive worksheet row numbers.",
        );
    if (
      rule.endRow !== undefined &&
      rule.endRow < (rule.startRow ?? (rule.scope === "column" ? 2 : 1))
    )
      throw new RedactionError("The ending row must follow the starting row.");
    if (rule.pattern === undefined) {
      if (
        rule.scope !== "column" ||
        rule.flags !== undefined ||
        rule.capture !== undefined
      )
        throw new RedactionError(
          "Text rules need a pattern. Capture and flags require a pattern.",
        );
    } else {
      if (
        typeof rule.pattern !== "string" ||
        !rule.pattern ||
        rule.pattern.length > 1000 ||
        typeof (rule.flags ?? "") !== "string" ||
        !/^(?!.*(.).*\1)[imsu]*$/.test(rule.flags ?? "") ||
        (rule.capture !== undefined &&
          (!Number.isInteger(rule.capture) ||
            rule.capture < 0 ||
            rule.capture > 20))
      )
        throw new RedactionError(
          "Use a pattern of at most 1,000 characters, flags i/m/s/u, and capture group 0–20.",
        );
      try {
        new RegExp(rule.pattern, `gd${rule.flags || ""}`);
      } catch {
        throw new RedactionError("A regular expression is invalid.");
      }
    }
  }
  return schema;
}
module.exports = { validateSchema, RedactionError, EXTENSIONS, LIMIT };
