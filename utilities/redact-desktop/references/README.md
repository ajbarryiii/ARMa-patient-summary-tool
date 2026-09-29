# Bundled code descriptions

`codes.json.gz` contains official CMS reference data, shared by both model providers through the local `code_lookup` SQL function. No claim data is included. `manifest.json` records every source download URL, archive SHA-256, release, and data-file name; its bundle checksum is verified before use.

Coverage: April 1, 2025 through September 30, 2026. The bundle contains six quarterly Medicare Physician Fee Schedule, Clinical Laboratory Fee Schedule, and HCPCS releases, three ICD-10-CM releases, and CMS revenue-center descriptions. Medicare laboratory descriptions take precedence over PFS short descriptions for laboratory CPT codes; HCPCS alphanumeric descriptions take precedence for HCPCS codes. ICD category headers are distinguished from billable codes. This is not a complete licensed AMA CPT book, ICD-9, or ICD-10-PCS reference.

A missing service date, a date outside this period, or a code found only in another release produces an explicit status. Descriptions are reference text, not a diagnosis, proof of code validity, coverage, or payment eligibility. Unknown codes remain unknown. Original report values are preserved.

Source data carries third-party rights: CPT codes and descriptions are copyright American Medical Association (2024 and 2026 in these CMS releases); dental codes/descriptions are copyright American Dental Association. CMS distributes these files for Medicare use; their inclusion does not grant rights beyond the applicable source terms. Exact PFS notices are retained in `THIRD_PARTY_NOTICES.txt`. Retain the CMS source notices and applicable licenses when distributing the application.

To update, download the official archives listed in the manifest (or their newer releases), verify their hashes, and parse their published description columns. The gzip JSON contains `records` (interned description objects) and `releases` (source metadata and code-to-record-index maps). Preserve each quarterly release, update coverage dates and bundle checksum, and run the code-reference and database tests. Do not build this asset from patient reports.
