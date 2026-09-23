/*
 * app.js —— 页面交互
 * 职责：渲染、表单、筛选/统计/时间线/导出。所有数据经 DiveRecords 读写，
 *      订阅仓储变更后整页重渲染，保证筛选、统计与刷新状态一致。
 */
(function () {
  "use strict";

  var R = window.DiveRecords;
  var Rules = window.DiveRules;
  var STATUS = Rules.STATUS;
  var UI_KEY = "zfl30DiveConsole.ui";

  var typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  var statusNames = { pending: "待复核", released: "已放行" };

  // 界面状态（筛选条件持久化，刷新后保持一致）
  var ui = loadUi();
  var pendingPoint = null; // 地图上待保存的坐标
  var editId = null;
  var busy = false;

  function loadUi() {
    try {
      return Object.assign(
        { type: "", status: "", diveId: "", view: "list" },
        JSON.parse(localStorage.getItem(UI_KEY) || "{}")
      );
    } catch (e) {
      return { type: "", status: "", diveId: "", view: "list" };
    }
  }
  function saveUi() { localStorage.setItem(UI_KEY, JSON.stringify(ui)); }

  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // —— 筛选：列表、地图、统计共用同一份过滤结果 ——
  function currentData() {
    var snap = R.snapshot();
    var markers = snap.markers.filter(function (m) {
      if (ui.type && m.type !== ui.type) return false;
      if (ui.status && m.status !== ui.status) return false;
      if (ui.diveId && m.diveId !== ui.diveId) return false;
      return true;
    });
    return {
      dives: snap.dives,
      archives: snap.archives,
      markers: markers,
      diveById: function (id) { return snap.dives.find(function (d) { return d.id === id; }); }
    };
  }

  function render() {
    var data = currentData();
    renderDiveSelect(data);
    renderMap(data);
    renderStats(data);
    renderView(data);
    saveUi();
  }

  function renderDiveSelect(data) {
    var sel = $("#diveSelect");
    sel.innerHTML = '<option value="">选择潜次</option>' + data.dives.map(function (d) {
      var e = Rules.evaluateDive(d);
      return '<option value="' + d.id + '"' + (d.id === ui.diveId ? " selected" : "") + ">" +
        esc(d.code) + " · " + d.maxDepth + "m/" + d.bottomTime + "min" +
        (e.compliant ? "" : " · 超限") + "</option>";
    }).join("");
  }

  function renderStats(data) {
    var total = data.markers.length;
    var pending = data.markers.filter(function (m) { return m.status === STATUS.PENDING; }).length;
    var global = R.stats();
    $("#stats").innerHTML =
      '<span class="pill">筛选结果 ' + total + "</span>" +
      '<span class="pill pending">待复核 ' + pending + "</span>" +
      '<span class="pill released">已放行 ' + (total - pending) + "</span>" +
      '<span class="muted">（全库共 ' + global.total + " 个标记，" + global.pending + " 个待复核）</span>";
  }

  function renderMap(data) {
    var map = $("#map");
    map.querySelectorAll(".marker").forEach(function (el) { el.remove(); });
    data.markers.forEach(function (m) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "marker " + m.type +
        (m.status === STATUS.PENDING ? " pending" : "") +
        (m.id === editId ? " selected" : "");
      el.style.left = m.x + "%";
      el.style.top = m.y + "%";
      el.textContent = m.code.slice(0, 2);
      el.title = m.code + "（" + statusNames[m.status] + "）";
      el.onclick = function (ev) { ev.stopPropagation(); editMarker(m.id); };
      map.appendChild(el);
    });
    if (pendingPoint) {
      var ghost = document.createElement("div");
      ghost.className = "marker ghost";
      ghost.style.left = pendingPoint.x + "%";
      ghost.style.top = pendingPoint.y + "%";
      ghost.textContent = "新";
      map.appendChild(ghost);
    }
  }

  function markerRow(m, data) {
    var dive = data.diveById(m.diveId);
    var badge = m.status === STATUS.PENDING
      ? '<span class="pill pending">待复核</span>'
      : '<span class="pill released">已放行 v' + m.version + "</span>";
    return '<div class="item ' + (m.id === editId ? "active" : "") + '" data-id="' + m.id + '">' +
      "<b>" + esc(m.code) + "</b> <span class='pill'>" + typeNames[m.type] + "</span> " + badge +
      '<div class="muted">' + esc(dive ? dive.code : "?") + " · " + esc(m.depth) + " · " +
      esc(m.orientation || "—") + "</div>" +
      "<div>" + esc(m.condition || "") + "</div>" +
      (m.review ? '<div class="muted">复核：' + esc(m.review.reviewer) + "，停留 " +
        m.review.stopDepth + "m × " + m.review.stopMinutes + "min</div>" : "") +
      "</div>";
  }

  function renderView(data) {
    var host = $("#viewPanel");
    if (ui.view === "timeline") host.innerHTML = timelineHtml(data);
    else if (ui.view === "review") host.innerHTML = reviewHtml(data);
    else if (ui.view === "dives") host.innerHTML = divesHtml(data);
    else host.innerHTML = listHtml(data);
    bindViewEvents(host, data);
  }

  function listHtml(data) {
    if (!data.markers.length) return "<h2>标记列表</h2><p class='muted'>当前筛选无标记。</p>";
    return "<h2>标记列表</h2><div class='list'>" +
      data.markers.map(function (m) { return markerRow(m, data); }).join("") + "</div>";
  }

  // 时间线只计入已放行标记，待复核明确排除
  function timelineHtml(data) {
    var released = data.markers.filter(function (m) { return m.status === STATUS.RELEASED; });
    var pending = data.markers.length - released.length;
    var groups = released.reduce(function (g, m) {
      (g[m.diveId] || (g[m.diveId] = [])).push(m);
      return g;
    }, {});
    var body = Object.keys(groups).length
      ? Object.entries(groups).map(function (pair) {
          var dive = data.diveById(pair[0]);
          var items = pair[1];
          return '<div class="item"><b>' + esc(dive ? dive.code : "?") + "</b>" +
            '<div class="muted">计入 ' + items.length + " 个已放行标记</div>" +
            items.map(function (i) {
              return "<div>" + esc(i.code) + " · " + typeNames[i.type] +
                " · " + esc(i.depth) + "</div>";
            }).join("") + "</div>";
        }).join("")
      : "<p class='muted'>没有可计入时间线的已放行标记。</p>";
    return "<h2>潜次时间线</h2>" +
      (pending ? '<p class="warn">' + pending + " 个待复核标记未计入时间线。</p>" : "") +
      "<div class='timeline'>" + body + "</div>";
  }

  function reviewHtml(data) {
    var pending = data.markers.filter(function (m) { return m.status === STATUS.PENDING; });
    var body;
    if (!pending.length) {
      body = "<p class='muted'>没有待复核标记。</p>";
    } else {
      body = pending.map(function (m) {
        var dive = data.diveById(m.diveId);
        var e = dive ? Rules.evaluateDive(dive) : { violations: [] };
        return '<div class="item review-card" data-review="' + m.id + '">' +
          "<b>" + esc(m.code) + "</b> <span class='pill'>" + typeNames[m.type] + "</span>" +
          '<span class="pill pending">待复核 v' + m.version + "</span>" +
          '<div class="muted">' + esc(dive ? dive.code : "?") + " · 潜水员：" +
            esc(dive ? dive.diverA : "") + " / " + esc(dive ? dive.diverB : "") + "</div>" +
          (e.violations.length ? '<div class="warn">' + e.violations.map(esc).join("；") + "</div>" : "") +
          '<label>复核人（不得是两名潜水员）</label><input class="f-reviewer" required>' +
          '<div class="two-col"><div><label>停留深度 (m)</label><input class="f-stopDepth" type="number" step="0.1" required></div>' +
          '<div><label>停留时长 (min)</label><input class="f-stopMinutes" type="number" step="1" required></div></div>' +
          "<label>复核备注</label><textarea class='f-note'></textarea>" +
          '<button class="review-btn">复核通过并放行</button></div>';
      }).join("");
    }
    return "<h2>待复核放行台</h2><p class='muted'>复核须换人，并填写停留深度与时长；放行后标记才计入时间线与导出。</p>" +
      "<div class='list'>" + body + "</div>";
  }

  function divesHtml(data) {
    return "<h2>潜次登记</h2>" +
      '<form id="diveForm" class="dive-form">' +
      '<div class="two-col"><div><label>登记编号</label><input name="code" placeholder="DIVE-03" required></div>' +
      '<div><label>安全停留 (min)</label><input name="safetyStopMinutes" type="number" min="0" max="30" value="0"></div></div>' +
      '<div class="two-col"><div><label>潜水员一</label><input name="diverA" required></div>' +
      '<div><label>潜水员二</label><input name="diverB" required></div></div>' +
      '<div class="two-col"><div><label>最大深度 (m)</label><input name="maxDepth" type="number" step="0.1" min="1" max="60" required></div>' +
      '<div><label>底部时间 (min)</label><input name="bottomTime" type="number" min="1" max="600" required></div></div>' +
      "<button>登记潜次</button></form>" +
      "<h2>已登记潜次</h2><div class='list'>" +
      data.dives.map(function (d) { return diveCard(d, data); }).join("") + "</div>" +
      archiveHtml(data);
  }

  function diveCard(d, data) {
    var e = Rules.evaluateDive(d);
    var ms = R.markersFor(d.id);
    var pending = ms.filter(function (m) { return m.status === STATUS.PENDING; }).length;
    return '<div class="item">' +
      "<b>" + esc(d.code) + "</b> v" + d.version + " " +
      (e.compliant ? '<span class="pill released">免减压合规</span>' : '<span class="pill pending">待复核潜次</span>') +
      '<div class="muted">潜水员：' + esc(d.diverA) + " / " + esc(d.diverB) + "　最大深度 " +
        d.maxDepth + "m（限值 " + e.ndlLimit + "min）　底部时间 " + d.bottomTime +
        "min　安全停留 " + d.safetyStopMinutes + "min</div>" +
      (e.violations.length ? '<div class="warn">' + e.violations.map(esc).join("；") + "</div>" : "") +
      '<div class="muted">标记 ' + ms.length + " 个（待复核 " + pending + '）</div>' +
      '<button type="button" class="secondary revise-toggle" data-code="' + esc(d.code) + '">修订深度/时间</button>' +
      '<form class="revise-form" data-dive="' + d.id + '" hidden>' +
      '<div class="two-col"><div><label>最大深度 (m)</label><input name="maxDepth" type="number" step="0.1" value="' + d.maxDepth + '"></div>' +
      '<div><label>底部时间 (min)</label><input name="bottomTime" type="number" value="' + d.bottomTime + '"></div></div>' +
      '<div class="two-col"><div><label>安全停留 (min)</label><input name="safetyStopMinutes" type="number" min="0" max="30" value="' + d.safetyStopMinutes + '"></div>' +
      '<div><label>编号（改名）</label><input name="code" value="' + esc(d.code) + '"></div></div>' +
      '<button>提交修订</button><span class="muted">改动深度或底部时间将使已放行标记失效，旧版本留档。</span></form>' +
      "</div>";
  }

  function archiveHtml(data) {
    if (!data.archives.length) return "";
    return "<h2>留档记录</h2><div class='list archive'>" + data.archives.map(function (a) {
      if (a.kind === "diveRevision") {
        return '<div class="item"><b>' + esc(a.diveCode) + "</b> v" + a.fromVersion +
          ' <span class="pill">潜次修订留档</span>' +
          '<div class="muted">' + new Date(a.at).toLocaleString() + "　" +
          a.before.maxDepth + "m/" + a.before.bottomTime + "min → " +
          a.after.maxDepth + "m/" + a.after.bottomTime + "min</div></div>";
      }
      return '<div class="item"><b>' + esc(a.markerCode) + "</b>" +
        ' <span class="pill pending">放行失效</span>' +
        '<div class="muted">' + new Date(a.at).toLocaleString() + "　" + esc(a.reason) +
        "（原 v" + a.fromVersion + "，退回待复核）</div></div>";
    }).join("") + "</div>";
  }

  // —— 事件绑定 ——
  function bindViewEvents(host, data) {
    host.querySelectorAll("[data-id]").forEach(function (el) {
      el.onclick = function () {
        if (ui.view !== "review") editMarker(el.dataset.id);
      };
    });
    host.querySelectorAll(".revise-toggle").forEach(function (btn) {
      btn.onclick = function () {
        var form = btn.parentElement.querySelector(".revise-form");
        form.hidden = !form.hidden;
      };
    });
    host.querySelectorAll(".revise-form").forEach(function (form) {
      form.onsubmit = function (ev) {
        ev.preventDefault();
        var input = Object.fromEntries(new FormData(form).entries());
        guard(R.reviseDive(form.dataset.dive, input), function (res) {
          toast(res.invalidated.length
            ? "已修订，" + res.invalidated.length + " 个标记放行失效并留档，退回待复核"
            : "潜次已更新");
        });
      };
    });
    var diveForm = $("#diveForm");
    if (diveForm) {
      diveForm.onsubmit = function (ev) {
        ev.preventDefault();
        var input = Object.fromEntries(new FormData(diveForm).entries());
        guard(R.registerDive(input), function (res) {
          if (res.duplicate) toast("重复登记，沿用首次结果：" + res.data.dive.code);
          else toast("潜次 " + res.data.dive.code + " 已登记");
          diveForm.reset(); diveForm.safetyStopMinutes.value = 0;
        });
      };
    }
    host.querySelectorAll(".review-card").forEach(function (card) {
      card.querySelector(".review-btn").onclick = function () {
        var markerId = card.dataset.review;
        var input = {
          reviewer: card.querySelector(".f-reviewer").value,
          stopDepth: card.querySelector(".f-stopDepth").value,
          stopMinutes: card.querySelector(".f-stopMinutes").value,
          note: card.querySelector(".f-note").value
        };
        guard(R.reviewMarker(markerId, input), function (res) {
          toast(res.duplicate ? "并发复核，沿用首次放行结果" : "复核通过，标记已放行");
        });
      };
    });
  }

  function editMarker(id) {
    var snap = R.snapshot();
    var m = snap.markers.find(function (x) { return x.id === id; });
    if (!m) return;
    editId = id;
    pendingPoint = { x: m.x, y: m.y };
    ui.diveId = m.diveId;
    var form = $("#markerForm");
    form.elements.id.value = m.id;
    form.elements.code.value = m.code;
    form.elements.type.value = m.type;
    form.elements.depth.value = m.depth;
    form.elements.orientation.value = m.orientation || "";
    form.elements.condition.value = m.condition || "";
    form.elements.note.value = m.note || "";
    $("#markerStatus").innerHTML = m.status === STATUS.PENDING
      ? '<span class="pill pending">待复核（不计入时间线/导出）</span>'
      : '<span class="pill released">已放行 v' + m.version + "</span>";
    render();
  }

  function resetMarkerForm() {
    var form = $("#markerForm");
    form.reset();
    form.elements.id.value = "";
    var snap = R.snapshot();
    form.elements.code.value = "M-" + String(snap.markers.length + 1).padStart(3, "0");
    $("#markerStatus").textContent = "";
  }

  // 防止重复点击期间二次提交：仓储侧幂等，UI 侧给忙等反馈
  function guard(promise, ok) {
    if (busy) { toast("正在提交中，结果将沿用首次提交"); return; }
    busy = true;
    document.body.classList.add("busy");
    promise.then(function (res) {
      busy = false;
      document.body.classList.remove("busy");
      if (res.ok) { ok(res); render(); }
      else toast(res.error);
    });
  }

  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("show"); }, 10);
    setTimeout(function () { el.classList.remove("show"); setTimeout(function () { el.remove(); }, 300); }, 2600);
  }

  // —— 全局控件 ——
  $("#map").addEventListener("click", function (ev) {
    var rect = ev.currentTarget.getBoundingClientRect();
    pendingPoint = {
      x: Number(((ev.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((ev.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    editId = null;
    resetMarkerForm();
    render();
  });

  $("#diveSelect").onchange = function () { ui.diveId = this.value; render(); };
  $("#typeFilter").onchange = function () { ui.type = this.value; render(); };
  $("#statusFilter").onchange = function () { ui.status = this.value; render(); };
  document.querySelectorAll("[data-view]").forEach(function (btn) {
    btn.onclick = function () {
      ui.view = btn.dataset.view;
      document.querySelectorAll("[data-view]").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      render();
    };
  });

  $("#markerForm").onsubmit = function (ev) {
    ev.preventDefault();
    if (!ui.diveId) { toast("请先在右上角选择本次标记所属潜次"); return; }
    if (!pendingPoint) { toast("请先在平面图上点击标记位置"); return; }
    var f = ev.currentTarget.elements;
    var payload = {
      diveId: ui.diveId,
      code: f.code.value, type: f.type.value, depth: f.depth.value,
      orientation: f.orientation.value, condition: f.condition.value, note: f.note.value,
      x: pendingPoint.x, y: pendingPoint.y
    };
    if (f.id.value) {
      // 编辑既有标记：保留 id、放行状态、版本与复核记录
      guard(R.updateMarker(f.id.value, payload), function () {
        toast("标记已更新");
        pendingPoint = null; editId = null; resetMarkerForm();
      });
      return;
    }
    guard(R.submitMarker(payload), function (res) {
      if (res.data.duplicate) toast("重复/并发提交，沿用首次结果：" + res.data.marker.code);
      else toast(res.data.marker.status === STATUS.PENDING
        ? "潜次超限或缺安全停留，标记只进待复核"
        : "标记已提交并放行");
      pendingPoint = null;
      editId = null;
      resetMarkerForm();
    });
  };

  $("#deleteBtn").onclick = function () {
    var id = $("#markerForm").elements.id.value;
    if (!id) { toast("请先选择要删除的标记"); return; }
    guard(R.deleteMarker(id), function () {
      editId = null; pendingPoint = null; resetMarkerForm();
      toast("标记已删除");
    });
  };

  $("#exportBtn").onclick = function () {
    var payload = R.exportPayload();
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dive-marks-released.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出 " + payload.markers.length + " 个已放行标记；" +
      payload.excludedPendingCount + " 个待复核标记未导出");
  };

  // 仓储在其他标签页/流程变更后也保持一致
  R.subscribe(render);

  // 初始化沉船船肋装饰
  for (var i = 0; i < 7; i++) {
    var rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    $("#map").appendChild(rib);
  }

  window.addEventListener("storage", function (e) {
    if (e.key && e.key.indexOf("zfl30DiveConsole") === 0) location.reload();
  });

  // 初始视图按钮高亮
  document.querySelectorAll("[data-view]").forEach(function (b) {
    b.classList.toggle("active", b.dataset.view === ui.view);
  });
  resetMarkerForm();
  render();
})();
