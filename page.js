/*
 * page.js —— 页面层（DOM 渲染与交互；只调用 records / rules，不直接操作 localStorage）
 */
(function () {
  "use strict";

  var R = window.DiveRules;
  var D = window.DiveRecords;
  var db = D.load();
  var pendingPos = null;       // 平面图上待保存的点击位置
  var editingMarkId = null;    // 正在编辑的标记
  var revisingDiveCode = null; // 正在修订的潜次编号
  var submitting = false;
  var PREF_KEY = "zfl30.diveDesk.prefs";

  var TYPE_NAMES = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  var STATUS_TEXT = { released: "已放行", pending: "待复核" };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (e) { return {}; }
  }
  function savePrefs() {
    localStorage.setItem(PREF_KEY, JSON.stringify({ type: $("#filter").value, view: $("#view").value }));
  }

  /* ---------------- Toast ---------------- */

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $("#toast");
    el.textContent = msg;
    el.className = "toast show " + (kind || "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 3200);
  }

  /* ---------------- 潜次表 ---------------- */

  function renderDives() {
    var dives = D.listDives(db);
    $("#diveCount").textContent = dives.length + " 个潜次 · "
      + dives.filter(function (d) { return d.flagged; }).length + " 个待复核 · 留档 "
      + D.listArchive(db).length + " 个旧版本";

    $("#diveRows").innerHTML = dives.map(function (d) {
      var review = D.findReview(db, d.code);
      var statusClass = d.flagged ? (review ? "ok" : "warn") : "ok";
      var statusText = d.flagged ? (review ? "已放行（换人复核）" : "待复核") : "合规·自动放行";
      var ndlText = d.evaluation.ndl === 0 ? "须减压" : "免减压限值 " + d.evaluation.ndl + " min";
      var reason = d.flagged && !review
        ? '<div class="reason">' + d.evaluation.reasons.map(esc).join("；") + "</div>" : "";
      var reviewBtn = d.flagged && !review
        ? '<button type="button" class="mini" data-act="review" data-code="' + esc(d.code) + '">复核放行</button>' : "";
      var reviewLine = review
        ? '<div class="muted">复核：' + esc(review.reviewer) + ' · 停留 ' + review.stopDepth + 'm/'
          + review.stopMinutes + 'min</div>' : "";
      return '<tr>'
        + '<td><b>' + esc(d.code) + '</b><span class="muted"> v' + d.version + '</span></td>'
        + '<td>' + esc(d.diverA) + ' / ' + esc(d.diverB) + '</td>'
        + '<td>' + d.maxDepth + ' m</td>'
        + '<td>' + d.bottomTime + ' min</td>'
        + '<td class="muted">' + (d.safetyStop ? "5m/3min 已做" : "未做") + '<br>' + ndlText + '</td>'
        + '<td><span class="pill ' + statusClass + '">' + statusText + '</span>'
        + '<div class="muted">标记 ' + d.markCount + ' · 待复核 ' + d.pendingCount + '</div>'
        + reviewLine + reason + '</td>'
        + '<td class="row-actions">' + reviewBtn
        + '<button type="button" class="mini secondary" data-act="revise" data-code="' + esc(d.code) + '">修订</button></td>'
        + "</tr>";
    }).join("");

    renderArchive();
  }

  function renderArchive() {
    var arch = D.listArchive(db);
    $("#archiveBox").innerHTML = arch.length
      ? '<details><summary>旧版本留档（' + arch.length + '，不参与时间线与导出）</summary>'
        + arch.map(function (a) {
            return '<div class="archive-item"><b>' + esc(a.dive.code) + ' v' + a.dive.version + '</b>'
              + ' <span class="muted">' + esc(a.at.replace("T", " ").slice(0, 19)) + '</span>'
              + '<div class="muted">' + esc(a.reason) + '</div>'
              + '<div class="muted">旧标记 ' + a.marks.length + ' 个'
              + (a.review ? ' · 旧复核人 ' + esc(a.review.reviewer) : "") + '</div></div>';
          }).join("") + "</details>"
      : '<div class="muted">暂无留档；修订最大深度或底部时间后，旧版本（潜次/标记/复核）会在此留档。</div>';
  }

  /* ---------------- 潜次登记表单 ---------------- */

  var diveForm = $("#diveForm");

  function readDiveForm() {
    return {
      code: $("#diveCode").value,
      diverA: $("#diverA").value,
      diverB: $("#diverB").value,
      maxDepth: $("#maxDepth").value,
      bottomTime: $("#bottomTime").value,
      safetyStop: $("#safetyStop").checked,
      recorder: $("#recorder").value
    };
  }

  function fillDiveForm(d) {
    $("#diveCode").value = d.code;
    $("#diverA").value = d.diverA;
    $("#diverB").value = d.diverB;
    $("#maxDepth").value = d.maxDepth;
    $("#bottomTime").value = d.bottomTime;
    $("#safetyStop").checked = !!d.safetyStop;
    $("#recorder").value = d.recorder;
    updateNdlHint();
  }

  function updateNdlHint() {
    var depth = R.toNumber($("#maxDepth").value);
    var time = R.toNumber($("#bottomTime").value);
    var hint = $("#ndlHint");
    if (!Number.isFinite(depth)) { hint.className = "hint muted"; hint.textContent = "输入深度后显示免减压限值"; return; }
    var ndl = R.ndlFor(depth);
    var eval0 = R.evaluateDive({ maxDepth: depth, bottomTime: time, safetyStop: $("#safetyStop").checked });
    if (eval0.flagged) {
      hint.className = "hint bad";
      hint.textContent = "将进入待复核：" + eval0.reasons.join("；");
    } else {
      hint.className = "hint ok";
      hint.textContent = "合规范围：" + (ndl === 0 ? "该深度须减压" : "底部时间不超过 " + ndl + " 分钟")
        + (eval0.needsSafetyStop ? "；须有安全停留" : "");
    }
  }

  $("#maxDepth").addEventListener("input", updateNdlHint);
  $("#bottomTime").addEventListener("input", updateNdlHint);
  $("#safetyStop").addEventListener("change", updateNdlHint);

  $("#resetDiveBtn").addEventListener("click", function () {
    revisingDiveCode = null;
    diveForm.reset();
    $("#diveCode").disabled = false;
    $("#diveSubmitBtn").textContent = "登记潜次";
    $("#reviseBanner").hidden = true;
    updateNdlHint();
  });

  diveForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (submitting) { toast("正在提交中，请勿重复点击（并发提交将沿用首次结果）", "warn"); return; }
    submitting = true;
    $("#diveSubmitBtn").disabled = true;

    var done = function (res) {
      submitting = false;
      $("#diveSubmitBtn").disabled = false;
      if (!res.ok) { toast(res.errors.join("；"), "bad"); return; }
      if (revisingDiveCode) {
        toast("潜次 " + res.dive.code + " 已修订为 v" + res.version
          + (res.archived ? "，旧版本已留档、旧放行与导出失效" : "")
          + (res.flagged ? "；标记重新进入待复核" : "；标记自动放行"), res.archived ? "warn" : "ok");
        $("#resetDiveBtn").click();
      } else {
        toast("潜次 " + res.dive.code + (res.deduplicated ? " 已存在，沿用首次登记结果" : " 登记成功")
          + (R.evaluateDive(res.dive).flagged ? "；超限/缺安全停留，标记只进待复核" : "；合规，标记自动放行"),
          res.deduplicated ? "warn" : "ok");
        if (!res.deduplicated) diveForm.reset();
        updateNdlHint();
      }
      renderAll();
    };

    if (revisingDiveCode) {
      done(D.reviseDive(db, revisingDiveCode, readDiveForm()));
    } else {
      D.submitDive(db, readDiveForm()).then(done);
    }
  });

  $("#diveRows").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var code = btn.dataset.code;
    if (btn.dataset.act === "revise") {
      var dive = D.getDive(db, code);
      revisingDiveCode = code;
      fillDiveForm(dive);
      $("#diveCode").disabled = true;
      $("#diveSubmitBtn").textContent = "提交修订";
      $("#reviseBanner").hidden = false;
      $("#reviseBanner").textContent = "修订模式：修改最大深度或底部时间将使标记与导出失效，旧 v"
        + dive.version + " 留档；其他字段变更不留档。";
      diveForm.scrollIntoView({ behavior: "smooth" });
    } else if (btn.dataset.act === "review") {
      openReview(code);
    }
  });

  /* ---------------- 复核放行弹窗（换人 + 停留深度/时长） ---------------- */

  var reviewModal = $("#reviewModal");
  var reviewCode = null;

  function openReview(code) {
    var dive = D.getDive(db, code);
    reviewCode = code;
    $("#rvTitle").textContent = "复核放行 " + code;
    $("#rvInfo").innerHTML = '<div class="muted">' + esc(dive.diverA) + ' / ' + esc(dive.diverB)
      + " · " + dive.maxDepth + "m · " + dive.bottomTime + "min · 登记人 " + esc(dive.recorder) + "</div>"
      + '<div class="reason">' + R.evaluateDive(dive).reasons.map(esc).join("；") + "</div>";
    $("#reviewerName").value = "";
    $("#reviewerName").placeholder = "复核人（不能与登记人「" + dive.recorder + "」相同）";
    $("#stopDepth").value = "5";
    $("#stopMinutes").value = R.SAFETY_STOP_MINUTES;
    $("#rvNote").value = "";
    $("#rvError").textContent = "";
    reviewModal.showModal();
  }

  $("#rvCancel").addEventListener("click", function () { reviewModal.close(); });
  $("#rvSubmit").addEventListener("click", function () {
    var res = D.releaseDive(db, reviewCode, {
      reviewer: $("#reviewerName").value,
      stopDepth: $("#stopDepth").value,
      stopMinutes: $("#stopMinutes").value,
      note: $("#rvNote").value
    });
    if (!res.ok) { $("#rvError").textContent = res.errors.join("；"); return; }
    reviewModal.close();
    toast("潜次 " + reviewCode + " 复核通过、标记放行，已计入时间线与导出", "ok");
    renderAll();
  });

  /* ---------------- 平面图与标记 ---------------- */

  var map = $("#map");
  var markForm = $("#markForm");

  for (var i = 0; i < 7; i++) {
    var rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    map.appendChild(rib);
  }

  function renderMap() {
    $all(".marker", map).forEach(function (el) { el.remove(); });
    var type = $("#filter").value;
    D.listMarks(db, { type: type }).forEach(function (m) {
      var el = document.createElement("button");
      el.className = "marker " + m.type + (m.state === "pending" ? " pending" : "")
        + (m.id === editingMarkId ? " selected" : "");
      el.style.left = m.x + "%";
      el.style.top = m.y + "%";
      el.title = m.code + "（" + STATUS_TEXT[m.state] + "）";
      el.textContent = m.code.slice(0, 2);
      el.addEventListener("click", function (ev) { ev.stopPropagation(); editMark(m.id); });
      map.appendChild(el);
    });
  }

  map.addEventListener("click", function (e) {
    var rect = map.getBoundingClientRect();
    pendingPos = {
      x: Number(((e.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((e.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    editingMarkId = null;
    markForm.reset();
    syncDiveOptions("");
    $("#markId").value = "";
    $("#markCode").value = "M-" + String(db.marks.length + 1).padStart(3, "0");
    $("#markDepth").value = "";
    $("#posHint").textContent = "已选位置 (" + pendingPos.x + "%, " + pendingPos.y + "%)";
    renderAll();
  });

  function editMark(id) {
    var m = db.marks.find(function (x) { return x.id === id; });
    if (!m) return;
    editingMarkId = id;
    pendingPos = { x: m.x, y: m.y };
    $("#markId").value = m.id;
    syncDiveOptions(m.diveCode);
    $("#markCode").value = m.code;
    $("#markType").value = m.type;
    $("#markDepth").value = m.depth;
    $("#orientation").value = m.orientation;
    $("#condition").value = m.condition;
    $("#note").value = m.note;
    $("#posHint").textContent = "标记位置 (" + m.x + "%, " + m.y + "%)，不可移动";
    var state = D.decorateMark(db, m).state;
    $("#posHint").textContent += "；当前：" + STATUS_TEXT[state]
      + (state === "pending" ? "（不计入时间线和导出）" : "");
    renderAll();
  }

  // 潜次下拉只列已登记潜次，同时显示状态。
  function syncDiveOptions(selectCode) {
    var sel = $("#markDive");
    sel.innerHTML = '<option value="">选择潜次</option>' + D.listDives(db).map(function (d) {
      var review = D.findReview(db, d.code);
      var label = d.code + " " + d.maxDepth + "m/" + d.bottomTime + "min · "
        + (d.flagged ? (review ? "已放行" : "待复核") : "合规");
      return '<option value="' + esc(d.code) + '"' + (d.code === selectCode ? " selected" : "") + '>'
        + esc(label) + "</option>";
    }).join("");
  }

  markForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!pendingPos) { toast("请先在平面图上点击选择位置", "bad"); return; }
    var payload = {
      code: $("#markCode").value,
      type: $("#markType").value,
      diveCode: $("#markDive").value,
      x: pendingPos.x, y: pendingPos.y,
      depth: $("#markDepth").value,
      orientation: $("#orientation").value,
      condition: $("#condition").value,
      note: $("#note").value
    };
    var done = function (res) {
      if (!res.ok) { toast(res.errors.join("；"), "bad"); return; }
      toast("标记 " + res.mark.code + " " + (res.deduplicated ? "重复提交，沿用首次结果" : "已保存")
        + (res.mark.state === "pending" ? "；潜次待复核，仅待复核不导出" : "；已放行"),
        res.mark.state === "pending" ? "warn" : "ok");
      editingMarkId = null;
      pendingPos = null;
      markForm.reset();
      $("#posHint").textContent = "点击平面图选择位置";
      renderAll();
    };
    if (editingMarkId) done(D.updateMark(db, editingMarkId, payload));
    else D.submitMark(db, payload).then(done);
  });

  $("#deleteMarkBtn").addEventListener("click", function () {
    if (!editingMarkId) return;
    D.deleteMark(db, editingMarkId);
    editingMarkId = null;
    pendingPos = null;
    markForm.reset();
    $("#posHint").textContent = "点击平面图选择位置";
    toast("标记已删除", "ok");
    renderAll();
  });

  /* ---------------- 列表 / 时间线 ---------------- */

  function renderList() {
    var type = $("#filter").value;
    var items = D.listMarks(db, { type: type });
    $("#listTitle").textContent = "标记列表（含待复核）";
    $("#dataList").className = "list";
    if (!items.length) { $("#dataList").innerHTML = '<div class="muted">没有匹配标记</div>'; return; }
    $("#dataList").innerHTML = items.map(function (m) {
      return '<div class="item ' + (m.id === editingMarkId ? "active" : "") + '" data-id="' + m.id + '">'
        + '<b>' + esc(m.code) + '</b> <span class="pill">' + TYPE_NAMES[m.type] + '</span> '
        + '<span class="pill ' + (m.state === "released" ? "ok" : "warn") + '">' + STATUS_TEXT[m.state] + '</span>'
        + '<div class="muted">' + esc(m.diveCode) + ' v' + m.version + ' · ' + esc(m.depth) + ' · '
        + esc(m.orientation || "—") + '</div></div>';
    }).join("");
    $all("[data-id]", $("#dataList")).forEach(function (el) {
      el.addEventListener("click", function () { editMark(el.dataset.id); });
    });
  }

  function renderTimeline() {
    var type = $("#filter").value;
    var groups = D.timeline(db, { type: type });
    $("#listTitle").textContent = "潜次时间线（仅放行）";
    $("#dataList").className = "timeline";
    if (!groups.length) {
      $("#dataList").innerHTML = '<div class="muted">暂无已放行数据：待复核标记须经换人复核后才进入时间线。</div>';
      return;
    }
    $("#dataList").innerHTML = groups.map(function (g) {
      return '<div class="item"><b>' + esc(g.diveCode) + '</b> <span class="muted">v' + g.version
        + ' · ' + g.maxDepth + 'm · ' + g.bottomTime + 'min</span>'
        + (g.review ? ' <span class="pill ok">复核 ' + esc(g.review.reviewer) + ' · '
          + g.review.stopDepth + 'm/' + g.review.stopMinutes + 'min</span>' : ' <span class="pill">合规</span>')
        + '<div class="muted">放行 ' + g.marks.length + ' 个标记</div>'
        + g.marks.map(function (m) {
            return '<div>' + esc(m.code) + ' · ' + TYPE_NAMES[m.type] + ' · ' + esc(m.depth) + '</div>';
          }).join("") + "</div>";
    }).join("");
  }

  /* ---------------- 统计 / 筛选 / 导出（口径一致） ---------------- */

  function renderStats() {
    var s = D.stats(db, { type: $("#filter").value });
    $("#statBar").innerHTML =
      stat("潜次", s.divesTotal, s.divesFlagged, "待复核")
      + stat("标记", s.marksTotal, s.marksPending, "待复核")
      + stat("放行", s.marksReleased, null, null, "ok")
      + stat("留档版本", s.archivedVersions, null, null)
      + '<span class="stat muted">陶片 ' + s.byType.ceramic + ' · 木构件 ' + s.byType.wood
      + ' · 金属件 ' + s.byType.metal + ' · 未知 ' + s.byType.unknown + '</span>';
  }

  function stat(label, value, warn, warnLabel, forceClass) {
    var cls = forceClass || (warn ? "warn" : "ok");
    return '<span class="stat"><span class="stat-label">' + label + '</span><b>' + value + '</b>'
      + (warn ? '<span class="pill ' + cls + '">' + warn + ' ' + warnLabel + '</span>' : "") + '</span>';
  }

  $("#filter").addEventListener("change", function () { savePrefs(); renderAll(); });
  $("#view").addEventListener("change", function () { savePrefs(); renderAll(); });

  $("#exportBtn").addEventListener("click", function () {
    var type = $("#filter").value;
    var json = D.exportJSON(db, { type: type });
    var blob = new Blob([json], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dive-marks-released" + (type ? "-" + type : "") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    var s = D.stats(db, { type: type });
    toast("已按当前筛选导出 " + s.marksReleased + " 个放行标记；待复核与旧版本不导出", "ok");
  });

  /* ---------------- 总渲染 ---------------- */

  function renderAll() {
    renderDives();
    renderStats();
    renderMap();
    if ($("#view").value === "timeline") renderTimeline();
    else renderList();
  }

  (function init() {
    var prefs = loadPrefs();
    if (prefs.type) $("#filter").value = prefs.type;
    if (prefs.view) $("#view").value = prefs.view;
    syncDiveOptions($("#markDive").value);
    $("#posHint").textContent = "点击平面图选择位置";
    updateNdlHint();
    renderAll();
  })();
})();
