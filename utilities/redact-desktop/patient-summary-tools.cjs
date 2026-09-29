"use strict";

const column = { type: "string", minLength: 1, maxLength: 128 };
const keys = { type: "array", items: column, minItems: 1, maxItems: 8 };
const MAPPING_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["table", "patient_key", "observation_key", "net_payment_cents"],
  properties: {
    table: column, patient_key: keys, observation_key: keys, net_payment_cents: column,
    ...Object.fromEntries(["patient_label", "dos", "service_type", "pending_cents", "primary_diagnosis", "icd_code", "cpt_code"].map(name => [name, column])),
    exclude: { type: "object", additionalProperties: false, required: ["column", "values"], properties: {
      column, values: { type: "array", minItems: 1, maxItems: 32, items: { type: ["string", "number"] } },
    } },
    patients: { type: "object", additionalProperties: false, required: ["table", "key"], properties: { table: column, key: keys, label: column } },
    significance_percent: { type: "number", minimum: 0, maximum: 100 },
  },
};
const TOOLS = [{
  name: "create_patient_summaries",
  description: "Create one Calibri 12 pt Word report per patient from the saved SQLite database. Use the reviewed declarative column mapping, unique observation keys, explicit total exclusions, and integer-cent amounts. Locally computes payments, significant DOS/service bullets, evidence-based diagnosis and pending amounts over $50,000. Saves a new immutable set under redacted/Patient Summaries. Does not accept SQL, prose amounts, or output paths.",
  inputSchema: { type: "object", additionalProperties: false, required: ["mapping"], properties: { mapping: MAPPING_SCHEMA } },
}];
module.exports = { TOOLS };
