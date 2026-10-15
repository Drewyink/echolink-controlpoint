// Generates the Northgate Distribution Center sample as a P6 XER file.
const E = require("./engine.js");
const fs = require("fs");

const START = "2026-03-02", DD = "2026-10-05";
const WBS = [
  ["1", "PM", "Project Management & Preconstruction"],
  ["2", "SITE", "Sitework"],
  ["3", "FND", "Foundations & Slab"],
  ["4", "STR", "Structure"],
  ["5", "ENV", "Building Envelope"],
  ["6", "MEP", "MEP Systems"],
  ["7", "MHE", "Material Handling Automation"],
  ["8", "WMS", "WMS & ERP Integration"],
  ["9", "CX", "Commissioning & Closeout"],
];
// code, name, wbs, baseline days, preds, budget, actual duration factor, cost factor, type
const A = [
  ["M1000", "Notice to proceed", "1", 0, [], 0, 1, 1, "TT_Mile"],
  ["A1010", "Design development review", "1", 15, ["M1000"], 185000, 1, 1.02],
  ["A1020", "Building permit approval", "1", 25, ["A1010"], 42000, 1.4, 1.1],
  ["A1030", "Procure structural steel", "1", 60, ["A1010"], 3850000, 1.17, 1.08],
  ["A1040", "Procure conveyor and sortation system", "1", 90, ["A1010"], 6400000, 1.0, 1.0],
  ["A1050", "Procure selective racking", "1", 50, ["A1010"], 2150000, 1.1, 1.03],
  ["A1060", "Procure switchgear and electrical gear", "1", 80, ["A1010"], 1650000, 1.15, 1.05],
  ["A1070", "Procure dock levelers and overhead doors", "1", 45, ["A1010"], 780000, 1, 1],
  ["A2010", "Mobilization", "2", 5, ["A1020"], 160000, 1, 1],
  ["A2020", "Clearing and grubbing", "2", 10, ["A2010"], 240000, 1, 0.96],
  ["A2030", "Mass excavation and grading", "2", 20, ["A2020"], 1250000, 1.3, 1.24],
  ["A2040", "Underground utilities", "2", 25, ["A2030:SS:10"], 980000, 1.08, 1.06],
  ["A2050", "Stormwater detention pond", "2", 20, ["A2030"], 520000, 1, 1.02],
  ["A2060", "Paving and truck court", "2", 30, ["A3060"], 2100000, 1, 1],
  ["A2070", "Site lighting and fencing", "2", 15, ["A2060"], 410000, 1, 1],
  ["A3010", "Building pad and compaction", "3", 10, ["A2030"], 380000, 1.1, 1.05],
  ["A3020", "Spread footings and piers", "3", 20, ["A3010"], 1150000, 1.05, 1.04],
  ["A3030", "Grade beams", "3", 15, ["A3020"], 640000, 1, 1.02],
  ["A3040", "Underslab plumbing and electrical", "3", 12, ["A3030", "A2040"], 450000, 1, 1],
  ["A3050", "Slab on grade pour sequence", "3", 25, ["A3040"], 2300000, 1.12, 1.07],
  ["A3060", "Dock pits and aprons", "3", 15, ["A3050"], 520000, 1, 1],
  ["A4010", "Erect structural steel", "4", 35, ["A3020", "A1030"], 2650000, 1.06, 1.05],
  ["A4020", "Steel joists and deck", "4", 20, ["A4010:SS:10"], 1380000, 1, 1],
  ["A4030", "Mezzanine steel and stairs", "4", 15, ["A4020"], 520000, 1, 1],
  ["A5010", "Roofing membrane and insulation", "5", 25, ["A4020"], 2250000, 1, 1],
  ["A5020", "Insulated metal wall panels", "5", 30, ["A4010:SS:15"], 2450000, 1, 1],
  ["A5030", "Install overhead doors and dock levelers", "5", 15, ["A5020:FS:-3", "A1070", "A3060"], 310000, 1, 1],
  ["A5040", "Storefront and office glazing", "5", 10, ["A5020"], 280000, 1, 1],
  ["M5050", "Building dried in", "5", 0, ["A5010", "A5020"], 0, 1, 1, "TT_FinMile"],
  ["A6010", "Install electrical service and switchgear", "6", 20, ["A1060", "M5050"], 690000, 1, 1],
  ["A6020", "Lighting and branch power", "6", 35, ["M5050"], 1450000, 1, 1],
  ["A6030", "ESFR fire sprinkler system", "6", 40, ["M5050"], 1720000, 1, 1],
  ["A6040", "HVAC rooftop units and ductwork", "6", 30, ["M5050"], 1180000, 1, 1],
  ["A6050", "Plumbing fixtures and office MEP", "6", 20, ["A6040"], 520000, 1, 1],
  ["A6060", "Fire alarm system", "6", 20, ["A6020"], 380000, 1, 1],
  ["M6070", "Permanent power energized", "6", 0, ["A6010"], 0, 1, 1, "TT_FinMile"],
  ["A7010", "Install selective racking", "7", 30, ["A3050", "A1050", "A6030"], 820000, 1, 1],
  ["A7020", "Install conveyor system", "7", 40, ["A1040", "M5050", "A4030"], 2350000, 1, 1],
  ["A7030", "Install sortation and scanning", "7", 25, ["A7020:SS:20"], 980000, 1, 1],
  ["A7040", "Install AS/RS shuttle system", "7", 60, ["M5050"], 5200000, 1, 1, null, "CS_MSO"],
  ["A7050", "Controls and PLC programming", "7", 30, ["A7030", "M6070"], 760000, 1, 1],
  ["A8010", "WMS requirements and solution design", "8", 30, ["M1000"], 420000, 1.1, 1.12],
  ["A8020", "WMS configuration and build", "8", 45, ["A8010"], 680000, 1.05, 1.08],
  ["A8030", "Dynamics 365 EDI and API interfaces", "8", 40, ["A8010"], 540000, 1.1, 1.15],
  ["A8040", "Network and wireless infrastructure", "8", 20, ["A6020"], 460000, 1, 1],
  ["A8050", "WMS integration testing", "8", 25, ["A8020", "A8030", "A8040", "A7050"], 310000, 1, 1],
  ["A8060", "Warehouse user training", "8", 15, ["A8050"], 140000, 1, 1],
  ["A9010", "MEP commissioning", "9", 20, ["A6050", "A6060", "M6070"], 260000, 1, 1],
  ["A9020", "Fire marshal inspection", "9", 5, ["A9010", "A6030"], 18000, 1, 1],
  ["A9030", "Material handling commissioning", "9", 25, ["A7050", "A7010", "A7040"], 420000, 1, 1],
  ["A9040", "Integrated operations test", "9", 15, ["A9030", "A8050"], 190000, 1, 1],
  ["A9050", "Certificate of occupancy", "9", 10, ["A9020", "A2060", "A2070", "A5030"], 25000, 1, 1],
  ["A9060", "Punch list completion", "9", 15, ["A9040"], 210000, 1, 1],
  ["M9070", "Substantial completion", "9", 0, ["A9050", "A9040", "A9060"], 0, 1, 1, "TT_FinMile", "CS_MEOB"],
  ["A9080", "Closeout and turnover documentation", "9", 20, ["M9070"], 95000, 1, 1],
  ["M9090", "Project complete", "9", 0, ["A9080"], 0, 1, 1, "TT_FinMile"],
];
// Remaining-work re-estimates made at this update (forecast differs from baseline)
const REESTIMATE = { A7020: 46, A7040: 64 };

const RES = [["R1", "Labor", "RT_Labor"], ["R2", "Materials and equipment", "RT_Mat"], ["R3", "Subcontract", "RT_Equip"]];

function tables(statusFn, dataDate, cstrDates) {
  const H = 8;
  const t = {};
  t.PROJECT = [{ proj_id: "1001", proj_short_name: "NDC-2026", last_recalc_date: dataDate + " 08:00", plan_start_date: START + " 08:00", plan_end_date: "", scd_end_date: "" }];
  t.CALENDAR = [{ clndr_id: "1", clndr_name: "Standard 5 day", day_hr_cnt: "8", week_hr_cnt: "40" }];
  t.PROJWBS = [{ wbs_id: "100", proj_id: "1001", parent_wbs_id: "", wbs_short_name: "NDC", wbs_name: "Northgate Distribution Center", seq_num: "0", proj_node_flag: "Y" }]
    .concat(WBS.map(([n, c, name], k) => ({ wbs_id: "10" + n, proj_id: "1001", parent_wbs_id: "100", wbs_short_name: c, wbs_name: name, seq_num: String(k + 1), proj_node_flag: "N" })));
  t.TASK = A.map((a, k) => {
    const st = statusFn(a, k);
    return Object.assign({
      task_id: String(5000 + k), proj_id: "1001", wbs_id: "10" + a[2], clndr_id: "1", task_code: a[0], task_name: a[1],
      task_type: a[8] || "TT_Task", status_code: "TK_NotStart", phys_complete_pct: "0",
      target_drtn_hr_cnt: String(a[3] * H), remain_drtn_hr_cnt: String(a[3] * H),
      act_start_date: "", act_end_date: "", early_start_date: "", early_end_date: "", late_start_date: "", late_end_date: "",
      target_start_date: "", target_end_date: "", total_float_hr_cnt: "", cstr_type: a[9] || "", cstr_date: (a[9] && cstrDates[a[0]]) || "", driving_path_flag: "N"
    }, st);
  });
  const code2id = {}; A.forEach((a, k) => code2id[a[0]] = String(5000 + k));
  t.TASKPRED = [];
  A.forEach((a, k) => a[4].forEach(p => {
    const [pc, ty, lag] = p.split(":");
    t.TASKPRED.push({ task_pred_id: String(9000 + t.TASKPRED.length), task_id: String(5000 + k), pred_task_id: code2id[pc], proj_id: "1001", pred_proj_id: "1001", pred_type: "PR_" + (ty || "FS"), lag_hr_cnt: String((+lag || 0) * H) });
  }));
  t.RSRC = RES.map(([id, n, ty]) => ({ rsrc_id: id, rsrc_name: n, rsrc_short_name: n.split(" ")[0].toUpperCase(), rsrc_type: ty }));
  return t;
}
const D0 = s => E.fmt(s, "iso");
const ds = (t, hour) => t == null ? "" : D0(t) + " " + hour;

// 1) Baseline: no progress, data date = start
let t = tables(() => ({}), START, {});
let m = E.buildModel(t); let s = E.schedule(m);
const BL = {};
m.acts.forEach((a, i) => BL[a.code] = { s: E.startDate(m, s, i), f: E.finishDate(m, s, i) });
const cstrDates = { A7040: ds(BL.A7040.s, "08:00"), M9070: ds(BL.M9070.f, "17:00") };
console.log("Baseline finish", E.fmt(BL.M9090.f), "SC", E.fmt(BL.M9070.f), "ASRS start", E.fmt(BL.A7040.s));

// 2) As-built simulation with actual durations, to find status at the data date
t = tables((a) => ({ target_drtn_hr_cnt: String(Math.round(a[3] * a[6]) * 8), remain_drtn_hr_cnt: String(Math.round(a[3] * a[6]) * 8) }), START, {});
m = E.buildModel(t); s = E.schedule(m);
const ddT = E.parseDate(DD), Didx = E.idx(ddT);
const ST = {};
m.acts.forEach((a, i) => {
  const ad = Math.round(A[i][3] * A[i][6]);
  const es = s.ES[i], ef = s.EF[i];
  if (a.mile) {
    const when = a.finMile ? ef - 1 : es;
    if (when < Didx) ST[a.code] = { status: "C", as: E.dateOf(when), af: E.dateOf(when) };
    else ST[a.code] = { status: "N" };
  } else if (ef <= Didx) ST[a.code] = { status: "C", as: E.dateOf(es), af: E.dateOf(ef - 1), pct: 100 };
  else if (es < Didx) {
    const el = Didx - es, rem = ad - el;
    ST[a.code] = { status: "A", as: E.dateOf(es), rem, pct: Math.round(100 * el / ad) };
  } else ST[a.code] = { status: "N" };
});

// 3) Progressed update at the data date
function progress(a, k) {
  const st = ST[a[0]], bl = BL[a[0]], H = 8;
  const o = { target_start_date: ds(bl.s, "08:00"), target_end_date: ds(bl.f, "17:00") };
  if (st.status === "C") Object.assign(o, { status_code: "TK_Complete", phys_complete_pct: "100", remain_drtn_hr_cnt: "0", act_start_date: ds(st.as, "08:00"), act_end_date: ds(st.af, "17:00") });
  else if (st.status === "A") Object.assign(o, { status_code: "TK_Active", phys_complete_pct: String(st.pct), remain_drtn_hr_cnt: String(st.rem * H), act_start_date: ds(st.as, "08:00") });
  else if (REESTIMATE[a[0]]) o.remain_drtn_hr_cnt = String(REESTIMATE[a[0]] * H);
  return o;
}
t = tables(progress, DD, cstrDates);
m = E.buildModel(t); s = E.schedule(m);
t.TASK.forEach((r, i) => {
  const a = m.acts[i];
  if (a.status !== "C") {
    r.early_start_date = ds(E.startDate(m, s, i), "08:00"); r.early_end_date = ds(E.finishDate(m, s, i), "17:00");
    r.late_start_date = ds(E.dateOf(s.LS[i]), "08:00"); r.late_end_date = ds(E.dateOf(Math.max(s.LF[i] - 1, s.LS[i])), "17:00");
    r.total_float_hr_cnt = String(s.TF[i] * 8);
    r.driving_path_flag = s.driving.has(i) ? "Y" : "N";
  }
});
// Costs: one resource assignment per costed task
t.TASKRSRC = [];
A.forEach((a, k) => {
  if (!a[5]) return;
  const st = ST[a[0]], pct = st.status === "C" ? 100 : st.status === "A" ? st.pct : 0;
  const rid = a[2] === "1" && a[0] !== "A1010" && a[0] !== "A1020" ? "R2" : ["A1010", "A1020", "A8010", "A8020", "A8030", "A8060", "A9080"].includes(a[0]) ? "R1" : "R3";
  const ac = Math.round(a[5] * pct / 100 * a[7]);
  const etc = Math.round(a[5] * (1 - pct / 100) * (st.status === "A" ? a[7] : 1));
  t.TASKRSRC.push({ taskrsrc_id: String(7000 + k), task_id: String(5000 + k), proj_id: "1001", rsrc_id: rid, target_qty: String(a[3] * 8), target_cost: String(a[5]), act_reg_cost: String(ac), act_ot_cost: "0", remain_cost: String(etc) });
});
// Deliberately leave one task unloaded so the resource check has something to find
t.TASKRSRC = t.TASKRSRC.filter(r => r.task_id !== String(5000 + A.findIndex(a => a[0] === "A5040")));
t.PROJECT[0].scd_end_date = ds(E.projectFinishDate(m, s), "17:00");
t.PROJECT[0].plan_end_date = ds(BL.M9090.f, "17:00");

const xer = E.writeXER(t, ["PROJECT", "CALENDAR", "PROJWBS", "RSRC", "TASK", "TASKPRED", "TASKRSRC"]);
fs.writeFileSync(__dirname + "/northgate.xer", xer);
console.log("Forecast finish", E.fmt(E.projectFinishDate(m, s)), "bytes", xer.length);
m.acts.forEach((a, i) => { if (a.status !== "N") console.log(a.code, a.status, a.pct + "%", "rem", a.remDur); });
