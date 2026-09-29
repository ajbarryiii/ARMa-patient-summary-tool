"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
let bundle;
function load() {
  if (bundle) return bundle;
  const root = path.join(__dirname,'references');
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  const bytes = fs.readFileSync(path.join(root,'codes.json.gz'));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Code reference bundle checksum mismatch.');
  bundle = { ...JSON.parse(gunzipSync(bytes)), manifest };
  bundle.releases.sort((a,b)=>(a.effective_start || '').localeCompare(b.effective_start || ''));
  return bundle;
}
function lookup(system, value, date) {
  const b = load();
  let code = value == null ? '' : String(value).trim().toUpperCase();
  system = String(system || '').toLowerCase();
  if (!code) return {code:null,system:null,description:null,status:'missing_source_code',reference_id:null};
  let kinds;
  if (['icd','icd10','icd-10-cm'].includes(system)) { system='ICD-10-CM'; code=code.replace(/\./g,''); kinds=['icd']; }
  else if (system==='revenue') { code=code.padStart(4,'0'); kinds=['revenue']; }
  else if (['cpt','hcpcs'].includes(system)) {
    system=/^[A-Z]\d{4}$/.test(code)?'HCPCS':'CPT';
    kinds=system==='HCPCS'?['hcpcs','pfs']:['clfs','pfs'];
  } else return {code,system,description:null,status:'unsupported_code_system',reference_id:null};
  const day=String(date || '').slice(0,10);
  const validDate=/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0,10)===day;
  const outside=validDate && (day<b.manifest.coverage_start || day>b.manifest.coverage_end);
  const find = historical => {
    for (const kind of kinds) {
      const releases=b.releases.filter(r=>r.kind===kind);
      const current=releases.filter(r=>!validDate || !r.effective_start || r.effective_start<=day).at(-1);
      const candidates=historical?[...releases].reverse():current?[current]:[];
      for (const ref of candidates) {
        if (Object.hasOwn(ref.codes,code)) return {ref,record:b.records[ref.codes[code]]};
      }
    }
  };
  let match=find(false), fallback=false;
  if (!match) { match=find(true); fallback=Boolean(match); }
  if (!match) return {code,system,description:null,status:'unknown_code',reference_id:null};
  return {code,system,...match.record,reference_id:match.ref.id,status:!validDate?'date_unknown':outside?'outside_bundled_period':fallback?'not_in_date_matched_reference':match.record.is_billable_code===0?'matched_category_header':'matched'};
}
function register(db) {
  load();
  db.create_function('code_lookup',(system,code,date)=>JSON.stringify(lookup(system,code,date)));
}
module.exports={lookup,register,load};
