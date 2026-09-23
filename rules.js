/*
 * rules.js —— 业务规则层（纯函数，不读写存储、不碰 DOM）
 * 职责：免减压限值判定、安全停留判定、标记状态判定、复核换人校验、修订归档判定、提交指纹。
 */
(function () {
  "use strict";

  // 空气潜水免减压限值表：最大深度（米）-> 免减压停留上限（分钟）。
  // 取档规则：就近就深（19 米按 20 米档）；超过表底 40 米视为必须减压（限值 0）。
  var NDL_TABLE = [
    { depth: 12, ndl: 120 },
    { depth: 14, ndl: 95 },
    { depth: 16, ndl: 72 },
    { depth: 18, ndl: 56 },
    { depth: 20, ndl: 45 },
    { depth: 22, ndl: 35 },
    { depth: 25, ndl: 25 },
    { depth: 30, ndl: 20 },
    { depth: 35, ndl: 10 },
    { depth: 40, ndl: 9 }
  ];
  var MAX_TABLE_DEPTH = 40;
  var SAFETY_STOP_DEPTH = 30;    // 最大深度达到 30 米，必须做安全停留
  var SAFETY_STOP_MINUTES = 3;   // 标准安全停留：5 米 / 3 分钟
  var DEDUP_WINDOW_MS = 10000;   // 重复提交沿用首次结果的时间窗

  function toNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function ndlFor(maxDepth) {
    var d = toNumber(maxDepth);
    if (!Number.isFinite(d) || d <= 0) return null;
    if (d > MAX_TABLE_DEPTH) return 0;
    var row = NDL_TABLE.find(function (r) { return d <= r.depth; });
    return row ? row.ndl : NDL_TABLE[0].ndl;
  }

  function hasSafetyStop(dive) {
    return !!(dive && dive.safetyStop);
  }

  // 评估潜次：超过免减压限值，或达到安全停留深度却缺少安全停留 => flagged
  function evaluateDive(dive) {
    var maxDepth = toNumber(dive && dive.maxDepth);
    var bottomTime = toNumber(dive && dive.bottomTime);
    var ndl = ndlFor(maxDepth);
    var reasons = [];
    var overNdl = false;
    var needsSafetyStop = false;
    var stopMissing = false;

    if (ndl !== null && Number.isFinite(bottomTime)) {
      overNdl = bottomTime > ndl;
      if (overNdl) {
        reasons.push(ndl === 0
          ? "最大深度 " + maxDepth + " 米超出限值表，须按减压潜水处置"
          : "底部时间 " + bottomTime + " 分钟超过免减压限值 " + ndl + " 分钟");
      }
      needsSafetyStop = maxDepth >= SAFETY_STOP_DEPTH;
      stopMissing = needsSafetyStop && !hasSafetyStop(dive);
      if (stopMissing) {
        reasons.push("最大深度达到 " + SAFETY_STOP_DEPTH + " 米，缺少安全停留（5 米 / " + SAFETY_STOP_MINUTES + " 分钟）记录");
      }
    }
    return {
      ndl: ndl,
      overNdl: overNdl,
      needsSafetyStop: needsSafetyStop,
      stopMissing: stopMissing,
      flagged: overNdl || stopMissing,
      reasons: reasons
    };
  }

  // 标记是否放行：潜次合规则自动放行；不合规则须有“有效”的复核放行。
  function markState(dive, review) {
    if (!dive) return "pending";
    if (!evaluateDive(dive).flagged) return "released";
    return review && review.active ? "released" : "pending";
  }

  // 复核校验：必须换人（复核人 ≠ 登记提交人），且填写停留深度与时长。
  function validateReview(dive, input) {
    var errors = [];
    var reviewer = String((input && input.reviewer) || "").trim();
    var stopDepth = toNumber(input && input.stopDepth);
    var stopMinutes = toNumber(input && input.stopMinutes);
    var maxDepth = toNumber(dive && dive.maxDepth);

    if (!reviewer) errors.push("必须填写复核人");
    else if (reviewer === String((dive && dive.recorder) || "").trim()) {
      errors.push("复核须换人：复核人不能与登记提交人相同");
    }
    if (!Number.isFinite(stopDepth) || stopDepth <= 0) {
      errors.push("必须填写停留深度（正数，米）");
    } else if (Number.isFinite(maxDepth) && stopDepth >= maxDepth) {
      errors.push("停留深度须小于最大深度");
    }
    if (!Number.isFinite(stopMinutes) || stopMinutes <= 0) {
      errors.push("必须填写停留时长（正数，分钟）");
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      value: {
        reviewer: reviewer,
        stopDepth: stopDepth,
        stopMinutes: stopMinutes,
        note: String((input && input.note) || "").trim(),
        at: new Date().toISOString(),
        active: true
      }
    };
  }

  // 只有修订深度或底部时间，才作废旧放行/旧导出并留档；改潜水员等不留档。
  function revisionTouchesProfile(before, after) {
    return toNumber(before.maxDepth) !== toNumber(after.maxDepth)
      || toNumber(before.bottomTime) !== toNumber(after.bottomTime);
  }

  // 提交指纹：同内容重复/并发提交沿用首次结果。
  function fingerprint(obj, fields) {
    return fields.map(function (f) { return String(obj[f] == null ? "" : obj[f]).trim(); }).join("￿");
  }

  window.DiveRules = {
    NDL_TABLE: NDL_TABLE,
    MAX_TABLE_DEPTH: MAX_TABLE_DEPTH,
    SAFETY_STOP_DEPTH: SAFETY_STOP_DEPTH,
    SAFETY_STOP_MINUTES: SAFETY_STOP_MINUTES,
    DEDUP_WINDOW_MS: DEDUP_WINDOW_MS,
    toNumber: toNumber,
    ndlFor: ndlFor,
    hasSafetyStop: hasSafetyStop,
    evaluateDive: evaluateDive,
    markState: markState,
    validateReview: validateReview,
    revisionTouchesProfile: revisionTouchesProfile,
    fingerprint: fingerprint
  };
})();
