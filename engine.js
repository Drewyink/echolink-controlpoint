/* ControlPoint analytics engine: XER parsing, CPM, DCMA 14, EVM, Monte Carlo. */
(function (root) {
  "use strict";
  const DAY = 86400000;
  const EPOCH = Date.UTC(2020, 0, 6); // a Monday

  /* ---------- Working-day calendar (Mon to Fri) ---------- */
  function parseDate(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  function idx(t) { // workday index of a UTC timestamp; weekends roll forward
    const days = Math.round((t - EPOCH) / DAY);
    const w = Math.floor(days / 7), r = ((days % 7) + 7) % 7;
    return w * 5 + Math.min(r, 5);
  }
  function dateOf(i) {
    const w = Math.floor(i / 5), r = ((i % 5) + 5) % 5;
    return EPOCH + (w * 7 + r) * DAY;
  }
  function fmt(t, style) {
    if (t == null || isNaN(t)) return "";
    const d = new Date(t);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate();
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    if (style === "iso") return y + "-" + String(mo + 1).padStart(2, "0") + "-" + String(da).padStart(2, "0");
    if (style === "short") return da + " " + MON[mo];
    return da + " " + MON[mo] + " " + y;
  }

  /* ---------- XER parser ---------- */
  function parseXER(text) {
    const tables = {};
    let cur = null, fields = null;
    const lines = String(text).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split("\t");
      const tag = parts[0];
      if (tag === "%T") { cur = parts[1]; tables[cur] = []; fields = null; }
      else if (tag === "%F") { fields = parts.slice(1); }
      else if (tag === "%R" && cur && fields) {
        const row = {};
        for (let i = 0; i < fields.length; i++) row[fields[i]] = parts[i + 1] == null ? "" : parts[i + 1];
        tables[cur].push(row);
      }
    }
    if (!tables.TASK) throw new Error("This file has no TASK table. Export the project from P6 as an XER file and try again.");
    return tables;
  }

  /* ---------- Model ---------- */
  const HARD = { CS_MSO: 1, CS_MEO: 1, CS_MSOB: 1, CS_MEOB: 1 };
  const CSTR_LABEL = {
    CS_MSO: "Mandatory start", CS_MEO: "Mandatory finish", CS_MSOA: "Start on or after",
    CS_MSOB: "Start on or before", CS_MEOA: "Finish on or after", CS_MEOB: "Finish on or before",
    CS_ALAP: "As late as possible", CS_SO: "Start on", CS_EO: "Finish on"
  };
  const REL_LABEL = { PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" };

  function buildModel(t, opts) {
    opts = opts || {};
    const proj = (t.PROJECT && t.PROJECT[0]) || {};
    const projId = opts.projId || proj.proj_id;
    const cal = (t.CALENDAR || [])[0];
    const hpd = cal && +cal.day_hr_cnt > 0 ? +cal.day_hr_cnt : 8;
    const wbs = {};
    (t.PROJWBS || []).forEach(w => {
      if (projId && w.proj_id !== projId) return;
      wbs[w.wbs_id] = { id: w.wbs_id, parent: w.parent_wbs_id, code: w.wbs_short_name, name: w.wbs_name, seq: +w.seq_num || 0, root: w.proj_node_flag === "Y" };
    });
    const cost = {};
    (t.TASKRSRC || []).forEach(r => {
      const c = cost[r.task_id] || (cost[r.task_id] = { bac: 0, ac: 0, etc: 0, n: 0 });
      c.bac += +r.target_cost || 0;
      c.ac += (+r.act_reg_cost || 0) + (+r.act_ot_cost || 0);
      c.etc += +r.remain_cost || 0;
      c.n++;
    });
    const acts = [], byId = {};
    t.TASK.forEach(r => {
      if (projId && r.proj_id !== projId) return;
      if (r.task_type === "TT_WBS") return;
      const isMile = r.task_type === "TT_Mile" || r.task_type === "TT_FinMile";
      const c = cost[r.task_id] || { bac: 0, ac: 0, etc: 0, n: 0 };
      const status = r.status_code === "TK_Complete" ? "C" : r.status_code === "TK_Active" ? "A" : "N";
      const a = {
        i: acts.length, id: r.task_id, code: r.task_code, name: r.task_name, wbsId: r.wbs_id,
        type: r.task_type, mile: isMile, finMile: r.task_type === "TT_FinMile", loe: r.task_type === "TT_LOE",
        status, pct: Math.max(0, Math.min(100, +r.phys_complete_pct || 0)),
        origDur: isMile ? 0 : Math.round((+r.target_drtn_hr_cnt || 0) / hpd),
        remDur: isMile ? 0 : Math.round((+r.remain_drtn_hr_cnt || 0) / hpd),
        actStart: parseDate(r.act_start_date), actFinish: parseDate(r.act_end_date),
        blStart: parseDate(r.target_start_date), blFinish: parseDate(r.target_end_date),
        cstr: r.cstr_type || "", cstrDate: parseDate(r.cstr_date),
        bac: c.bac, ac: c.ac, etc: c.etc, hasRsrc: c.n > 0,
        preds: [], succs: []
      };
      if (status === "C") { a.remDur = 0; a.pct = 100; }
      if (status === "N" && !isMile && a.remDur === 0 && a.origDur > 0) a.remDur = a.origDur;
      acts.push(a); byId[a.id] = a;
    });
    const rels = [];
    (t.TASKPRED || []).forEach(r => {
      const s = byId[r.task_id], p = byId[r.pred_task_id];
      if (!s || !p) return;
      const rel = { p: p.i, s: s.i, type: r.pred_type || "PR_FS", lag: Math.round((+r.lag_hr_cnt || 0) / hpd) };
      rels.push(rel); p.succs.push(rel); s.preds.push(rel);
    });
    const dd = parseDate(proj.last_recalc_date) || parseDate(proj.next_data_date) || Date.now();
    const start = parseDate(proj.plan_start_date) || Math.min(...acts.map(a => a.actStart || a.blStart || Infinity));
    const m = {
      name: proj.proj_short_name || "Project", title: proj.proj_short_name || "Project",
      dataDate: dd, D: idx(dd), start, wbs, acts, rels, byId, hpd,
      plannedFinish: parseDate(proj.plan_end_date) || parseDate(proj.scd_end_date)
    };
    m.topo = topoSort(m);
    return m;
  }

  function topoSort(m) {
    const n = m.acts.length, indeg = new Array(n).fill(0);
    m.rels.forEach(r => indeg[r.s]++);
    const q = [], out = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) q.push(i);
    while (q.length) {
      const i = q.shift(); out.push(i);
      m.acts[i].succs.forEach(r => { if (--indeg[r.s] === 0) q.push(r.s); });
    }
    if (out.length < n) {
      const loop = m.acts.filter((a, i) => indeg[i] > 0).map(a => a.code);
      m.loops = loop;
      for (let i = 0; i < n; i++) if (indeg[i] > 0) out.push(i); // keep going, results flagged
    }
    return out;
  }

  /* ---------- CPM ---------- */
  // Index convention: ES = start of a working day; EF = ES + duration (exclusive).
  // Task finish date = dateOf(EF - 1). Finish milestone date = dateOf(ES - 1).
  function finLimit(a, t) { return (a.mile && !a.finMile) ? idx(t) : idx(t) + 1; }

  function forward(m, dur) {
    const n = m.acts.length, ES = new Float64Array(n), EF = new Float64Array(n), D = m.D, OV = [];
    for (const i of m.topo) {
      const a = m.acts[i], d = dur[i];
      if (a.status === "C") {
        const st = a.actStart != null ? a.actStart : a.actFinish;
        const fi = a.actFinish != null ? a.actFinish : a.actStart;
        if (st == null) { ES[i] = EF[i] = D; continue; }
        if (a.mile) { ES[i] = EF[i] = a.finMile ? idx(fi) + 1 : idx(st); }
        else { ES[i] = idx(st); EF[i] = Math.max(idx(fi) + 1, ES[i]); }
        continue;
      }
      let es = D, efMin = -Infinity;
      if (a.status === "A") {
        es = a.actStart != null ? idx(a.actStart) : D;
        efMin = D + d;
      }
      if (a.status === "N") {
        for (const r of a.preds) {
          const pES = ES[r.p], pEF = EF[r.p];
          let req;
          if (r.type === "PR_SS") req = pES + r.lag;
          else if (r.type === "PR_FF") req = pEF + r.lag - d;
          else if (r.type === "PR_SF") req = pES + r.lag - d;
          else req = pEF + r.lag;
          if (req > es) es = req;
        }
        if (a.cstrDate != null) {
          const c = a.cstr;
          if (c === "CS_MSOA" || c === "CS_SO") es = Math.max(es, idx(a.cstrDate));
          else if (c === "CS_MEOA") es = Math.max(es, finLimit(a, a.cstrDate) - d);
          else if (c === "CS_MSO" || c === "CS_MEO") {
            const forced = c === "CS_MSO" ? idx(a.cstrDate) : finLimit(a, a.cstrDate) - d;
            if (forced < es) OV.push({ i, logic: es, forced });
            es = forced;
          }
        }
        ES[i] = es; EF[i] = es + d;
      } else { // active: remaining work from data date, retained logic on FF/SF
        let ef = efMin;
        for (const r of a.preds) {
          if (r.type === "PR_FF") ef = Math.max(ef, EF[r.p] + r.lag);
          else if (r.type === "PR_SF") ef = Math.max(ef, ES[r.p] + r.lag);
        }
        ES[i] = es; EF[i] = ef;
      }
    }
    let PF = -Infinity;
    for (let i = 0; i < n; i++) if (EF[i] > PF) PF = EF[i];
    return { ES, EF, PF, OV };
  }

  function durations(m, extra) {
    const d = new Float64Array(m.acts.length);
    m.acts.forEach((a, i) => { d[i] = a.status === "C" ? 0 : a.remDur + ((extra && extra[i]) || 0); });
    return d;
  }

  function schedule(m, extra) {
    const dur = durations(m, extra);
    const { ES, EF, PF, OV } = forward(m, dur);
    const n = m.acts.length, LS = new Float64Array(n), LF = new Float64Array(n), TF = new Array(n);
    for (let k = m.topo.length - 1; k >= 0; k--) {
      const i = m.topo[k], a = m.acts[i], d = dur[i];
      let lf = PF;
      for (const r of a.succs) {
        const s = m.acts[r.s];
        if (s.status === "C") continue;
        let v;
        if (r.type === "PR_SS") v = LS[r.s] - r.lag + d;
        else if (r.type === "PR_FF") v = LF[r.s] - r.lag;
        else if (r.type === "PR_SF") v = LF[r.s] - r.lag + d;
        else v = LS[r.s] - r.lag;
        if (v < lf) lf = v;
      }
      if (a.cstrDate != null && a.status !== "C") {
        const c = a.cstr;
        if (c === "CS_MEOB" || c === "CS_EO") lf = Math.min(lf, finLimit(a, a.cstrDate));
        else if (c === "CS_MSOB") lf = Math.min(lf, idx(a.cstrDate) + d);
        else if (c === "CS_MEO") lf = finLimit(a, a.cstrDate);
        else if (c === "CS_MSO") lf = idx(a.cstrDate) + d;
      }
      LF[i] = lf; LS[i] = lf - d;
      TF[i] = a.status === "C" ? null : lf - EF[i];
    }
    const driving = drivingPath(m, ES, EF, dur, PF);
    return { ES, EF, LS, LF, TF, PF, dur, driving, overrides: OV };
  }

  // Walk back from the latest-finishing activity through driving relationships.
  function drivingPath(m, ES, EF, dur, PF) {
    const set = new Set();
    let ends = [];
    m.acts.forEach((a, i) => { if (EF[i] === PF && a.status !== "C") ends.push(i); });
    const stack = ends.slice();
    while (stack.length) {
      const i = stack.pop();
      if (set.has(i)) continue;
      set.add(i);
      const a = m.acts[i];
      if (a.status !== "N") continue;
      for (const r of a.preds) {
        if (m.acts[r.p].status === "C") continue;
        let req;
        if (r.type === "PR_SS") req = ES[r.p] + r.lag;
        else if (r.type === "PR_FF") req = EF[r.p] + r.lag - dur[i];
        else if (r.type === "PR_SF") req = ES[r.p] + r.lag - dur[i];
        else req = EF[r.p] + r.lag;
        if (req === ES[i]) stack.push(r.p);
      }
    }
    return set;
  }

  // Display dates for an activity given a schedule
  function startDate(m, s, i) {
    const a = m.acts[i];
    if (a.actStart != null) return a.actStart;
    if (a.finMile) return dateOf(s.ES[i] - 1);
    return dateOf(s.ES[i]);
  }
  function finishDate(m, s, i) {
    const a = m.acts[i];
    if (a.status === "C" && a.actFinish != null) return a.actFinish;
    if (a.mile) return a.finMile ? dateOf(s.EF[i] - 1) : dateOf(s.ES[i]);
    return dateOf(s.EF[i] - 1);
  }
  function projectFinishDate(m, s) {
    let best = -Infinity, bi = -1;
    m.acts.forEach((a, i) => { const f = finishDate(m, s, i); if (f > best) { best = f; bi = i; } });
    return best;
  }

  /* ---------- DCMA 14 point assessment ---------- */
  function dcma(m, s) {
    const inc = m.acts.filter(a => a.status !== "C" && !a.loe);
    const incTasks = inc.filter(a => !a.mile);
    const incSet = new Set(inc.map(a => a.i));
    const relsInc = m.rels.filter(r => incSet.has(r.s));
    const pct = (num, den) => den ? (100 * num / den) : 0;
    const checks = [];
    const add = (o) => checks.push(o);
    const first = m.topo[0];

    const missing = inc.filter(a => {
      const noPred = a.preds.length === 0, noSucc = a.succs.length === 0;
      if (a.mile && !a.finMile && noPred && !noSucc) return false;   // project start milestone
      if (a.finMile && noSucc && !noPred) return false;                // project finish milestone
      return noPred || noSucc;
    });
    add({ id: 1, key: "logic", name: "Logic", desc: "Incomplete activities missing a predecessor or successor", threshold: "≤ 5%", value: pct(missing.length, inc.length), unit: "%", pass: pct(missing.length, inc.length) <= 5, items: missing.map(a => a.i),
      why: "Open ends let activities float freely, so delays do not ripple to the finish date and the critical path can be wrong.",
      fix: "Tie each open end into the network. Give every activity at least one predecessor and one successor, usually finish to start." });

    const leads = relsInc.filter(r => r.lag < 0);
    add({ id: 2, key: "leads", name: "Leads", desc: "Relationships with negative lag", threshold: "0%", value: pct(leads.length, relsInc.length), unit: "%", pass: leads.length === 0, items: leads.map(r => r.s), rels: leads,
      why: "Negative lags assume work can start before its predecessor finishes and hide overlap that should be shown as real activities.",
      fix: "Replace each lead by splitting the predecessor or using a start to start relationship with a positive lag." });

    const lags = relsInc.filter(r => r.lag > 0);
    add({ id: 3, key: "lags", name: "Lags", desc: "Relationships with positive lag", threshold: "≤ 5%", value: pct(lags.length, relsInc.length), unit: "%", pass: pct(lags.length, relsInc.length) <= 5, items: lags.map(r => r.s), rels: lags,
      why: "Lags are invisible durations. They cannot be statused or resourced and make float hard to explain.",
      fix: "Where the lag represents real work or waiting time (cure, review, delivery), model it as an activity." });

    const fs = relsInc.filter(r => r.type === "PR_FS");
    add({ id: 4, key: "reltype", name: "Relationship types", desc: "Finish to start share of relationships", threshold: "≥ 90%", value: pct(fs.length, relsInc.length), unit: "%", pass: pct(fs.length, relsInc.length) >= 90, items: relsInc.filter(r => r.type !== "PR_FS").map(r => r.s),
      why: "Heavy use of SS and FF ties makes the path harder to follow and can mask the true driving logic.",
      fix: "Review each SS and FF tie. Break overlapping activities into smaller pieces linked finish to start." });

    const hard = inc.filter(a => HARD[a.cstr]);
    add({ id: 5, key: "hard", name: "Hard constraints", desc: "Activities with hard date constraints", threshold: "≤ 5%", value: pct(hard.length, inc.length), unit: "%", pass: pct(hard.length, inc.length) <= 5, items: hard.map(a => a.i),
      why: "Hard constraints override logic and can produce negative float or dates that ignore real progress.",
      fix: "Use soft constraints (start on or after) or let logic drive the date. Keep hard constraints for genuine contract dates.",
      note: s.overrides.map(o => `${m.acts[o.i].code} is forced to start ${o.logic - o.forced} working days before its logic allows`).join(". ") });

    const hiFloat = incTasks.filter(a => s.TF[a.i] > 44);
    add({ id: 6, key: "hifloat", name: "High float", desc: "Incomplete tasks with total float over 44 days", threshold: "≤ 5%", value: pct(hiFloat.length, incTasks.length), unit: "%", pass: pct(hiFloat.length, incTasks.length) <= 5, items: hiFloat.map(a => a.i),
      why: "Very high float usually signals missing successor logic rather than real flexibility.",
      fix: "Check the successors of each activity and link it to the work that actually depends on it." });

    const negFloat = incTasks.filter(a => s.TF[a.i] < 0);
    add({ id: 7, key: "negfloat", name: "Negative float", desc: "Incomplete tasks with negative total float", threshold: "0%", value: pct(negFloat.length, incTasks.length), unit: "%", pass: negFloat.length === 0, items: negFloat.map(a => a.i),
      why: "Negative float means the forecast misses a constrained date. The schedule needs a recovery plan.",
      fix: "Develop a recovery plan: resequence, add resources to driving activities, or negotiate the constraint date." });

    const hiDur = incTasks.filter(a => a.origDur > 44);
    add({ id: 8, key: "hidur", name: "High duration", desc: "Incomplete tasks with original duration over 44 days", threshold: "≤ 5%", value: pct(hiDur.length, incTasks.length), unit: "%", pass: pct(hiDur.length, incTasks.length) <= 5, items: hiDur.map(a => a.i),
      why: "Long activities are hard to status accurately and hide the detail needed to manage them.",
      fix: "Break long activities into shorter ones with measurable deliverables, or justify them (procurement lead times)." });

    const dd = m.dataDate;
    const invalid = m.acts.filter(a => (a.actStart != null && a.actStart > dd) || (a.actFinish != null && a.actFinish > dd) || (a.status === "N" && s.ES[a.i] < m.D));
    add({ id: 9, key: "invalid", name: "Invalid dates", desc: "Actual dates after the data date, or forecasts before it", threshold: "0%", value: pct(invalid.length, m.acts.length), unit: "%", pass: invalid.length === 0, items: invalid.map(a => a.i),
      why: "Actuals in the future or forecasts in the past mean the update was not statused correctly.",
      fix: "Correct the actual dates and reschedule from the data date." });

    const noRes = incTasks.filter(a => !a.hasRsrc || a.bac <= 0);
    add({ id: 10, key: "resources", name: "Resources", desc: "Incomplete tasks with no cost or resource loading", threshold: "0%", value: pct(noRes.length, incTasks.length), unit: "%", pass: noRes.length === 0, items: noRes.map(a => a.i),
      why: "Unloaded activities cannot earn value, so cost and schedule performance are understated.",
      fix: "Assign resources or budgeted cost to each task, or mark it as a zero cost activity on purpose." });

    const dueTasks = m.acts.filter(a => !a.mile && a.blFinish != null && a.blFinish <= dd);
    const missed = dueTasks.filter(a => a.status !== "C" || (a.actFinish != null && a.actFinish > a.blFinish));
    add({ id: 11, key: "missed", name: "Missed tasks", desc: "Tasks due by the data date that finished late or not at all", threshold: "≤ 5%", value: pct(missed.length, dueTasks.length), unit: "%", pass: pct(missed.length, dueTasks.length) <= 5, items: missed.map(a => a.i),
      why: "A high miss rate means the baseline is not being met and future dates are optimistic.",
      fix: "Find the common cause of misses (permits, weather, supply) and adjust remaining durations realistically." });

    // Critical path test: delay the first driving incomplete task and confirm the finish moves by the same amount
    const drv = [...s.driving].filter(i => !m.acts[i].mile && m.acts[i].status !== "C");
    let cpt = { pass: false, detail: "No driving task found" };
    if (drv.length) {
      const pick = drv.sort((x, y) => s.ES[x] - s.ES[y])[0];
      const extra = new Float64Array(m.acts.length); extra[pick] = 100;
      const s2 = forward(m, durations(m, extra));
      const moved = s2.PF - s.PF;
      cpt = { pass: moved === 100, detail: `Added 100 days to ${m.acts[pick].code}; finish moved ${moved} days`, pick };
    }
    add({ id: 12, key: "cpt", name: "Critical path test", desc: cpt.detail, threshold: "Pass", value: cpt.pass ? "Pass" : "Fail", unit: "", pass: cpt.pass, items: cpt.pick != null ? [cpt.pick] : [],
      why: "If a delay on the critical path does not move the finish, the network is broken somewhere along it.",
      fix: "Trace the path for constraints or broken logic that absorb the delay." });

    const finIdx = finishMilestone(m, s);
    const cpl = s.PF - m.D;
    const finTF = finIdx != null ? s.TF[finIdx] : 0;
    const cpli = cpl > 0 ? (cpl + finTF) / cpl : 1;
    add({ id: 13, key: "cpli", name: "CPLI", desc: "Critical path length index", threshold: "≥ 0.95", value: cpli, unit: "", pass: cpli >= 0.95, items: [],
      why: "CPLI below 1.0 means the remaining critical path is longer than the time left to the contract date.",
      fix: "Shorten the driving path or reset the target date with the client." });

    const done = dueTasks.filter(a => a.status === "C").length;
    const bei = dueTasks.length ? m.acts.filter(a => !a.mile && a.status === "C").length / dueTasks.length : 1;
    add({ id: 14, key: "bei", name: "BEI", desc: "Baseline execution index", threshold: "≥ 0.95", value: bei, unit: "", pass: bei >= 0.95, items: [],
      why: "BEI compares tasks actually finished with tasks planned to finish by now.",
      fix: "Focus the next periods on clearing overdue tasks before starting new ones." });

    const passed = checks.filter(c => c.pass).length;
    return { checks, passed, score: Math.round(100 * passed / checks.length), inc: inc.length, cpli, bei, finIdx, due: dueTasks.length, done };
  }

  function finishMilestone(m, s) {
    let best = null;
    m.acts.forEach((a, i) => {
      if (a.finMile && a.cstrDate != null) { if (best == null || s.EF[i] > s.EF[best]) best = i; }
    });
    if (best == null) m.acts.forEach((a, i) => { if (a.finMile && (best == null || s.EF[i] > s.EF[best])) best = i; });
    return best;
  }

  /* ---------- Earned value ---------- */
  function spread(total, s, f, t) { // linear spread of total from s to f (timestamps), value at t
    if (s == null || f == null) return 0;
    if (t >= f) return total;
    if (t <= s) return 0;
    return total * (t - s) / Math.max(f - s, DAY);
  }
  function evm(m, s) {
    const t = m.dataDate + DAY - 1;
    let BAC = 0, PV = 0, EV = 0, AC = 0, ETC = 0;
    const byWbs = {};
    m.acts.forEach(a => {
      const pv = spread(a.bac, a.blStart, a.blFinish + DAY, t);
      const ev = a.bac * a.pct / 100;
      BAC += a.bac; PV += pv; EV += ev; AC += a.ac; ETC += a.etc;
      const top = topWbs(m, a.wbsId);
      const w = byWbs[top] || (byWbs[top] = { id: top, BAC: 0, PV: 0, EV: 0, AC: 0, ETC: 0 });
      w.BAC += a.bac; w.PV += pv; w.EV += ev; w.AC += a.ac; w.ETC += a.etc;
    });
    const CPI = AC ? EV / AC : 1, SPI = PV ? EV / PV : 1;
    // Earned schedule
    const series = curves(m, s);
    let esT = m.start;
    for (const p of series.points) { if (p.pv <= EV) esT = p.t; }
    // interpolate within week
    const pts = series.points;
    for (let k = 1; k < pts.length; k++) {
      if (pts[k - 1].pv <= EV && pts[k].pv > EV) { esT = pts[k - 1].t + (pts[k].t - pts[k - 1].t) * (EV - pts[k - 1].pv) / (pts[k].pv - pts[k - 1].pv); break; }
    }
    const AT = m.dataDate - m.start, ESd = esT - m.start;
    const SPIt = AT > 0 ? ESd / AT : 1;
    const blFinish = Math.max(...m.acts.map(a => a.blFinish || 0));
    const PD = blFinish - m.start;
    const IEACt = SPIt > 0 ? m.start + PD / SPIt : null;
    const res = {
      BAC, PV, EV, AC, ETC, CPI, SPI, SV: EV - PV, CV: EV - AC,
      EAC_cpi: CPI ? BAC / CPI : BAC, EAC_cpispi: AC + (BAC - EV) / ((CPI * SPI) || 1), EAC_bu: AC + ETC,
      TCPI: (BAC - AC) ? (BAC - EV) / (BAC - AC) : 1, SPIt, esDate: esT, IEACt, blFinish,
      byWbs: Object.values(byWbs).map(w => Object.assign(w, { CPI: w.AC ? w.EV / w.AC : null, SPI: w.PV ? w.EV / w.PV : null })),
      series
    };
    res.VAC = BAC - res.EAC_cpi;
    return res;
  }
  function topWbs(m, id) {
    let w = m.wbs[id], guard = 0;
    while (w && m.wbs[w.parent] && !m.wbs[w.parent].root && guard++ < 50) w = m.wbs[w.parent];
    return w ? w.id : "none";
  }
  // Weekly cumulative curves: PV (baseline), EV and AC (spread across actual spans to the data date), forecast (AC + ETC on early dates)
  function curves(m, s) {
    const dd = m.dataDate;
    let end = Math.max(...m.acts.map(a => a.blFinish || 0), projectFinishDate(m, s));
    const t0 = m.start, pts = [];
    const spanA = m.acts.map((a, i) => {
      const st = a.actStart, fin = a.status === "C" ? (a.actFinish || dd) : dd;
      return [st, fin + DAY];
    });
    const spanF = m.acts.map((a, i) => a.status === "C" ? null : [Math.max(dateOf(s.ES[i]), dd + DAY), finishDate(m, s, i) + DAY]);
    for (let t = t0; t <= end + 7 * DAY; t += 7 * DAY) {
      let pv = 0, ev = null, ac = null, fc = null;
      m.acts.forEach((a, i) => { pv += spread(a.bac, a.blStart, a.blFinish + DAY, t); });
      if (t <= dd + 6 * DAY) {
        const tt = Math.min(t, dd + DAY);
        ev = 0; ac = 0;
        m.acts.forEach((a, i) => {
          if (a.actStart == null) return;
          ev += spread(a.bac * a.pct / 100, spanA[i][0], spanA[i][1], tt);
          ac += spread(a.ac, spanA[i][0], spanA[i][1], tt);
        });
      }
      if (t >= dd) {
        fc = 0;
        m.acts.forEach((a, i) => {
          fc += a.ac;
          if (spanF[i]) fc += spread(a.etc, spanF[i][0], spanF[i][1], t);
        });
      }
      pts.push({ t, pv, ev, ac, fc });
    }
    return { points: pts, end };
  }

  /* ---------- Monte Carlo ---------- */
  function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  function tri(u, a, c, b) { const f = (c - a) / (b - a || 1); return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)); }
  function monteCarlo(m, opts) {
    const N = opts.iterations || 1000, lo = opts.low ?? 0.9, ml = opts.likely ?? 1.0, hi = opts.high ?? 1.3;
    const risks = opts.risks || [], rand = rng(opts.seed || 7);
    const n = m.acts.length, base = durations(m), finishes = [], crit = new Float64Array(n);
    const wbsUnc = opts.wbsHigh || {};
    for (let it = 0; it < N; it++) {
      const d = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = m.acts[i];
        if (!base[i] || a.status === "C") { d[i] = base[i]; continue; }
        const h = wbsUnc[topWbs(m, a.wbsId)] ?? hi;
        d[i] = Math.max(0, Math.round(base[i] * tri(rand(), lo, ml, h)));
      }
      for (const r of risks) {
        if (r.on === false || r.act == null) continue;
        if (rand() < r.prob) d[r.act] += r.days;
      }
      const f = forward(m, d);
      finishes.push(f.PF);
      const dp = drivingPath(m, f.ES, f.EF, d, f.PF);
      dp.forEach(i => crit[i]++);
    }
    finishes.sort((x, y) => x - y);
    const q = p => finishes[Math.min(N - 1, Math.floor(p * N))];
    return { finishes, P10: q(0.1), P50: q(0.5), P80: q(0.8), P90: q(0.9), crit: Array.from(crit, c => c / N), N };
  }

  /* ---------- XER writer (for the built-in sample and exports) ---------- */
  function writeXER(tables, order) {
    const out = ["ERMHDR\t20.12\t" + new Date().toISOString().slice(0, 10) + "\tProject\tadmin\tControlPoint\tdbxDatabaseNoName\tProject Management\tUSD"];
    for (const name of order) {
      const rows = tables[name]; if (!rows || !rows.length) continue;
      const f = Object.keys(rows[0]);
      out.push("%T\t" + name); out.push("%F\t" + f.join("\t"));
      rows.forEach(r => out.push("%R\t" + f.map(k => r[k] == null ? "" : String(r[k])).join("\t")));
    }
    out.push("%E");
    return out.join("\r\n");
  }

  const api = { parseDate, idx, dateOf, fmt, parseXER, buildModel, schedule, forward, durations, drivingPath, startDate, finishDate, projectFinishDate, dcma, evm, monteCarlo, writeXER, topWbs, CSTR_LABEL, REL_LABEL, HARD, DAY };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PCEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
