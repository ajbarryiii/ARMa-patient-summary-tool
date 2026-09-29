"use strict";
const mapping = {
  table: "events", patient_key: ["supplier", "patient"], observation_key: ["supplier", "line"],
  net_payment_cents: "paid", pending_cents: "pending", dos: "dos", service_type: "service",
  patient_label: "label", primary_diagnosis: "primary_dx", icd_code: "icd", cpt_code: "cpt",
  exclude: { column: "kind", values: ["total"] },
  patients: { table: "patients", key: ["supplier", "patient"], label: "label" },
};
function populate(db) {
  db.run(`CREATE TABLE patients(supplier TEXT, patient TEXT, label TEXT);
    INSERT INTO patients VALUES ('A','1','PATIENT_A'),('A','2','PATIENT_B'),('B','1','PATIENT_A'),('A','3','PATIENT_C');
    CREATE TABLE events(supplier TEXT, patient TEXT, label TEXT, line INTEGER, kind TEXT, paid INTEGER, pending INTEGER, dos TEXT, service TEXT, primary_dx TEXT, icd TEXT, cpt TEXT);`);
  const entries = [
    ["A","1","PATIENT_A",1,"event",10000000,0,"2026-06-01","Inpatient care",null,"I10",null],
    ["A","1","PATIENT_A",2,"event",-1000000,0,"2026-06-02","Adjustment",null,"I10",null],
    ["A","1","PATIENT_A",3,"event",10000,5000000,"2026-06-03","Office visit",null,"I10","99214"],
    ["A","1","PATIENT_A",4,"event",null,5000001,"2026-06-04","Surgery",null,null,null],
    ["A","1","PATIENT_A",5,"total",9010000,10000001,null,"TOTAL",null,null,null],
    ["A","2","PATIENT_B",6,"event",20000,0,"2026-06-01","Office visit","Recorded condition",null,null],
    ["A","2","PATIENT_B",7,"event",19999,0,"2026-06-01","Office visit","Recorded condition",null,null],
    ["B","1","PATIENT_A",8,"event",20001,null,"2027-06-01",null,null,"I10","99214"],
  ];
  for (const row of entries) db.run("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", row);
}
module.exports = { mapping, populate };
