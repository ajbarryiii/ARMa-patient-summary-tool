"use strict";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const DEFAULT_MODEL = { id: "", name: "Codex default", efforts: [], defaultEffort: "" };
// Family aliases are resolved by the pinned Claude CLI. Haiku has no effort control.
const CLAUDE_MODELS = [
  { id: "", name: "Claude default", efforts: [], defaultEffort: "" },
  { id: "sonnet", name: "Claude Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "" },
  { id: "opus", name: "Claude Opus", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "" },
  { id: "haiku", name: "Claude Haiku", efforts: [], defaultEffort: "" },
];

function codexModels(entries) {
  const models = [];
  for (const entry of entries) {
    if (!entry || entry.hidden || typeof entry.model !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(entry.model) ||
        models.some((model) => model.id === entry.model)) continue;
    const advertised = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [];
    const efforts = [...new Set(advertised
      .map((item) => item?.reasoningEffort).filter((value) => EFFORTS.includes(value)))];
    models.push({
      id: entry.model,
      name: typeof entry.displayName === "string" ? entry.displayName.slice(0, 100) : entry.model,
      efforts,
      defaultEffort: efforts.includes(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : "",
      isDefault: entry.isDefault === true,
    });
  }
  return models.length ? models : [DEFAULT_MODEL];
}

function validateSelection(models, model = "", effort = "") {
  if (typeof model !== "string" || typeof effort !== "string")
    throw new Error("Choose a valid model and reasoning effort.");
  // Omitted values preserve the existing provider defaults for API callers.
  if (!model && !effort) return;
  const selected = models.find((item) => item.id === model);
  if (!selected) throw new Error("That model is unavailable. Refresh Connections and choose a model.");
  if (effort && !selected.efforts.includes(effort))
    throw new Error("That reasoning effort is unavailable for the selected model.");
}

module.exports = { CLAUDE_MODELS, DEFAULT_MODEL, codexModels, validateSelection };
