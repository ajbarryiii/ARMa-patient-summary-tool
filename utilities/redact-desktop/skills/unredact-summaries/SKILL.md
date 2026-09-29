---
name: unredact-summaries
description: Generate and run a local tool to restore identities in selected patient Word summaries from operator-selected redaction mapping CSVs, saving separate private Word copies.
---

# Unredact summaries

The operator selects a redacted patient-summary folder and its mapping CSVs in the app. Generate the restoration tool by submitting this declarative plan to `run_unredaction_script`:

```json
{"version":1,"operation":"restore_patient_summaries","token_column":"replacement","original_column":"original"}
```

Pass the JSON as the tool's `schema_json` string. The app generates a runnable `unredact.cjs` from the validated plan, executes its trusted local restoration implementation, and saves new Word copies in a new set under `unredacted/Patient Summaries/`. The script, plan, and private source audit accompany the copies. Report the confirmed folder and document count only after the tool returns `saved`. One execution is allowed per message; a retry needs another operator message and creates a separate set.

The CSV headers are `field,original,replacement,occurrences`:
- `field`: redaction rule field label.
- `original`: original private text, used only by the local restoration tool.
- `replacement`: exact redacted token to reverse.
- `occurrences`: count from source redaction, not a financial or restoration count.

The same schema is documented in `unredacted/Mapping CSV columns.md`. Do not read that folder or request mapping values in chat. Only the fixed schema, selected document/mapping counts, and count-only results are available to you. You have no file, SQL, shell, or network tools in this workflow. Do not attempt to create executable source code, choose other paths, request private documents, or reconstruct identities yourself.

Restoration is literal and simultaneous, including tokens split across Word text runs. It preserves Word formatting and all source files. Missing token mappings, conflicting originals for one token, modified selections, linked files, or invalid CSVs fail without publishing a partial set. If a selection fails, explain the safe tool error and direct the operator to choose the correct summary folder and its mapping CSVs locally. Do not combine unrelated client or supplier mappings. Already selected inputs and the operator's request authorize this local restoration; no additional approval is required.
