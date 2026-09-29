---
name: redact
description: Generate and run a local regex redaction script for an operator-selected Excel, CSV, TSV, or text document without receiving the original document or private mapping.
---

# Redact

The operator has selected one source file locally. Only its filename and the operator's description are available to you. Never ask to read, upload, paste, summarize, inspect, or sample the original or mapping. Ask for column letters, optional sheet names, row bounds, or a synthetic pattern if the description is ambiguous. Do not infer patient identity from matching names or row positions.

Translate the description into the declarative JSON schema below. Call `run_redaction_script` with `schema_json` containing that JSON. The app generates a reproducible `redact.cjs` script and executes its validated rules with its bundled local runner. Do not write arbitrary JavaScript, shell commands, filenames, or replacement functions into the schema. You have no general file or shell tools during this workflow.

The selected file is bound by the app; the tool cannot select another file. It can run once per operator message. Do not probe the original by trying successive patterns. If the tool reports zero matches or a problem requiring changed rules, explain it and let the operator submit another description. Invalid schemas can be corrected before execution.

XLSX redaction has no fixed cell-count limit. File-size and worker resource limits still apply; CSV/TSV has a 300,000-cell limit. Narrowing the regex, column, or row scope does not reduce the size of the workbook being parsed. Report the current tool result accurately rather than repeating an earlier failure from conversation history. Follow the application's error guidance rather than claiming that different rules will fix memory failures.

## Schema

```json
{
  "version": 1,
  "rules": [
    { "field": "member_id", "prefix": "MEMBER", "scope": "column", "column": "B", "startRow": 2 }
  ]
}
```

- `field`: ASCII identifier for a mapping category, at most 40 characters.
- `prefix`: uppercase letters/digits/underscores starting with a letter, at most 20 characters. The runner appends a random token. The same exact original value for the same field gets the same replacement within a run; this is value substitution, not identity resolution.
- `scope`: `column` or `text`. Column rules use a letter such as `B` or `AA`, never a header lookup. By default they skip row 1. `startRow` and `endRow` are optional inclusive bounds.
- `sheet`: optional exact worksheet name for XLSX. Omit to apply across sheets. Never invent a sheet name; ask the operator if needed.
- `pattern`: regex source without `/` delimiters. Required for text rules; optional for column rules, which otherwise replace each nonempty cell entirely.
- `flags`: optional `i`, `m`, `s`, or `u`. Matching is always global.
- `capture`: optional numeric capture group to replace, default `0` for the whole match. Keep surrounding labels and punctuation outside the selected group. Rules must not overlap.

For a synthetic row such as `Employee: Example Person (EX123)` or `Member: Example Person (EX123)`, separate names and IDs:

```json
{
  "version": 1,
  "rules": [
    { "field": "name", "prefix": "PERSON", "scope": "text", "pattern": "(?:Employee|Member):[ \\t]*([^\\r\\n(]+?)[ \\t]*\\(", "capture": 1 },
    { "field": "member_id", "prefix": "MEMBER", "scope": "text", "pattern": "(?:Employee|Member):[^\\r\\n(]*\\(([^)\\r\\n]+)\\)", "capture": 1 }
  ]
}
```

Text rules operate within individual spreadsheet cells or across a UTF-8 text file. They do not join cells or infer continuation. CSV/TSV column rules use column letters without a sheet name. Standalone text files accept text rules only, without sheet or row settings. Maximum 32 rules; patterns are bounded and runs time out. XLSX cell styles and workbook structure are retained; replaced rich-text cells become plain replacement text with their cell style. Formula caches are cleared. Older XLS and XLSM files must first be saved locally as plain XLSX. PDF redaction is outside this workflow.

## Results

The tool returns only a replacement occurrence count, the selected filename, and `review_required`. It never returns matched strings, snippets, mapping values, or document contents. Report the actual tool result concisely: **“<n> items redacted from <file>. Ready for local review.”** Do not claim success without a successful tool result, or imply that every sensitive value was found.

The source is unchanged. The generated copy, schema, runnable script, and mapping CSV stay in a private run folder under `unredacted/`. The operator can optionally review the copy locally and uses **Move to Redacted** to put it in `redacted/`. The mapping stays private. Never publish, read, or validate the output yourself. The operator must explicitly use **Move to Redacted** before either provider can access the redacted values; opening the review copy first is optional.

Require the local runner to create `redacted/mapping-columns.md` for the agent that will later write an unredaction script. Its entire contents must be the mapping CSV's column headings in their original order: `field,original,replacement,occurrences`, followed by a newline. Include no title, explanation, examples, mapping rows, values, or other information. Use this fixed schema without opening the private mapping CSV; the later agent must also have no access to that CSV. This file must be written locally, since this skill has no general file-writing capability; do not claim it was created unless the application confirms creation.
