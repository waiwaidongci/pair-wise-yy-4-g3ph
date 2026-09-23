/*
 * dive-rules.js —— 业务规则（纯函数，不碰存储与 DOM）
 * 职责：免减压限值、安全停留、复核放行、修订失效的判定与校验。
 */
(function () {
  "use strict";

  // 免减压限值表（米/分钟），取不小于实际深度的最浅一档
  var NDL_TABLE = [
    { depth: 12, minutes: 120 },
    { depth: 14, minutes: 95 },
    { depth: 16, minutes: 72 },
    { depth: 18, minutes: 56 },
    { depth: 20, minutes: 45 },
    { depth: 22, minutes: 37 },
    { depth: 25, minutes: 30 },
    { depth: 30, minutes: 20 },
    { depth: 35, minutes: 14 },
    { depth: 40, minutes: 9 }
  ];

  // 大于该深度（米）强制要求 3 分钟安全停留
  var SAFETY_STOP_DEPTH = 12;
  var SAFETY_STOP_MINUTES = 3;
  // 触发修订失效、需要留档的字段
  var INVALIDATING_FIELDS = ["maxDepth", "bottomTime"];
  // 状态机
  var STATUS = { PENDING: "pending", RELEASED: "released" };

  function ndlLimit(depth) {
    var row = NDL_TABLE.find(function (r) { return r.depth >= depth; });
    return row ? row.minutes : 0; // 超过 40m 不在免减压潜水范围，限值按 0 处理
  }

  // 评估一次潜次：是否超免减压限值、是否缺安全停留
  function evaluateDive(dive) {
    var limit = ndlLimit(dive.maxDepth);
    var overNDL = dive.bottomTime > limit;
    var needsStop = dive.maxDepth > SAFETY_STOP_DEPTH;
    var hasStop = dive.safetyStopMinutes >= SAFETY_STOP_MINUTES;
    var missingSafetyStop = needsStop && !hasStop;
    var compliant = !overNDL && !missingSafetyStop;
    var violations = [];
    if (overNDL) {
      violations.push("底部时间 " + dive.bottomTime + " 分钟超过 " + dive.maxDepth +
        " 米档免减压限值 " + limit + " 分钟");
    }
    if (missingSafetyStop) {
      violations.push("深度超过 " + SAFETY_STOP_DEPTH + " 米但缺少不少于 " +
        SAFETY_STOP_MINUTES + " 分钟的安全停留");
    }
    return {
      ndlLimit: limit,
      overNDL: overNDL,
      missingSafetyStop: missingSafetyStop,
      compliant: compliant,
      violations: violations
    };
  }

  // 合规潜次的新标记可直接放行；否则只能进待复核
  function initialMarkerStatus(dive) {
    return evaluateDive(dive).compliant ? STATUS.RELEASED : STATUS.PENDING;
  }

  // 潜次登记校验，takenCodes 为已占用的登记编号
  function validateDive(input, takenCodes) {
    var errors = [];
    var code = String(input.code || "").trim().toUpperCase();
    var diverA = String(input.diverA || "").trim();
    var diverB = String(input.diverB || "").trim();
    var maxDepth = Number(input.maxDepth);
    var bottomTime = Number(input.bottomTime);
    var stop = Number(input.safetyStopMinutes || 0);

    if (!/^[A-Z]+-\d{1,4}$/.test(code)) errors.push("登记编号格式应为 DIVE-04 这样的 字母-序号");
    if (takenCodes && takenCodes.indexOf(code) >= 0) errors.push("登记编号 " + code + " 已存在");
    if (!diverA) errors.push("第一名潜水员不能为空");
    if (!diverB) errors.push("第二名潜水员不能为空");
    if (diverA && diverB && diverA === diverB) errors.push("两名潜水员不能是同一人");
    if (!(maxDepth >= 1) || maxDepth > 60) errors.push("最大深度应在 1–60 米之间");
    if (!(bottomTime >= 1) || bottomTime > 600) errors.push("底部时间应在 1–600 分钟之间");
    if (input.safetyStopMinutes !== "" && input.safetyStopMinutes != null &&
        !(stop >= 0 && stop <= 30)) {
      errors.push("安全停留时长应在 0–30 分钟之间");
    }
    return errors;
  }

  // 复核校验：须换人（不能是两名潜水员中的任何一人）并填写停留深度与时长
  function validateReview(input, dive) {
    var errors = [];
    var reviewer = String(input.reviewer || "").trim();
    var depth = Number(input.stopDepth);
    var minutes = Number(input.stopMinutes);

    if (!reviewer) errors.push("复核人姓名不能为空");
    if (reviewer && (reviewer === dive.diverA.trim() || reviewer === dive.diverB.trim())) {
      errors.push("复核须换人，复核人不能是本次潜水的两名潜水员");
    }
    if (!(depth > 0) || depth >= dive.maxDepth) {
      errors.push("停留深度必须大于 0 且浅于潜次最大深度 " + dive.maxDepth + " 米");
    }
    if (!(minutes >= 1) || minutes > 60) errors.push("停留时长应在 1–60 分钟之间");
    return errors;
  }

  // 修订是否改动了会导致放行失效的字段
  function isInvalidatingRevision(current, next) {
    return INVALIDATING_FIELDS.some(function (f) {
      return Number(current[f]) !== Number(next[f]);
    });
  }

  window.DiveRules = {
    NDL_TABLE: NDL_TABLE,
    STATUS: STATUS,
    INVALIDATING_FIELDS: INVALIDATING_FIELDS,
    ndlLimit: ndlLimit,
    evaluateDive: evaluateDive,
    initialMarkerStatus: initialMarkerStatus,
    validateDive: validateDive,
    validateReview: validateReview,
    isInvalidatingRevision: isInvalidatingRevision
  };
})();
