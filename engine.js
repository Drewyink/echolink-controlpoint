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
  function drivingPath(m, ES, EF, dur, PF, from) {
    const set = new Set();
    let ends = [];
    if (from != null) ends = [from];
    else m.acts.forEach((a, i) => { if (EF[i] === PF && a.status !== "C") ends.push(i); });
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

  /* ---------- Update comparison ---------- */
  const relKey = (m, r) => m.acts[r.p].code + ">" + m.acts[r.s].code;
  function compare(mP, sP, mC, sC) {
    const out = { prevDate: mP.dataDate, curDate: mC.dataDate, elapsed: mC.D - mP.D };
    out.prevFinish = projectFinishDate(mP, sP); out.curFinish = projectFinishDate(mC, sC);
    out.finishDelta = idx(out.curFinish) - idx(out.prevFinish);
    const P = {}; mP.acts.forEach(a => P[a.code] = a);
    const C = {}; mC.acts.forEach(a => C[a.code] = a);
    out.added = mC.acts.filter(a => !P[a.code]).map(a => a.i);
    out.deleted = mP.acts.filter(a => !C[a.code]).map(a => ({ code: a.code, name: a.name }));
    out.rows = []; out.durChanges = []; out.cstrChanges = []; out.remIncreases = [];
    out.started = []; out.finished = []; out.missed = [];
    mC.acts.forEach(c => {
      const p = P[c.code]; if (!p) return;
      const pf = finishDate(mP, sP, p.i), cf = finishDate(mC, sC, c.i);
      const row = { i: c.i, code: c.code, name: c.name, pf, cf, delta: idx(cf) - idx(pf), ptf: sP.TF[p.i], ctf: sC.TF[c.i],
        pDrv: sP.driving.has(p.i), cDrv: sC.driving.has(c.i), pStatus: p.status, cStatus: c.status, pPct: p.pct, cPct: c.pct };
      out.rows.push(row);
      if (!c.mile && p.origDur !== c.origDur) out.durChanges.push({ i: c.i, code: c.code, name: c.name, from: p.origDur, to: c.origDur, drv: row.cDrv });
      if (p.cstr !== c.cstr || (p.cstrDate || 0) !== (c.cstrDate || 0)) out.cstrChanges.push({ i: c.i, code: c.code, name: c.name, from: p.cstr ? (CSTR_LABEL[p.cstr] || p.cstr) + " " + fmt(p.cstrDate) : "None", to: c.cstr ? (CSTR_LABEL[c.cstr] || c.cstr) + " " + fmt(c.cstrDate) : "None", added: !p.cstr && !!c.cstr, hard: !!HARD[c.cstr] });
      if (c.status !== "C" && p.status !== "C" && !c.mile) {
        const worked = c.status === "A" ? Math.max(0, mC.D - Math.max(mP.D, c.actStart != null ? idx(c.actStart) : mC.D)) : 0;
        const expected = Math.max(0, p.remDur - worked);
        if (c.remDur > expected + 2) out.remIncreases.push({ i: c.i, code: c.code, name: c.name, expected, actual: c.remDur, drv: row.cDrv });
      }
      if (p.status === "N" && c.status !== "N") out.started.push(c.i);
      if (p.status !== "C" && c.status === "C") out.finished.push(c.i);
      if (p.status !== "C" && c.status !== "C" && !c.mile && pf <= mC.dataDate) out.missed.push(c.i);
    });
    out.rows.sort((a, b) => b.delta - a.delta);
    const PR = {}; mP.rels.forEach(r => PR[relKey(mP, r)] = r);
    const CR = {}; mC.rels.forEach(r => CR[relKey(mC, r)] = r);
    const lbl = r => (REL_LABEL[r.type] || r.type) + (r.lag ? (r.lag > 0 ? " +" : " ") + r.lag : "");
    out.relAdded = mC.rels.filter(r => !PR[relKey(mC, r)]).map(r => ({ key: relKey(mC, r), pred: r.p, succ: r.s, type: lbl(r) }));
    out.relDeleted = mP.rels.filter(r => !CR[relKey(mP, r)]).map(r => ({ key: relKey(mP, r), predCode: mP.acts[r.p].code, succCode: mP.acts[r.s].code, type: lbl(r), r }));
    out.relChanged = mC.rels.filter(r => PR[relKey(mC, r)] && (PR[relKey(mC, r)].type !== r.type || PR[relKey(mC, r)].lag !== r.lag)).map(r => ({ key: relKey(mC, r), pred: r.p, succ: r.s, from: lbl(PR[relKey(mC, r)]), to: lbl(r) }));
    out.drvIn = out.rows.filter(r => r.cDrv && !r.pDrv && r.cStatus !== "C").map(r => r.i);
    out.drvOut = out.rows.filter(r => r.pDrv && !r.cDrv && r.cStatus !== "C").map(r => r.i);
    out.attribution = attribute(mP, mC, sC, out);
    return out;
  }
  // What would the forecast be if each edit made this period were reversed? Positive days = the edit pulled the finish earlier.
  function attribute(mP, mC, sC, cmp) {
    const PF0 = sC.PF, res = [];
    const P = {}; mP.acts.forEach(a => P[a.code] = a);
    cmp.cstrChanges.forEach(ch => {
      const a = mC.acts[ch.i], p = P[a.code], keep = [a.cstr, a.cstrDate];
      a.cstr = p.cstr; a.cstrDate = p.cstrDate;
      const pf = forward(mC, durations(mC)).PF;
      a.cstr = keep[0]; a.cstrDate = keep[1];
      if (pf !== PF0) res.push({ kind: "constraint", code: a.code, i: a.i, text: `${ch.added ? "Added" : "Changed"} constraint on ${a.code} ${a.name} (${ch.to})`, days: pf - PF0 });
    });
    cmp.durChanges.forEach(ch => {
      const a = mC.acts[ch.i]; if (a.status !== "N") return;
      const extra = new Float64Array(mC.acts.length); extra[ch.i] = ch.from - ch.to;
      const pf = forward(mC, durations(mC, extra)).PF;
      if (pf !== PF0) res.push({ kind: "duration", code: a.code, i: a.i, text: `Original duration of ${a.code} ${a.name} changed from ${ch.from} to ${ch.to} days`, days: pf - PF0 });
    });
    cmp.relDeleted.forEach(d => {
      const C = {}; mC.acts.forEach(a => C[a.code] = a);
      const p = C[d.predCode], s = C[d.succCode]; if (!p || !s) return;
      const rel = { p: p.i, s: s.i, type: d.r.type, lag: d.r.lag };
      p.succs.push(rel); s.preds.push(rel); mC.rels.push(rel);
      const topo0 = mC.topo; mC.topo = topoSort(mC);
      const pf = forward(mC, durations(mC)).PF;
      p.succs.pop(); s.preds.pop(); mC.rels.pop(); mC.topo = topo0;
      if (pf !== PF0) res.push({ kind: "logic", code: d.predCode, i: p.i, text: `Deleted relationship ${d.predCode} to ${d.succCode}`, days: pf - PF0 });
    });
    return res.sort((a, b) => b.days - a.days);
  }

  /* ---------- Recovery optimizer ---------- */
  function recovery(m, s, opts) {
    opts = opts || {};
    const crashPct = opts.crashPct ?? 0.25, premium = opts.premium ?? 0.15, overlap = opts.overlap ?? 0.5;
    const T = opts.target; // optional milestone index to recover; otherwise the project finish
    const PF0 = T != null ? s.EF[T] : s.PF, options = [];
    const path = T != null ? drivingPath(m, s.ES, s.EF, s.dur, s.PF, T) : s.driving;
    const drv = [...path].filter(i => m.acts[i].status !== "C");
    drv.forEach(i => {
      const a = m.acts[i];
      if (a.mile || a.remDur < 5) return;
      const cut = Math.max(1, Math.round(a.remDur * crashPct));
      options.push({ id: "crash:" + a.code, kind: "Crash", i, title: `Add a second crew or extended shifts on ${a.code} ${a.name}`,
        detail: `Cuts remaining duration from ${a.remDur} to ${a.remDur - cut} days.`, cut, cost: Math.max(5000, Math.round((a.etc || 0) * premium)),
        risk: "Crew availability and productivity loss on congested work fronts." });
    });
    m.rels.forEach(r => {
      if (r.type !== "PR_FS" || r.lag < 0) return;
      if (!path.has(r.p) || !path.has(r.s)) return;
      const p = m.acts[r.p], q = m.acts[r.s];
      if (q.status !== "N" || p.mile || q.mile || p.status === "C" || p.remDur < 6) return;
      const lead = Math.max(1, Math.floor(p.remDur * overlap));
      options.push({ id: "ff:" + p.code + ">" + q.code, kind: "Fast track", r, lead, title: `Start ${q.code} ${q.name} before ${p.code} finishes`,
        detail: `Overlaps the two activities by ${lead} working days.`, cost: 0, risk: "Rework if the earlier work changes. Needs coordination between crews." });
    });
    options.forEach(o => { o.days = PF0 - evalPlan(m, [o], T); });
    const useful = options.filter(o => o.days > 0).sort((a, b) => b.days - a.days || a.cost - b.cost);
    // Greedy plan: keep each option only if it still adds days on top of those already chosen
    const plan = []; let best = PF0;
    useful.forEach(o => { const pf = evalPlan(m, plan.concat(o), T); if (pf < best) { plan.push(o); best = pf; } });
    // When a target date exists, drop the most expensive options the plan does not need to meet it
    const need = T != null && s.TF[T] < 0 ? PF0 + s.TF[T] : null;
    if (need != null && best <= need) {
      plan.slice().sort((x, y) => y.cost - x.cost || x.days - y.days).forEach(o => {
        const rest = plan.filter(q => q !== o);
        if (evalPlan(m, rest, T) <= need) plan.splice(plan.indexOf(o), 1);
      });
    }
    plan.forEach(o => o.recommended = true);
    return { options: useful, plan, PF0, target: T, need };
  }
  function evalPlan(m, list, T) {
    const extra = new Float64Array(m.acts.length), saved = [];
    list.forEach(o => {
      if (o.kind === "Crash") extra[o.i] -= o.cut;
      else { saved.push([o.r, o.r.lag]); o.r.lag = -o.lead; }
    });
    const f = forward(m, durations(m, extra));
    saved.forEach(([r, lag]) => r.lag = lag);
    return T != null ? f.EF[T] : f.PF;
  }
  function applyPlan(m, list) { // returns a full schedule with the plan applied, then restores the model
    const extra = new Float64Array(m.acts.length), saved = [];
    list.forEach(o => { if (o.kind === "Crash") extra[o.i] -= o.cut; else { saved.push([o.r, o.r.lag]); o.r.lag = -o.lead; } });
    const sch = schedule(m, extra);
    saved.forEach(([r, lag]) => r.lag = lag);
    return sch;
  }

  /* ---------- Historical snapshot (for playback) ---------- */
  // Rebuilds the schedule as it would have stood on date t, using only actual dates known by then
  // and original durations for work not yet finished.
  function snapshotAt(m, t) {
    const D = idx(t);
    const acts = m.acts.map(a => {
      const b = Object.assign({}, a);
      if (a.actFinish != null && a.actFinish < t) { b.status = "C"; b.remDur = 0; b.pct = 100; }
      else if (a.actStart != null && a.actStart < t && !a.mile) {
        const el = D - idx(a.actStart);
        b.status = "A"; b.actFinish = null; b.remDur = Math.max(1, a.origDur - el); b.pct = Math.min(99, Math.round(100 * el / Math.max(1, a.origDur)));
      } else { b.status = "N"; b.actStart = null; b.actFinish = null; b.remDur = a.mile ? 0 : a.origDur; b.pct = 0; }
      return b;
    });
    return Object.assign({}, m, { acts, D, dataDate: t });
  }
  function spreadAt(total, s, f, t) { return spread(total, s, f, t); }

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

  const api = { parseDate, idx, dateOf, fmt, parseXER, buildModel, schedule, forward, durations, drivingPath, startDate, finishDate, projectFinishDate, dcma, evm, monteCarlo, writeXER, topWbs, compare, recovery, evalPlan, applyPlan, snapshotAt, spreadAt, CSTR_LABEL, REL_LABEL, HARD, DAY };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PCEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
