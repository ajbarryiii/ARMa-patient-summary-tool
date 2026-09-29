# ARMa — Patient Summary Tool

ARMa is a desktop application that turns medical claims spreadsheets into patient Word summaries. It brings local redaction, structured claims analysis, report generation, and identity restoration into one workspace for claims reviewers and small consultancies.

The application uses AI to help interpret spreadsheet layouts and map claims data. Financial aggregation, document rendering, and identity replacement run locally. Each report includes net payments, significant services, diagnosis evidence, and large pending balances, with a separate evidence file linking results back to their source observations.

## Workflow

1. **Import and preview.** Create a workspace and add source files to `unredacted/`. Inspect spreadsheets, PDFs, text, and images in the desktop viewer.
2. **Redact locally.** Describe the fields to replace. The model proposes rules; the local runner applies them and keeps identity mappings private. Review the result before choosing **Move to Redacted**.
3. **Build a claims database.** Select a redacted XLSX, CSV, or TSV file with **Database**. The agent structures it into SQLite and enriches medical codes with bundled reference descriptions.
4. **Generate patient summaries.** Use **Patient Summaries** with a saved database. Review the patient keys and financial mapping before generating one Word document per patient, plus an `evidence.json` sidecar.
5. **Restore identities for export.** Use **Unredact Summaries** with the matching private mapping CSVs. The app creates separate local Word copies while preserving the redacted reports and source database.

Report generation preserves exact integer cents, signed adjustments, missing amounts, and source evidence. Recorded diagnoses, code-based inferences, and unknown diagnoses remain distinguishable. New database revisions and report sets preserve earlier outputs.

## Installation

### Run from source

You will need Git, **Node.js 22.12 or newer**, a graphical desktop, and a Claude account with Claude Code access. Source development is verified on macOS; Windows test packaging is also available. Model requests require an internet connection.

```sh
git clone https://github.com/ajbarryiii/ARMa-patient-summary-tool.git
cd ARMa-patient-summary-tool
npm --prefix utilities/redact-desktop ci
npm --prefix utilities/redact-desktop start
```

In the app, open **Connections → Sign in to Claude** and complete browser sign-in. Then choose **New workspace** or **Open folder** to begin.

For subsequent launches, run the same `npm --prefix utilities/redact-desktop start` command from the repository root. Reinstall dependencies after dependency changes, and restart the app after source changes. No Python backend, Docker, local HTTP server, or frontend build step is required.

### Build a desktop installer

The repository includes packaging scripts for macOS disk images and a Windows x64 installer. Building requires **Node.js 22.13 or newer**. Packaged apps include the runtime and Claude sign-in; recipients do not need Node.js or a separate CLI installation.

See the desktop guide for [macOS builds](utilities/redact-desktop/README.md#macos-test-disk-image) and [Windows builds](utilities/redact-desktop/README.md#windows-test-installer), including verification commands and installation steps. These are test builds: macOS packages are ad-hoc signed and not notarized, and Windows installers are unsigned. Automatic updates are not provided.

## Data handling

Workspaces separate private originals and mappings in `unredacted/` from model-accessible files in `redacted/`. Local previews do not send documents to either model provider. During redaction, the provider receives the operator's description and execution counts, not the original file or identity mapping. Identity restoration also runs locally without exposing mapping values or restored text to the provider.

Files placed in `redacted/` can be read by the selected model provider. Review redaction before publishing: the current app allows **Move to Redacted** without first opening the review, and manually moving a file there does not redact it. Database conversion saves directly to that folder; verify its interpretation before generating summaries.

Providers use application-enforced tools with protected-path checks and no unrestricted shell or host-file access. These controls are not an operating-system sandbox. Keep separate workspaces and matching identity mappings for each client and report supplier.

## Engineering

The application lives in [`utilities/redact-desktop/`](utilities/redact-desktop/):

- **Electron and JavaScript:** native file dialogs, a sandboxed renderer, local document previews, and streaming conversations.
- **SQLite through sql.js:** structured claims data, bounded SQL tools, exact-cent helpers, and source provenance.
- **Local workers:** cancellable redaction, database processing, Word generation, and identity restoration.
- **Provider integrations:** bundled Claude Code for the desktop app and development-only Codex support.
- **Verification:** Node.js unit tests and Electron workflow smokes using synthetic data and disposable workspaces.

The [desktop guide](utilities/redact-desktop/README.md) documents architecture, supported formats, processing limits, authentication, and report rules. The [reference-data guide](utilities/redact-desktop/references/README.md) describes the bundled medical-code sources and coverage.

## Development

Run the unit suite and desktop workflow smokes from the repository root:

```sh
npm --prefix utilities/redact-desktop test
npm --prefix utilities/redact-desktop run test:smoke
```

Workflow smokes use synthetic data and mocked provider responses; they do not verify live account access. Use disposable workspaces for testing and keep insurer files, crosswalks, credentials, and runtime data out of Git.

Codex is installed as a development dependency. To enable development testing with an existing ChatGPT account, create a file-backed CLI login:

```sh
cd utilities/redact-desktop
npx --no-install codex -c 'cli_auth_credentials_store="file"' login
```

Then choose a Codex model in the app. Codex is disabled in packaged builds. See the [desktop guide](utilities/redact-desktop/README.md#run) for authentication details and provider controls.

## License

[MIT](LICENSE). Bundled reference data retains its [source notices](utilities/redact-desktop/references/THIRD_PARTY_NOTICES.txt).
