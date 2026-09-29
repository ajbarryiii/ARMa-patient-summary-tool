# ARMa desktop

A small Electron interface around Claude Code and a development-only Codex connection. The renderer is plain HTML, CSS, and JavaScript; the main process owns native dialogs, files, and provider processes. No Python backend, Docker, local HTTP server, or frontend build step is required.

## Run

Use Node.js 22.12 or newer on macOS. Other desktop platforms have not been verified.

```sh
npm ci
npm start
```

Run these commands from `utilities/redact-desktop`. Quit and restart after source changes. Windows test installers can be built as described below. Automatic updates are not provided.

Run `npm ci` for initial setup or after dependency changes. For subsequent launches, just use `npm start`. From the repository root, use `npm --prefix utilities/redact-desktop start`.

Installation currently prints deprecation warnings for `inflight`, `rimraf`, `lodash.isequal`, `glob`, and `fstream`. These are indirect dependencies of ExcelJS 4.4.0, its latest published release when checked. They do not by themselves indicate an installation or startup failure. The dependency audit on September 23, 2026 reported no known vulnerabilities; deprecation and vulnerability reports are separate. Do not force major dependency overrides just to hide these warnings.

Claude Code 2.1.280 is a runtime dependency; Codex 0.156.1 is pinned as a development dependency. The connection checks these versions because its restricted capability configuration depends on their CLI interfaces. Electron is pinned to 44.4.5.

Open **Connections → Sign in to Claude** and finish authentication in your default browser. ARMa runs the bundled Claude sign-in process without a terminal window and updates to **Signed in** after the process completes and its saved authentication status is checked. **Open browser again**, **Cancel**, and **Use a sign-in code** handle interrupted browser flows. The client build opens Connections on first launch when Claude is not signed in. The CLI command `npx --no-install claude auth login` remains available for development troubleshooting.

For Codex testing:

```sh
npx --no-install codex -c 'cli_auth_credentials_store="file"' login
```

The composer has **Model** and **Reasoning effort** selectors. The model menu groups Claude and development-only Codex models; selecting a model also selects its provider. Claude offers the CLI default and Sonnet, Opus, and Haiku aliases. Codex loads its model names and supported effort levels from the installed runtime's authenticated catalog, including its recommended defaults. Models without effort controls show **Automatic**. **Default** leaves effort to the provider. These selections apply to ordinary messages and redaction, remain fixed during a turn, and are remembered locally across app restarts. Switching models within a provider preserves that conversation; switching providers retains separate conversations.

Use **Refresh** in Connections to reload the Codex catalog after signing in or changing account access. If the catalog cannot load, the app offers **Codex default** and shows the issue in Connections. Catalog discovery sends no workspace files or prompts and does not start an inference turn. Model access and effective effort still depend on the provider account and any provider-side limits.

Connections reports Claude's saved sign-in status; it does not verify subscription access or perform an inference request. Authentication errors can still appear in the conversation. Claude owns browser authentication, its loopback callback, and its native credential storage. The optional one-time sign-in code goes through the child process's stdin and is never saved by ARMa. Raw authentication output and authorization URLs stay in main-process memory and are not logged, sent to the renderer, or added to conversations. The sign-in process uses an empty temporary working directory, disables hooks and user/project settings, has no workspace tools, and is stopped on cancellation, timeout, or application exit. Codex reads the existing CLI cache locally and forwards only the access token in memory to its temporary runtime; it does not copy the cache or use the refresh token. If authentication expires, use **Sign in again** for Claude or the CLI for development Codex.

Native desktop notifications announce completed Claude and Codex queries, including redaction and database turns, whether ARMa is focused or in the background. Failed queries show a distinct failure notification; **Stop**, workspace changes, and quitting do not send completion notifications. Banners contain only the provider and outcome, never prompts, responses, filenames, workspace paths, or error details. Clicking one restores and focuses ARMa. The latest notification replaces the previous one.

On macOS, `npm start` checks the local Electron bundle's signature and applies an ad-hoc signature when needed, because Electron 44 requires a signed bundle for notifications. This affects only the installed development dependency, uses no certificate or developer account, and is repeated when needed after `npm ci`. Allow notifications when macOS asks; repository runs may appear as **Electron** in System Settings → Notifications. On Windows, the app sets a stable application identity before Electron registers its per-user notification shortcut and activator. Windows delivery has not been tested on hardware. System notification settings and Focus/Do Not Disturb control banner delivery on both platforms. Notification failures never interrupt a query.

`npm ci --omit=dev` installs only application dependencies: it excludes Codex, Electron's development launcher, the builder, and the smoke-test dependency. Use a full `npm ci` to run from source. `ARM_ENABLE_CODEX=0 npm start` hides and disables Codex; packaged apps disable it regardless of that variable.

## macOS test disk image

Build on macOS with Node.js 22.13 or newer:

```sh
npm ci
npm run build:mac:all
npm run verify:mac
npm run verify:mac -- --x64
```

The output is `dist/ARMa-0.2.2-mac-arm64-test.dmg`, for Apple Silicon Macs, and `dist/ARMa-0.2.2-mac-x64-test.dmg` for Intel Macs, each with a SHA-256 sidecar and architecture-specific package manifest. Both builds require macOS 13 Ventura or newer. Open the DMG and drag ARMa to Applications. Check Apple menu → About This Mac: an Apple M-series chip uses arm64; an Intel processor uses x64. `build:mac` builds only Apple Silicon; `build:mac:intel` builds only Intel.

The application is ad-hoc signed, without an Apple Developer ID or notarization. To test downloaded installation, upload the DMG to your file-sharing service and download it through a browser on another Mac. After attempting to launch the installed app, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks it as an unidentified developer. Do not disable Gatekeeper globally. Direct DMG distribution does not require App Store review; verified distribution would require Developer ID signing and Apple notarization.

The Mac build uses the same application allowlist and dependency pruning as Windows, with a locked native Claude runtime matching each target architecture. Tests, development tools, Codex, source maps, credentials, sessions, and workspaces are excluded. License notices remain. Verification checks the runtime architecture, payload contents, application signature, and disk-image checksum. The packager restores Claude's Mach-O binary after packing because its upstream filename ends in `.exe`, which macOS packaging otherwise filters.

For the packaged workflow smoke, copy the app out of the DMG to a temporary folder outside the checkout, then run `ARM_TEST_MAC_BUNDLE="/absolute/path/ARMa.app" node tests/smoke.packaged.electron.cjs`. Set `ARM_TEST_MAC_ARCH=x64` for an Intel bundle. This launches the actual packaged executable and tests synthetic XLSX/PDF previews, local workers, SQLite, patient summaries, and restored Word exports. Live Claude sign-in and another Mac's Gatekeeper/download behavior require separate manual checks.

## Windows test installer

Build with Node.js 22.13 or newer from this directory:

```sh
npm ci
npm run build:win
npm run verify:win
node tests/smoke.packaged.electron.cjs
```

The output is `dist/ARMa-0.2.2-windows-x64-test-setup.exe`, with a SHA-256 sidecar and `windows-package-manifest.json`. Send the setup EXE; the staging folder and `win-unpacked/` are build outputs, not additional downloads. This unsigned test build targets Windows 10 1809+ and Windows 11 on x64. Windows installation, authentication, and native behavior must still be checked on a Windows machine; the packaged-payload smoke on macOS does not establish Windows compatibility. Windows may show an unknown-publisher/SmartScreen warning because this test installer is unsigned.

Windows builds use software rendering from startup, including when opened from Start or the desktop. A Windows 11 test laptop opened successfully after terminating stuck ARMa processes and launching with `--disable-gpu`; the default now uses that graphics setting without requiring shortcut edits. This does not establish graphics acceleration as the sole cause of the earlier failure. macOS rendering is unchanged. Run `node tests/smoke.packaged.electron.cjs --disable-gpu` to check the packaged spreadsheet/PDF viewers and local workflows with software rendering on the build host.

The per-user installer includes Electron and the pinned Windows Claude binary. The recipient does not need Node.js, npm, Python, Docker, or a separately installed Claude CLI. Open **ARMa**, choose **Sign in to Claude** in Connections, and finish browser sign-in. No terminal or manual refresh is needed. No login or credential cache is included in the package. A Claude account with Claude Code access and internet connectivity are required. **ARMa - Windows test guide** in Start contains the test instructions and current data-handling limits. Uninstall retains workspaces and saved application data. Upgrading removes the old terminal sign-in shortcut and helper.

`scripts/build-windows.cjs` copies an explicit application-file allowlist into `dist/windows-stage/`, installs production dependencies from the lockfile for Windows x64 with install scripts disabled, and places the verified Windows executable instead of the build host's Claude binary. It removes duplicate/platform binaries, development dependencies, tests, fixtures, examples, documentation directories, source maps, type declarations, and unused browser/debug builds. It retains runtime PDF fonts/CMaps/WASM, SQLite WASM, bundled skills/reference data, and license/attribution files. Codex and `codex-runtime.cjs` are excluded. Originals, mappings, saved sessions, credentials, and repository workspaces are never staging inputs.

The build verifies the staged and packaged file lists and PE architecture, and writes hashes of the final runtime payload. Runtime files remain unpacked because the worker and stdio adapters execute real filesystem paths. A small NSIS include manages the guide shortcut and removes the obsolete terminal sign-in helper. Rebuild from source to update the application or pinned Claude runtime; there is no automatic update service.

## Workspace

**Open folder** selects an existing directory. **New workspace** uses the native dialog to choose the name and location of a new directory. Both ensure `unredacted/` and `redacted/` exist and leave existing contents intact. Creating a workspace never replaces an existing directory. A directory inside an existing `unredacted/` tree cannot be used as a workspace.

Click a folder to expand or collapse it and select it as the import destination. **Add files** copies selected files or folders there; the initial destination is `unredacted/`. Drag files or folders from Finder onto any folder row to copy them into that exact folder. Duplicate names get a numeric suffix, and source files stay in place. Symbolic links and special files are rejected. Imports are limited to 10,000 entries at a time.

Right-click a sidebar item (Control-click on macOS), or left-click its **⋯** icon, for **Rename**, **Move to**, **New folder** on directories, and **Reveal**. Move destinations must be inside the current workspace. Drag a file or folder between sidebar folders to move it; external drops still copy. Moves and renames reject name collisions rather than replacing files. F2 opens Rename, and Shift+F10 opens the menu. Previews and expanded folders follow moved items.

File edits are available when no agent turn or import is running. Workspace roots, the `redacted/` and `unredacted/` folders, and saved private redaction artifacts cannot be moved or renamed. Users can manually drag files or folders from `unredacted/` into `redacted/` or its subfolders, or use **Move to**. This moves the existing content unchanged and makes it available to agent tools; it does not run redaction. **Move to Redacted** on a redaction result remains available for publishing a generated copy. After a filesystem edit, reselect any redaction or database source before starting another turn. Moving or renaming an original referenced by a previous redaction run requires a new run before publishing; historical records stay unchanged.

Right-click or Control-click chat text for native editing commands. The message **⋯** menu copies the selected text, or selects the whole message when nothing in it is selected. The composer **⋯** menu offers cut, copy, paste, undo, redo, and select all without shortcuts. Ordinary left clicks retain the usual text-selection behavior.

Click files for local previews, including spreadsheets and PDFs in either workspace folder. Use **Expand preview** for more space. Other formats show metadata and a **Reveal file** action; they can still be stored in the workspace. Double-click a directory or use the reveal controls to locate it in the system file manager. External file changes refresh the tree.

The sidebar hides common macOS and Windows system metadata, AppleDouble files (`._*`), `__MACOSX` folders, and Office lock files (`~$*`). This only filters the display; the files stay on disk. Other dotfiles remain visible.

Use the chat/folder icon at the top of the sidebar to switch between **Files** and **Sessions** for the open workspace. The panel icon hides the sidebar; the matching icon in the chat header brings it back. The compose icon in the chat header or Sessions list starts a **New session**, preserving earlier chats. Select a session to resume its chat, draft, and model selection. Session switching and creation are disabled during an active response or file operation; the sidebar can still be collapsed. Sidebar visibility and view are remembered.

Recent directory paths and sessions are stored locally in Electron's application-data directory. Override that directory with `ARM_USER_DATA=/absolute/disposable/path` for tests. Reopening a workspace restores its sessions, including unfinished drafts, model settings, and chat text. Each session keeps separate Claude and Codex conversations. Agent turns receive bounded prior conversation text from the same provider, workspace, session, and workflow boundary; redaction history remains separate from general chat. A response interrupted by closing the app is marked as interrupted and does not restart automatically. File selections and runtime capabilities are not saved: choose a source again after reopening before using a source-specific skill. Files are not automatically attached when imported or previewed. Session files are kept outside the workspace by default, written atomically with owner-only permissions on macOS, and limited to 32 MiB per workspace (16 MiB for displayed chats and drafts). Storage errors are shown without deleting the previous saved file.

## Document viewers

Spreadsheet previews support `.xlsx`, `.xlsm`, `.xls`, `.csv`, and `.tsv`, with sheet tabs, zoom, a cell address field, and a value/formula bar. XLSX and XLSM preserve saved fonts, colors, fills, borders, alignment, wrapping, rich text, merged cells, row heights, column widths, and number/date formats. Supported embedded bitmap images are displayed. Hidden rows, columns, and sheets remain hidden until **Show hidden** is selected. Large sheets display 200 rows and 50 columns at a time; use the arrows or enter a cell address to move through them.

Formula cells show their saved result, or formula text when no result was saved. Previews do not recalculate formulas, execute macros, or follow workbook links. Legacy XLS support preserves values, number formats, merges, and dimensions but has limited styling; save as XLSX for fuller formatting. Charts, shapes, print layouts, and conditional formatting rules are not reproduced. Missing local fonts use fallbacks, and some patterns and dimensions are approximated. This is a read-only viewer, not a complete Excel rendering engine.

PDF previews provide page navigation, fit-to-width and percentage zoom, rotation, and selectable text where the PDF contains text. Pages render locally with bundled PDF.js; document scripts and interactive links are not enabled. Password-protected files require an unlocked local copy. Scanned pages display as images without OCR.

All viewers run locally without uploading file contents or modifying the source. Viewing `unredacted/` does not grant an agent access to it. Text previews are limited to 256 KiB, images to 12 MiB, and spreadsheets/PDFs to 40 MiB per file. Workbooks are limited to 64 sheets; XLSX/XLSM archives may expand to at most 128 MiB. XLSX/XLSM previews load only the selected worksheet, preserving all sheet tabs and discarding the previous sheet's parsed cells when switching. XLSX/XLSM have no fixed cell-count ceiling; XLS/CSV/TSV previews retain their 300,000-cell limit. Workbook parsing runs in a cancellable worker with a 30-second timeout and a 256 MiB JavaScript heap limit per sheet. A particularly large individual sheet can still exceed those resource limits.

## Agent file access

Agents can list directories, read/write UTF-8 text files up to 1 MiB, create directories, open spreadsheets and SQLite databases, query them, and save new database revisions through application-owned capabilities. They cannot access any path component named `unredacted` (case-insensitive), hidden paths, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. The active app installation is also inaccessible to prevent agents from rewriting their own access controls. Symlinks, multiply linked files, path traversal, absolute paths, and special files are rejected. The GUI can still display and import into `unredacted/` locally. Agents may read and write `redacted/` through these tools without additional permission prompts.

Claude runs with built-in tools disabled, only the explicit workspace tool connection, host settings and hooks disabled, and an isolated runtime directory. Codex testing uses its pinned app-server interface with native execution environments disabled and the same bounded file capabilities. Neither provider gets a generic shell, unrestricted filesystem access, unrelated integrations, or permission-bypass flags. No workspace instructions or file contents are implicitly loaded through the runtime's working directory.

This is an application-enforced boundary, not an OS/container sandbox. It does not prevent a separate local application from modifying the workspace. Patient summaries retain redacted identifiers until **Unredact Summaries** creates separate private copies locally.

Claude connects to these file capabilities through the app's stdio MCP adapter. Codex uses app-server dynamic tools backed by the same checks; some Codex models use a bounded JavaScript transport to call them. That transport provides no host shell or direct filesystem access. Imports can be cancelled from the status bar; completed copies remain, and the current partial copy is removed.

## Redaction skill

The [redact skill](skills/redact/SKILL.md) ships with the application and works with both providers; no separate skill installation is needed. Click **Redact** below the message input to load it. Select **Choose file**, or type `@` followed by part of a filename and choose a source from `unredacted/`. The native picker copies sources outside that folder into it before selection. The filename chip identifies the selected source; selecting a file does not attach its contents to the model request.

Describe the fields using column letters and row bounds or a synthetic text pattern. For example: “Redact column B from row 2” or “Replace names and IDs in Employee: Name (ID) and Member: Name (ID) rows.” The composer uses: “What should be redacted? For example: column B, or names and IDs in ‘Employee: Name (ID)’ rows.” Avoid putting actual sensitive values into the description.

During a redaction turn, the agent receives only the selected filename, your description, the bundled skill, and prior redaction conversation context. General conversation history and all general file tools are excluded. Its only capability, `run_redaction_script`, submits a declarative regex schema for the bound source. The app creates a runnable script from that schema and runs the same validated rules through a trusted, cancellable local interpreter. Arbitrary model-authored code is never evaluated. A turn permits one execution against the source; invalid schemas can be corrected before execution. Neither provider receives original bytes, matched values, the private mapping, or candidate output. The tool returns only a replacement occurrence count, filename, and review status.

Each successful run creates an immutable source copy with substitutions, a `mapping.csv` containing `field,original,replacement,occurrences`, the schema, and a reproducible `redact.cjs` under `unredacted/redaction-runs/<run-id>/`. The original file is never changed. Each original value within a field maps to one random token for that run; tokens are not shared across runs. This is exact value substitution, not patient identity matching. The script can be rerun locally with Node.js and the application still installed; reruns create new private results.

Use **Review copy**, **Mapping CSV**, or **Script** to inspect artifacts locally. Review is optional. Once redaction finishes, **Move to Redacted** creates a uniquely named file in `redacted/` for agent access. The private review copy and mapping remain in the run folder. The result shows **In Redacted** when complete. Changes to the source, copy, mapping, schema, or script invalidate publication. Runs with no replacements cannot be published. Saved results remain available after restarting and reopening the workspace. The existing agent tools can read approved text outputs; the Database skill can inspect redacted Excel reports.

Supported inputs are XLSX, CSV, TSV, and UTF-8 `.txt`, `.md`, `.log`, `.json`, `.jsonl`, `.xml`, `.yaml`, and `.yml`. XLS and XLSM must be saved as plain XLSX first. Workbooks with macros, pivot caches, or external data links are rejected. PDF redaction and PDF-to-table conversion are outside this version.

XLSX processing changes stored cell values while preserving workbook styles, dimensions, sheet structure, and other package parts. Replaced rich-text cells retain their cell style but become plain replacement text. Formula caches are cleared so they cannot retain old substituted values; Excel recalculates them when opened. Regexes do not join cells. Comments, drawings, charts, metadata, and literal values inside untouched formulas are not redacted by cell rules, so review the full document before publishing or sharing it. CSV/TSV quoting is normalized without converting identifiers or financial values. For structured text such as JSON, rules must preserve its syntax.

Limits are 40 MiB per file, 32 rules, 1,000 characters per regex, 100,000 replacements, 64 worksheets, and 128 MiB of expanded XLSX content. XLSX redaction has no fixed cell-count ceiling: worksheets are scanned one at a time without retaining XML document trees, including when a workbook contains many formatted blank cells. CSV/TSV redaction retains a 300,000-cell limit because it currently loads all rows into memory. A worker enforces a 30-second execution limit and a 384 MiB JavaScript heap limit. **Stop** cancels active processing; completed private results remain available.

Worker failures distinguish exhausted memory from missing dependencies and unexpected crashes without exposing source contents. File-size limits apply to the whole input; selecting fewer columns, rows, or sheets does not reduce the amount of workbook XML that must be scanned. A compressed XLSX file can be small on disk but much larger when expanded. Failed runs do not change the original.

## Database skill

Click **Database**, choose a redacted XLSX, CSV, or TSV file (or use `@`), and describe both its layout and the database you want. The [bundled skill](skills/database/SKILL.md) directs the agent to inspect the actual report, choose SQL extraction logic, attach patient and employer context to events, preserve deductibles and source evidence, and check counts and financial totals. It asks a focused question when an essential relationship is unclear. Changing model providers preserves the selected workflow, file, and unfinished description. Normal chat includes the same report/database tools and instructions. The button selects a source and prompts for the initial layout; it is not an access gate. Ask follow-up questions directly, with or without the button selected. The active database connection retains the source path and latest saved database until the workspace or app closes; after restarting, name or select the existing file to reopen it. There is no mapping editor or manual approval screen. The completed SQLite file is saved under `redacted/` with a unique name; the source stays unchanged.

Every conversion uses the bundled Medicare CPT/HCPCS and ICD-10-CM descriptions for code enrichment. The [reference bundle](references/README.md) covers April 2025–September 2026 and includes revenue-center descriptions. Original codes, plaintext descriptions, lookup status, and source references should be retained. Unknown codes and missing/out-of-period dates remain explicit exceptions. Reference descriptions are available offline; the selected model provider still requires its normal connection.

Both providers receive `open_report` to open a permitted workspace XLSX/CSV/TSV or SQLite file, `report_sql` to inspect and work on its in-memory copy, and `save_database` to export named tables, alongside the guarded text-file tools. All paths go through the same protected-folder, traversal, symlink, hardlink, and application-code checks. SQLite cannot attach files or load extensions; its worker has no SQL filesystem functions. The provider receives no arbitrary shell, filesystem, or network tools. Redaction keeps its separate count-only capability and history. SQL helpers handle exact cents, Excel dates, bounded regex extraction, and one-code reference lookup without duplicating events. Export verifies source-table preservation, foreign keys, and SQLite integrity and adds source/reference provenance. Agent-generated extraction still depends on the operator's explanation and the agent's interpretation; structural checks are not proof of semantic correctness.

Limits: 40 MiB spreadsheet input or 256 MiB SQLite input, 64 sheets, 128 MiB expanded XLSX content, 500,000 populated rows, 384 MiB worker JavaScript heap, 60 seconds per local operation, and 256 MiB output. SQL responses are bounded samples. Each new turn reopens the last report or saved database. Opening another report discards unsaved in-memory tables; existing files are unchanged. Queries and additional saves are allowed after saving, so corrections can finish in the same turn. Every save creates a new revision under `redacted/`. Stop cancels processing. Formula cells use saved caches without recalculation. XLS/XLSM and PDFs must be converted to supported inputs first.

## Patient summaries skill

Click **Patient Summaries** beside **Redact** and **Database**, choose a saved redacted SQLite database (or use `@`), and send the prefilled request. The [bundled skill](skills/patient-summaries/SKILL.md) works with both providers. It inspects the schema and uses the reviewed patient/financial mapping; when that mapping has not been established, it asks for explicit review in chat before generating. No new mapping screen is required. Optional instructions can identify relevant columns or clarify patient grouping. Provider changes preserve the selected database and draft.

The app generates one Word document per patient in `redacted/Patient Summaries/<report-set>/`. Each run creates a new set without replacing earlier reports or changing the database. Documents use Calibri 12 pt body text, 20 pt titles, 14 pt headings, and Word bullets on Letter pages. Open the files in Word or another Word-compatible application using **Reveal file**; the current in-app viewer does not render DOCX.

Reports include total net payment, recorded primary diagnosis or a clearly labeled leading ICD-10-CM inference, significant services by DOS/type/net payment, and pending exposure strictly over $50,000. Paid-service bullets require an event strictly over $200 in absolute payment and either at least 5% of the patient's absolute payment activity or at least $50,000 in group net payment magnitude. When all recorded events are $200 or less, the section says **No events over $200**. Small office visits remain in totals. Large pending observations, DOS/service groups, and patient totals are flagged even when little or nothing was paid. Pending is never calculated as billed minus paid. Missing amounts and unknown diagnoses remain explicit; procedure codes alone do not establish a primary diagnosis. Code descriptions must match the service date and installed reference.

The agent supplies column names for one ordinary saved observation table, unique observation keys, patient keys, explicit total-row exclusions, and optional recorded clinical fields. A mapped patient roster includes patients with no events. Composite keys preserve supplier/group boundaries; duplicate observations, unmatched roster links, conflicting labels, and noninteger amounts fail generation. An accompanying `evidence.json` stores source keys, exact cents as decimal strings, diagnosis evidence, code-reference exceptions, the mapping, and the database digest. Do not use names alone to establish identity or treat agent interpretation as a substitute for reviewed financial semantics.

The summary action exposes only SQL inspection and `create_patient_summaries` on one read-only SQLite snapshot. General chat also supports summary creation from its currently opened saved database; unsaved SQL edits are not included. Rendering and aggregation run in the cancellable worker. Limits are 2,000 patients, 500,000 observations, 60 seconds per local operation, 64 MiB of Word files, and 64 MiB of evidence. Failed or cancelled generation does not publish a partial report set. Existing private originals and identity mappings remain inaccessible to either provider.

## Unredact summaries skill

Click **Unredact Summaries**, choose a report-set folder inside `redacted/Patient Summaries/` (or use `@`), then click **⇄** to choose its matching mapping CSVs from `unredacted/`. Send the prefilled request. The [bundled skill](skills/unredact-summaries/SKILL.md) instructs either provider to submit a declarative restoration plan. The application generates a runnable `unredact.cjs` and executes the trusted local implementation. Agents never receive mapping values, restored text, or restored filenames, and have no file, SQL, shell, or network tools during restoration. Its provider conversation context is separate from ordinary chat and redaction. Changing providers preserves the selected inputs; reopening a saved session requires selecting them again.

New Word copies, the runnable script, its plan, and a private source audit are saved in `unredacted/Patient Summaries/<new-set>/`. Redacted documents and mapping CSVs remain unchanged. Exact token replacement works across Word formatting runs and in document bodies, headers, footers, footnotes, endnotes, and comments. Styles and financial content are preserved. Local filenames restore complete matching tokens with filesystem-safe characters. Run the generated script with Node.js to create another set from the same unchanged inputs; changed source digests stop replay. No arbitrary model-authored code is executed.

When present, the original `evidence.json` is copied unchanged into the restored folder, retaining its redacted source keys and exact financial evidence. The private restoration audit links original and restored filenames and records input digests. This sidecar is limited to 64 MiB.

Every opened or newly created workspace gets `unredacted/Mapping CSV columns.md`, documenting `field,original,replacement,occurrences`. An existing reference is preserved, including operator edits. The same fixed header schema is bundled in the skill, so the agent does not need access to the private folder. CSV quoting, embedded commas/newlines, leading zeroes, and Unicode values remain intact.

Choose only the mapping CSVs belonging to that client/supplier report set. Missing mappings for detected tokens, conflicting originals for one token, invalid CSVs, modified selections, links, and cancellation cannot publish a partial set. Limits are 2,000 Word reports totaling 64 MiB, 32 mapping CSVs totaling 40 MiB, 100,000 mapping rows, a 384 MiB worker JavaScript heap, and 60 seconds of worker processing. Each message permits one execution. The tool returns only the new folder and document/replacement counts; inspect restored reports locally before export.

## Tests

From this directory:

```sh
npm test
npm run test:smoke
```

`node tests/smoke.auth.electron.cjs` exercises browser retry, cancellation, one-time code entry, automatic saved-status checking, and failure recovery in the real sandboxed window using a synthetic CLI subprocess and disposable application data. Authentication unit tests check URL restrictions, output/credential filtering, process termination, timeouts, and stale completion. These checks do not complete a real account login or verify native Windows browser launch.

`node tests/smoke.unredaction.electron.cjs` uses a real synthetic redaction mapping and Word report to check folder/mapping selection, provider switching, local restoration, unchanged sources, and count-only model results. Unit tests also cover split Word runs, CSV quoting, missing/conflicting mappings, cancellation, source digests, and private output access restrictions.

`node tests/smoke.patient-summaries.electron.cjs` checks the summary button, SQLite-only selection, provider switching, protected paths, real Word output, and unchanged source data using a synthetic database and mocked model replies. Unit tests cover payment/pending thresholds, the $200 floor, missing values, signed adjustments, diagnosis evidence, read-only access, cancellation, and immutable output sets.

The main Electron smoke checks completion notifications for both providers, cancellation, and restoring a minimized window with mocked OS delivery. To test actual OS delivery with synthetic queries, run `node tests/smoke.notifications.electron.cjs`; add `--click` to verify a real click on the final notification. This optional check prepares the macOS development signature, requires notifications to be allowed, and does not call either model provider.

The sidebar smoke checks menu actions, internal file/folder moves (including manual moves from `unredacted/` into `redacted/`), preview updates, collision handling, source invalidation, and chat selection/editing roles. It captures native menu definitions without modifying the system clipboard. Tests use separate disposable app-data directories and do not close an already running ARMa window.

The sessions smoke checks sidebar collapse/expand and Files/Sessions switching, new sessions, drafts, per-session model selection, workspace isolation, and resuming both providers' bounded context after a real app restart. It also checks recovery from an interrupted response without replaying the query. Session-store unit tests cover concurrent saves, excluded runtime/source fields, restrictive file permissions, and preserving corrupt or invalid saved data.

Unit tests use synthetic temporary directories and mocked provider processes. Electron smokes exercise native dialog results, workspace creation/opening, imports, drag-and-drop, previews, provider controls, and cancellation with synthetic data. The document smoke checks styled spreadsheets, sheet switching, hidden content, pagination, PDF rendering/navigation/zoom, and local previews in both folders. It captures screenshots, verifies source files remain unchanged, and checks that previews make no HTTP requests. Mocked responses do not verify live credentials. Live provider tests must use disposable synthetic workspaces, never insurer files or real patient data. Run `node scripts/test-database-live.cjs` for an opt-in live Codex test using the installed login: it creates a synthetic XLSX, converts it through the real Database capabilities, verifies patient/group links, exact amounts, bundled descriptions and empty employer records, then asks a normal-chat follow-up against both the saved database and source workbook before removing the disposable workspace.

The redaction smoke uses mock schema generation with the real local runner and verifies both source pickers, private mapping previews, styled Excel copies, count-only agent results, model/effort selection, and moving results without opening the review copy first. A synthetic 29-sheet workbook with 100–1,220 rows per sheet and 64 columns (1,224,960 cells, including formatted blanks) exercises the actual worker memory limit and local review, including navigation to the last sheet and column. Unit tests also exercise both provider capability configurations, the private Claude pipe, cancellation, stale-artifact rejection, and generated-script replay.

## Source references

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Electron native notifications and platform requirements](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Claude programmatic usage](https://code.claude.com/docs/en/headless)
- [Codex app server model catalog and turn settings](https://developers.openai.com/codex/app-server/)
- [Claude model configuration and effort](https://code.claude.com/docs/en/model-config)
- [T3 Code](https://github.com/pingdotgg/t3code), the requested layout reference
