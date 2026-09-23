/*
 * dive-records.js —— 记录仓储（唯一数据来源）
 * 职责：潜次/标记的状态机、复核换人、修订留档、幂等提交（重复/并发沿用首次结果）、
 *      localStorage 持久化与变更广播。不做任何 DOM 操作。
 */
(function () {
  "use strict";

  var Rules = window.DiveRules;
  var STATUS = Rules.STATUS;
  var STORE_KEY = "zfl30DiveConsole.v1";

  var state = null;
  var listeners = [];
  // 进行中的提交：同一幂等键的重复或并发提交沿用首次结果
  var inflight = {};
  var LATENCY_MS = 350; // 模拟提交耗时，以暴露并发窗口

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function seed() {
    var d1 = {
      id: uuid(), code: "DIVE-01", diverA: "周屿", diverB: "林潮生",
      maxDepth: 18, bottomTime: 42, safetyStopMinutes: 3,
      createdAt: new Date().toISOString(), version: 1
    };
    var d2 = {
      id: uuid(), code: "DIVE-02", diverA: "高砚", diverB: "沈青",
      maxDepth: 24, bottomTime: 40, safetyStopMinutes: 0,
      createdAt: new Date().toISOString(), version: 1
    };
    return {
      dives: [d1, d2],
      markers: [
        { id: uuid(), diveId: d1.id, code: "A-017", type: "ceramic", depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋", x: 42, y: 46, status: STATUS.RELEASED, version: 1, submittedAt: new Date().toISOString() },
        { id: uuid(), diveId: d2.id, code: "W-003", type: "wood", depth: "22.1m", orientation: "西北", condition: "稳定", note: "疑似横梁", x: 58, y: 39, status: STATUS.PENDING, version: 1, submittedAt: new Date().toISOString() },
        { id: uuid(), diveId: d2.id, code: "M-011", type: "metal", depth: "23.4m", orientation: "南", condition: "附着贝类", note: "舷侧铁板", x: 63, y: 55, status: STATUS.PENDING, version: 1, submittedAt: new Date().toISOString() }
      ],
      archives: []
    };
  }

  function load() {
    if (state) return state;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      state = raw ? JSON.parse(raw) : seed();
    } catch (e) {
      state = seed();
    }
    return state;
  }

  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    listeners.forEach(function (fn) { fn(); });
  }

  // 模拟一次有延迟的写入；inflight 保证并发提交只执行第一次
  function withIdempotency(key, producer) {
    if (inflight[key]) return inflight[key];
    var promise = new Promise(function (resolve) {
      setTimeout(function () {
        var result;
        try { result = { ok: true, data: producer() }; }
        catch (e) { result = { ok: false, error: e.message }; }
        delete inflight[key];
        resolve(result);
      }, LATENCY_MS);
    });
    inflight[key] = promise;
    return promise;
  }

  function getDive(diveId) {
    return state.dives.find(function (d) { return d.id === diveId; });
  }

  function markerKey(input) {
    return [input.diveId, input.code, input.type, input.x, input.y, input.depth]
      .join("|").trim();
  }

  // —— 查询（筛选/统计/时间线/导出共用同一快照）——
  function snapshot() {
    return JSON.parse(JSON.stringify({ dives: state.dives, markers: state.markers, archives: state.archives }));
  }

  function markersFor(diveId) {
    return state.markers.filter(function (m) { return m.diveId === diveId; });
  }

  function stats() {
    var total = state.markers.length;
    var pending = state.markers.filter(function (m) { return m.status === STATUS.PENDING; }).length;
    return { total: total, pending: pending, released: total - pending };
  }

  // —— 潜次登记 ——
  function registerDive(input) {
    var taken = state.dives.map(function (d) { return d.code; });
    var errors = Rules.validateDive(input, taken);
    if (errors.length) return Promise.resolve({ ok: false, error: errors.join("；") });

    var key = "register:" + input.code.trim().toUpperCase();
    return withIdempotency(key, function () {
      // 延迟期间可能已被并发登记写入：沿用已存在的首次结果
      var existing = state.dives.find(function (d) {
        return d.code === input.code.trim().toUpperCase();
      });
      if (existing) return { dive: existing, duplicate: true };

      var dive = {
        id: uuid(),
        code: input.code.trim().toUpperCase(),
        diverA: input.diverA.trim(),
        diverB: input.diverB.trim(),
        maxDepth: Number(input.maxDepth),
        bottomTime: Number(input.bottomTime),
        safetyStopMinutes: input.safetyStopMinutes === "" || input.safetyStopMinutes == null
          ? 0 : Number(input.safetyStopMinutes),
        createdAt: new Date().toISOString(),
        version: 1
      };
      state.dives.push(dive);
      persist();
      return { dive: dive, duplicate: false };
    });
  }

  // —— 修订潜次：改动最大深度或底部时间会让该潜次所有已放行标记失效，旧版本留档 ——
  function reviseDive(diveId, input) {
    var dive = getDive(diveId);
    if (!dive) return Promise.resolve({ ok: false, error: "潜次不存在" });

    var taken = state.dives
      .filter(function (d) { return d.id !== diveId; })
      .map(function (d) { return d.code; });
    var probe = Object.assign({}, dive, input, { code: input.code || dive.code });
    var errors = Rules.validateDive(probe, taken);
    if (errors.length) return Promise.resolve({ ok: false, error: errors.join("；") });

    var key = "revise:" + diveId + ":" + JSON.stringify(input);
    return withIdempotency(key, function () {
      var next = {
        code: (input.code || dive.code).trim().toUpperCase(),
        diverA: (input.diverA || dive.diverA).trim(),
        diverB: (input.diverB || dive.diverB).trim(),
        maxDepth: input.maxDepth != null && input.maxDepth !== "" ? Number(input.maxDepth) : dive.maxDepth,
        bottomTime: input.bottomTime != null && input.bottomTime !== "" ? Number(input.bottomTime) : dive.bottomTime,
        safetyStopMinutes: input.safetyStopMinutes != null && input.safetyStopMinutes !== ""
          ? Number(input.safetyStopMinutes) : dive.safetyStopMinutes
      };

      var invalidated = [];
      if (Rules.isInvalidatingRevision(dive, next)) {
        state.archives.push({
          kind: "diveRevision",
          at: new Date().toISOString(),
          diveId: dive.id,
          diveCode: dive.code,
          fromVersion: dive.version,
          before: {
            code: dive.code, diverA: dive.diverA, diverB: dive.diverB,
            maxDepth: dive.maxDepth, bottomTime: dive.bottomTime,
            safetyStopMinutes: dive.safetyStopMinutes
          },
          after: {
            code: next.code, diverA: next.diverA, diverB: next.diverB,
            maxDepth: next.maxDepth, bottomTime: next.bottomTime,
            safetyStopMinutes: next.safetyStopMinutes
          }
        });
        // 放行失效 → 全部回到待复核，重新换人复核后才能再次放行
        state.markers.forEach(function (m) {
          if (m.diveId === diveId && m.status === STATUS.RELEASED) {
            state.archives.push({
              kind: "releaseInvalidation",
              at: new Date().toISOString(),
              markerId: m.id, markerCode: m.code,
              diveCode: dive.code, fromVersion: m.version,
              reason: "潜次 " + dive.code + " 修订了最大深度或底部时间"
            });
            m.status = STATUS.PENDING;
            m.version += 1;
            m.review = null;
            invalidated.push(m);
          }
        });
      }

      Object.assign(dive, next);
      if (invalidated.length) dive.version += 1;
      persist();
      return { dive: dive, invalidated: invalidated };
    });
  }

  function normalizeMarker(input) {
    return {
      diveId: input.diveId,
      code: String(input.code || "").trim(),
      type: input.type,
      depth: String(input.depth || "").trim(),
      orientation: String(input.orientation || "").trim(),
      condition: String(input.condition || "").trim(),
      note: String(input.note || "").trim(),
      x: Number(input.x), y: Number(input.y)
    };
  }

  // —— 提交标记：重复或并发提交沿用首次结果；不合规潜次只进待复核 ——
  function submitMarker(input) {
    var dive = getDive(input.diveId);
    if (!dive) return Promise.resolve({ ok: false, error: "请先选择潜次" });
    var data = normalizeMarker(input);
    if (!data.code) return Promise.resolve({ ok: false, error: "标记编号不能为空" });
    if (!data.type) return Promise.resolve({ ok: false, error: "请选择标记类型" });
    if (!(data.x >= 0 && data.x <= 100 && data.y >= 0 && data.y <= 100)) {
      return Promise.resolve({ ok: false, error: "标记位置无效" });
    }
    if (!data.depth) return Promise.resolve({ ok: false, error: "标记深度不能为空" });

    var naturalKey = markerKey(data);
    var key = "marker:" + naturalKey;
    // 同步预查重：并发提交在首次落库前也能命中并复用同一 Promise
    if (inflight[key]) return inflight[key];
    var preExisting = state.markers.find(function (m) { return markerKey(m) === naturalKey; });
    if (preExisting) return Promise.resolve({ ok: true, data: { marker: preExisting, duplicate: true } });

    return withIdempotency(key, function () {
      // 落库时再查一次（延迟期间可能被其他流程写入）
      var existing = state.markers.find(function (m) {
        return markerKey(m) === markerKey(data);
      });
      if (existing) return { marker: existing, duplicate: true };

      var marker = Object.assign({
        id: uuid(),
        status: Rules.initialMarkerStatus(dive),
        version: 1,
        review: null,
        submittedAt: new Date().toISOString()
      }, data);
      state.markers.push(marker);
      persist();
      return { marker: marker, duplicate: false };
    });
  }

  // —— 复核放行：须换人并填写停留深度与时长 ——
  function reviewMarker(markerId, input) {
    var marker = state.markers.find(function (m) { return m.id === markerId; });
    if (!marker) return Promise.resolve({ ok: false, error: "标记不存在" });
    if (marker.status === STATUS.RELEASED) {
      return Promise.resolve({ ok: false, error: "标记已放行，沿用首次复核结果" });
    }
    var dive = getDive(marker.diveId);
    var errors = Rules.validateReview(input, dive);
    if (errors.length) return Promise.resolve({ ok: false, error: errors.join("；") });

    var key = "review:" + markerId;
    return withIdempotency(key, function () {
      // 并发复核时状态可能已被首次调用改变 → 沿用首次结果
      if (marker.status === STATUS.RELEASED) return { marker: marker, duplicate: true };
      marker.review = {
        reviewer: input.reviewer.trim(),
        stopDepth: Number(input.stopDepth),
        stopMinutes: Number(input.stopMinutes),
        note: String(input.note || "").trim(),
        at: new Date().toISOString()
      };
      marker.status = STATUS.RELEASED;
      persist();
      return { marker: marker, duplicate: false };
    });
  }

  // 编辑标记信息（位置、描述等）：保留 id、放行状态、版本与复核记录；
  // 放行失效只由潜次深度/底部时间修订触发。
  function updateMarker(markerId, input) {
    var marker = state.markers.find(function (m) { return m.id === markerId; });
    if (!marker) return Promise.resolve({ ok: false, error: "标记不存在" });
    // 不允许借编辑改挂潜次，放行状态只能由潜次修订/复核流程改变
    var data = normalizeMarker(Object.assign({}, marker, input, { diveId: marker.diveId }));
    if (!data.code) return Promise.resolve({ ok: false, error: "标记编号不能为空" });
    if (!data.depth) return Promise.resolve({ ok: false, error: "标记深度不能为空" });

    var key = "update:" + markerId;
    return withIdempotency(key, function () {
      Object.assign(marker, data);
      persist();
      return { marker: marker };
    });
  }

  function deleteMarker(markerId) {
    var before = state.markers.length;
    state.markers = state.markers.filter(function (m) { return m.id !== markerId; });
    if (state.markers.length !== before) persist();
    return Promise.resolve({ ok: true });
  }

  // 导出：只含已放行标记；待复核只给计数，不进时间线与导出明细
  function exportPayload() {
    var released = state.markers.filter(function (m) { return m.status === STATUS.RELEASED; });
    return {
      generatedAt: new Date().toISOString(),
      dives: state.dives.map(function (d) {
        var e = Rules.evaluateDive(d);
        return {
          code: d.code, diverA: d.diverA, diverB: d.diverB,
          maxDepth: d.maxDepth, bottomTime: d.bottomTime,
          safetyStopMinutes: d.safetyStopMinutes, version: d.version,
          ndlLimit: e.ndlLimit, compliant: e.compliant, violations: e.violations
        };
      }),
      markers: released.map(function (m) {
        var dive = getDive(m.diveId);
        return {
          code: m.code, type: m.type, dive: dive ? dive.code : null,
          depth: m.depth, orientation: m.orientation, condition: m.condition,
          note: m.note, x: m.x, y: m.y, version: m.version,
          reviewedBy: m.review ? m.review.reviewer : null
        };
      }),
      excludedPendingCount: state.markers.length - released.length
    };
  }

  function subscribe(fn) { listeners.push(fn); }

  load();
  window.DiveRecords = {
    subscribe: subscribe,
    snapshot: snapshot,
    stats: stats,
    markersFor: markersFor,
    registerDive: registerDive,
    reviseDive: reviseDive,
    submitMarker: submitMarker,
    updateMarker: updateMarker,
    reviewMarker: reviewMarker,
    deleteMarker: deleteMarker,
    exportPayload: exportPayload
  };
})();
