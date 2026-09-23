/*
 * records.js —— 数据/记录层（localStorage 持久化；不依赖 DOM）
 * 数据模型：
 *   dives   当前版本潜次 { id, code, diverA, diverB, maxDepth, bottomTime,
 *                          safetyStop, recorder, version, createdAt, updatedAt }
 *   marks   当前版本标记 { id, code, type, diveCode, version, x, y,
 *                          depth, orientation, condition, note, createdAt }
 *   reviews 当前复核放行（每潜次至多一条有效复核，深度/时间修订后随留档清除）
 *   archive 旧版本留档 { at, kind:"profile", dive, marks, review }
 *   ledgers 提交指纹，重复或并发提交沿用首次结果
 *
 * 关键不变量：
 *   - 标记状态不由存储决定，而由 rules.markState(dive, review) 实时推导；
 *   - 待复核标记不计入时间线、统计与导出；
 *   - 修订深度/底部时间 => 旧版本（潜次+标记+复核）整体留档，新版本标记重新待复核，旧导出失效。
 */
(function () {
  "use strict";

  var RULES = window.DiveRules;
  var STORE_KEY = "zfl30.diveDesk.v2";
  var inflightDives = {}; // 并发提交锁：指纹 -> Promise
  var inflightMarks = {};

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function now() { return new Date().toISOString(); }

  function load() {
    var db;
    try { db = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { db = null; }
    if (!db || !db.dives) {
      db = seed();
      persist(db);
    }
    return db;
  }

  function persist(db) { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }

  /* ---------------- 种子数据：一条合规、两条待复核 ---------------- */

  function seed() {
    var t = now();
    var dives = [
      { id: uuid(), code: "DIVE-01", diverA: "陈屿", diverB: "林舟", maxDepth: 18.4, bottomTime: 40, safetyStop: false, recorder: "赵潜", version: 1, createdAt: t, updatedAt: t },
      { id: uuid(), code: "DIVE-02", diverA: "韩潮", diverB: "苏岩", maxDepth: 30.2, bottomTime: 22, safetyStop: false, recorder: "赵潜", version: 1, createdAt: t, updatedAt: t },
      { id: uuid(), code: "DIVE-03", diverA: "周渔", diverB: "何淼", maxDepth: 25, bottomTime: 30, safetyStop: false, recorder: "周渔", version: 1, createdAt: t, updatedAt: t }
    ];
    var marks = [
      { id: uuid(), code: "A-017", type: "ceramic", diveCode: "DIVE-01", version: 1, x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋", createdAt: t },
      { id: uuid(), code: "W-003", type: "wood", diveCode: "DIVE-01", version: 1, x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁", createdAt: t },
      { id: uuid(), code: "M-010", type: "metal", diveCode: "DIVE-02", version: 1, x: 36, y: 61, depth: "29.6m", orientation: "东北偏北", condition: "表面附着贝类", note: "疑似铜钉", createdAt: t },
      { id: uuid(), code: "U-002", type: "unknown", diveCode: "DIVE-03", version: 1, x: 64, y: 55, depth: "24.9m", orientation: "南", condition: "待识别", note: "", createdAt: t }
    ];
    return { dives: dives, marks: marks, reviews: [], archive: [], ledgers: { dive: [], mark: [] } };
  }

  /* ---------------- 读取 ---------------- */

  function getDive(db, code) {
    var key = String(code || "").trim().toLowerCase();
    return db.dives.find(function (d) { return d.code.toLowerCase() === key; }) || null;
  }

  function findReview(db, diveCode) {
    var key = String(diveCode || "").trim().toLowerCase();
    return db.reviews.find(function (r) { return r.diveCode.toLowerCase() === key; }) || null;
  }

  function diveMarks(db, diveCode) {
    var key = String(diveCode || "").trim().toLowerCase();
    return db.marks.filter(function (m) { return m.diveCode.toLowerCase() === key; });
  }

  // 给标记挂上实时推导的状态：released 放行 / pending 待复核
  function decorateMark(db, mark) {
    var dive = getDive(db, mark.diveCode);
    var review = findReview(db, mark.diveCode);
    return Object.assign({}, mark, { state: RULES.markState(dive, review) });
  }

  function listMarks(db, opts) {
    opts = opts || {};
    var items = db.marks.map(function (m) { return decorateMark(db, m); });
    if (opts.type) items = items.filter(function (m) { return m.type === opts.type; });
    if (opts.state) items = items.filter(function (m) { return m.state === opts.state; });
    return items;
  }

  function listDives(db) {
    return db.dives.map(function (d) {
      var review = findReview(db, d.code);
      var eval0 = RULES.evaluateDive(d);
      var marks = diveMarks(db, d.code).map(function (m) { return decorateMark(db, m); });
      return Object.assign({}, d, {
        evaluation: eval0,
        flagged: eval0.flagged,
        released: !!(!eval0.flagged || review && review.active),
        pendingCount: marks.filter(function (m) { return m.state === "pending"; }).length,
        markCount: marks.length
      });
    });
  }

  /* ---------------- 校验 ---------------- */

  function normalizeDive(input) {
    return {
      code: String(input.code || "").trim().toUpperCase(),
      diverA: String(input.diverA || "").trim(),
      diverB: String(input.diverB || "").trim(),
      maxDepth: RULES.toNumber(input.maxDepth),
      bottomTime: RULES.toNumber(input.bottomTime),
      safetyStop: !!input.safetyStop,
      recorder: String(input.recorder || "").trim()
    };
  }

  function validateDive(input) {
    var d = normalizeDive(input);
    var errors = [];
    if (!d.code) errors.push("潜次登记编号必填");
    if (!d.diverA || !d.diverB) errors.push("须填写两名潜水员");
    if (d.diverA && d.diverB && d.diverA === d.diverB) errors.push("两名潜水员不能为同一人");
    if (!Number.isFinite(d.maxDepth) || d.maxDepth <= 0) errors.push("最大深度须为正数（米）");
    if (!Number.isFinite(d.bottomTime) || d.bottomTime <= 0) errors.push("底部时间须为正数（分钟）");
    if (!d.recorder) errors.push("须填写登记提交人（复核换人时需要比对）");
    return { value: d, errors: errors };
  }

  /* ---------------- 登记（幂等，可并发） ---------------- */

  // 模拟异步落盘，便于演示并发提交；同一指纹的并发调用共用同一个 Promise。
  function commitLater(result, ms) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(result); }, ms || 250); });
  }

  function recentLedger(entries, fp, nowTs) {
    return entries.find(function (e) { return e.fp === fp && nowTs - e.at <= RULES.DEDUP_WINDOW_MS; }) || null;
  }

  // 登记新潜次。重复或并发提交沿用首次结果（不新增、不报错）。
  function submitDive(db, raw) {
    var check = validateDive(raw);
    if (check.errors.length) {
      return Promise.resolve({ ok: false, errors: check.errors });
    }
    var d = check.value;
    var d = check.value;
    var fp = RULES.fingerprint(d, ["code", "diverA", "diverB", "maxDepth", "bottomTime", "safetyStop", "recorder"]);
    var nowTs = Date.now();

    // 同内容在时间窗内重复提交：无论首次是否已落盘，都沿用首次结果。
    var dup = recentLedger(db.ledgers.dive, fp, nowTs);
    if (dup) {
      var first = getDive(db, dup.diveCode);
      return Promise.resolve({ ok: true, dive: first, deduplicated: true });
    }
    if (inflightDives[fp]) {
      // 并发等待方沿用首次结果，并标注为去重命中。
      return inflightDives[fp].then(function (res) {
        return Object.assign({}, res, { deduplicated: true });
      });
    }
    // 窗口外同编号、内容不同：属于真冲突，应走“修订”而不是重复登记。
    var existing = getDive(db, d.code);
    if (existing) {
      return Promise.resolve({ ok: false, errors: ["潜次 " + d.code + " 已登记，深度/时间变更请使用“修订”"], conflict: true });
    }

    var result = new Promise(function (resolve) {
      setTimeout(function () {
        delete inflightDives[fp];
        var t = now();
        var dive = {
          id: uuid(), code: d.code, diverA: d.diverA, diverB: d.diverB,
          maxDepth: d.maxDepth, bottomTime: d.bottomTime, safetyStop: d.safetyStop,
          recorder: d.recorder, version: 1, createdAt: t, updatedAt: t
        };
        db.dives.push(dive);
        db.ledgers.dive.push({ fp: fp, diveCode: dive.code, at: Date.now() });
        pruneLedgers(db);
        persist(db);
        resolve({ ok: true, dive: dive, deduplicated: false });
      }, 250);
    });
    inflightDives[fp] = result;
    return result;
  }

  function pruneLedgers(db) {
    var cut = Date.now() - RULES.DEDUP_WINDOW_MS;
    ["dive", "mark"].forEach(function (kind) {
      db.ledgers[kind] = db.ledgers[kind].filter(function (e) { return e.at >= cut; });
    });
  }

  /* ---------------- 修订（深度/时间变更留档，旧导出失效） ---------------- */

  function reviseDive(db, code, raw) {
    var before = getDive(db, code);
    if (!before) return { ok: false, errors: ["潜次不存在"] };
    var check = validateDive(Object.assign({}, raw, { code: code }));
    if (check.errors.length) return { ok: false, errors: check.errors };
    var after = check.value;
    if (after.code !== before.code) return { ok: false, errors: ["修订不能变更潜次登记编号"] };

    var touchesProfile = RULES.revisionTouchesProfile(before, after);
    var beforeEval = RULES.evaluateDive(before);
    var afterEval = RULES.evaluateDive(after);
    var safetyStopToggled = after.safetyStop !== before.safetyStop;

    if (touchesProfile) {
      // 旧版本整体留档：潜次、标记、复核快照都保留。
      db.archive.push({
        at: now(),
        kind: "profile",
        reason: "修订最大深度/底部时间（" + before.maxDepth + "m/" + before.bottomTime + "min → "
                + after.maxDepth + "m/" + after.bottomTime + "min），旧放行与旧导出失效",
        dive: Object.assign({}, before),
        marks: diveMarks(db, before.code).map(function (m) { return Object.assign({}, m); }),
        review: findReview(db, before.code) ? Object.assign({}, findReview(db, before.code)) : null
      });
      before.version += 1;
    }

    Object.assign(before, {
      diverA: after.diverA, diverB: after.diverB, maxDepth: after.maxDepth,
      bottomTime: after.bottomTime, safetyStop: after.safetyStop,
      recorder: after.recorder, updatedAt: now()
    });

    if (touchesProfile) {
      // 新版本：标记升版本并重新待复核；旧复核随旧版本留档。
      diveMarks(db, before.code).forEach(function (m) { m.version = before.version; });
      db.reviews = db.reviews.filter(function (r) { return r.diveCode.toLowerCase() !== before.code.toLowerCase(); });
    } else if (safetyStopToggled && beforeEval.flagged !== afterEval.flagged) {
      // 仅改安全停留且合规性翻转：删旧复核，避免换人复核残留。
      db.reviews = db.reviews.filter(function (r) { return r.diveCode.toLowerCase() !== before.code.toLowerCase(); });
    }

    pruneLedgers(db);
    persist(db);
    return {
      ok: true,
      dive: before,
      archived: touchesProfile,
      version: before.version,
      flagged: afterEval.flagged,
      evaluation: afterEval
    };
  }

  /* ---------------- 复核放行（换人 + 停留深度/时长） ---------------- */

  function releaseDive(db, code, reviewInput) {
    var dive = getDive(db, code);
    if (!dive) return { ok: false, errors: ["潜次不存在"] };
    var eval0 = RULES.evaluateDive(dive);
    if (!eval0.flagged) return { ok: false, errors: ["该潜次未超限、安全停留齐备，无需复核"] };

    var check = RULES.validateReview(dive, reviewInput);
    if (!check.valid) return { ok: false, errors: check.errors };

    db.reviews = db.reviews.filter(function (r) { return r.diveCode.toLowerCase() !== code.toLowerCase(); });
    db.reviews.push(Object.assign({ diveCode: dive.code, version: dive.version }, check.value));
    persist(db);
    return { ok: true, review: findReview(db, code) };
  }

  /* ---------------- 标记登记（幂等，可并发） ---------------- */

  function normalizeMark(input) {
    return {
      code: String(input.code || "").trim().toUpperCase(),
      type: String(input.type || "unknown"),
      diveCode: String(input.diveCode || "").trim().toUpperCase(),
      x: RULES.toNumber(input.x), y: RULES.toNumber(input.y),
      depth: String(input.depth || "").trim(),
      orientation: String(input.orientation || "").trim(),
      condition: String(input.condition || "").trim(),
      note: String(input.note || "").trim()
    };
  }

  function validateMark(db, m) {
    var errors = [];
    if (!m.code) errors.push("标记编号必填");
    if (!m.diveCode) errors.push("须选择所属潜次");
    else if (!getDive(db, m.diveCode)) errors.push("所属潜次不存在，请先登记潜次");
    if (!m.depth) errors.push("须填写发现深度");
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) errors.push("须在平面图上点击定位");
    return errors;
  }

  function submitMark(db, raw) {
    var m = normalizeMark(raw);
    var errors = validateMark(db, m);
    if (errors.length) return Promise.resolve({ ok: false, errors: errors });

    var fp = RULES.fingerprint(m, ["code", "type", "diveCode", "x", "y", "depth", "orientation", "condition", "note"]);
    var nowTs = Date.now();
    var dup = recentLedger(db.ledgers.mark, fp, nowTs);
    if (dup) {
      var firstMark = db.marks.find(function (x) { return x.id === dup.markId; });
      return Promise.resolve(firstMark
        ? { ok: true, mark: decorateMark(db, firstMark), deduplicated: true }
        : { ok: false, errors: ["首次提交结果已失效"] });
    }
    if (inflightMarks[fp]) {
      return inflightMarks[fp].then(function (res) {
        return Object.assign({}, res, { deduplicated: true });
      });
    }

    var result = new Promise(function (resolve) {
      setTimeout(function () {
        delete inflightMarks[fp];
        var dive = getDive(db, m.diveCode);
        var mark = {
          id: uuid(), code: m.code, type: m.type, diveCode: m.diveCode, version: dive.version,
          x: m.x, y: m.y, depth: m.depth, orientation: m.orientation,
          condition: m.condition, note: m.note, createdAt: now()
        };
        db.marks.push(mark);
        db.ledgers.mark.push({ fp: fp, markId: mark.id, at: Date.now() });
        pruneLedgers(db);
        persist(db);
        resolve({ ok: true, mark: decorateMark(db, mark), deduplicated: false });
      }, 200);
    });
    inflightMarks[fp] = result;
    return result;
  }

  function updateMark(db, id, raw) {
    var mark = db.marks.find(function (x) { return x.id === id; });
    if (!mark) return { ok: false, errors: ["标记不存在"] };
    var m = normalizeMark(Object.assign({}, raw, { code: mark.code, x: mark.x, y: mark.y }));
    var errors = validateMark(db, m);
    if (errors.length) return { ok: false, errors: errors };
    Object.assign(mark, m, { updatedAt: now() });
    persist(db);
    return { ok: true, mark: decorateMark(db, mark) };
  }

  function deleteMark(db, id) {
    var before = db.marks.length;
    db.marks = db.marks.filter(function (m) { return m.id !== id; });
    persist(db);
    return { ok: db.marks.length !== before };
  }

  /* ---------------- 时间线 / 统计 / 导出（只认放行数据） ---------------- */

  // 时间线：待复核标记不计入。
  function timeline(db, opts) {
    opts = opts || {};
    var groups = {};
    listMarks(db, { type: opts.type }).forEach(function (m) {
      if (m.state !== "released") return;
      (groups[m.diveCode] = groups[m.diveCode] || []).push(m);
    });
    return Object.keys(groups).sort().map(function (code) {
      var dive = getDive(db, code);
      var review = findReview(db, code);
      return {
        diveCode: code,
        version: dive.version,
        maxDepth: dive.maxDepth,
        bottomTime: dive.bottomTime,
        review: RULES.evaluateDive(dive).flagged ? review : null,
        marks: groups[code].sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; })
      };
    });
  }

  function stats(db, opts) {
    var items = listMarks(db, { type: opts && opts.type });
    var byType = { ceramic: 0, wood: 0, metal: 0, unknown: 0 };
    var released = 0;
    items.forEach(function (m) {
      byType[m.type] = (byType[m.type] || 0) + 1;
      if (m.state === "released") released += 1;
    });
    var dives = listDives(db);
    return {
      divesTotal: dives.length,
      divesFlagged: dives.filter(function (d) { return d.flagged; }).length,
      marksTotal: items.length,
      marksReleased: released,
      marksPending: items.length - released,
      byType: byType,
      archivedVersions: db.archive.length
    };
  }

  // 导出：仅放行标记 + 当前有效潜次；与筛选一致；待复核数据不带出。
  function exportJSON(db, opts) {
    opts = opts || {};
    var payload = {
      exportedAt: now(),
      note: "仅包含复核放行数据；待复核标记与旧版本留档不在导出内。修订深度/底部时间后旧导出失效。",
      dives: timeline(db, { type: opts.type }).map(function (g) {
        return {
          diveCode: g.diveCode, version: g.version,
          diverA: getDive(db, g.diveCode).diverA, diverB: getDive(db, g.diveCode).diverB,
          maxDepth: g.maxDepth, bottomTime: g.bottomTime,
          safetyStop: getDive(db, g.diveCode).safetyStop,
          review: g.review ? {
            reviewer: g.review.reviewer, stopDepth: g.review.stopDepth,
            stopMinutes: g.review.stopMinutes, at: g.review.at
          } : null
        };
      }),
      marks: listMarks(db, { type: opts.type })
        .filter(function (m) { return m.state === "released"; })
        .map(function (m) {
          return {
            code: m.code, type: m.type, diveCode: m.diveCode, version: m.version,
            x: m.x, y: m.y, depth: m.depth, orientation: m.orientation,
            condition: m.condition, note: m.note
          };
        })
    };
    return JSON.stringify(payload, null, 2);
  }

  function listArchive(db) { return db.archive.slice().reverse(); }

  window.DiveRecords = {
    load: load, persist: persist,
    getDive: getDive, findReview: findReview, diveMarks: diveMarks,
    decorateMark: decorateMark, listMarks: listMarks, listDives: listDives,
    normalizeDive: normalizeDive, validateDive: validateDive,
    submitDive: submitDive, reviseDive: reviseDive, releaseDive: releaseDive,
    submitMark: submitMark, updateMark: updateMark, deleteMark: deleteMark,
    timeline: timeline, stats: stats, exportJSON: exportJSON, listArchive: listArchive
  };
})();
