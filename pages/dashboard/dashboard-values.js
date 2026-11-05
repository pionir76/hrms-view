// 실시간 현황 — 리스트 모드의 "실시간 측정값" 보기 (시안 mokup/dashboard_values_v2, 사용자 결정 2026-10-27)
//
// 리스트 모드는 보기를 둘로 나눈다: "장비 운영 상태"(기존 지구 3열, dashboard.js) / "실시간 측정값"(이 파일).
// 실시간 측정값은 운영 장비의 모든 압축기를 한 장 넓은 표로 보여준다 —
//   열: 시설동 · 장비명 · 압축기 · 운전정보 · 경보상태 · 센서 7개(DISPLAY_CHANNELS 순서) · IP 주소 · 통신상태
//   행: 지구 머리줄 → 시설동 → 장비(이름은 압축기 수만큼 세로로 합침) → 압축기 한 줄씩. 센서 이름은 맨 위 한 줄(고정)
//   단위는 머리글이 아니라 값 옆에 붙인다("2.11 MPa"). 행을 누르면 그 줄만 강조하고 다른 화면으로 가지 않는다
//   (다시 누르면 해제, 3초 갱신에도 유지) — 사용자 결정 2026-10-27
//
// 쓰는 API:
//   GET /api/equipments/live-values      (79번) — 장비·압축기 상태 + 채널 원시값·채널별 확정 경보. 3초마다(이 보기를 볼 때만)
//   GET /api/compressors/channel-settings (80번) — 전 압축기 채널 설정(소수점 자리수·단위). 처음 한 번 + 5분마다
//
// 통신이 끊긴 압축기는 값이 마지막 값에서 멈춰 있고 서버가 운전·경보를 false로 주므로(알 수 없음), 운전정보·경보상태는
// "?"로, 값은 흐리게 보인다. 상태 필터 칩·검색은 운영 상태 보기와 같이 쓴다(dbState.filter / keyword).
//
// 경보 중인 값을 누르면 그 채널의 경보 범위(하한~상한)를 보여 주고, 고칠 수 있는 장비면 "설정 화면으로 이동"
// 링크를 단다(2026-11-05 현장 요청). 링크는 이벤트 상세 창의 "경보 범위 설정"과 같은 주소·권한 기준(event-log.js)이다.

const VALUES_POLL_MS = 3000; // 사용자 결정 2026-10-27
const VALUES_SETTINGS_REFRESH_MS = 5 * 60 * 1000;
const VALUES_TABLE_COLUMNS = 7 + DISPLAY_CHANNELS.length; // 시설동·장비명·압축기·운전·경보 + 센서 + IP·통신

const valuesState = {
  // "status"(장비 운영 상태) | "values"(실시간 측정값). 장비 화면에서 "실시간 현황으로"·뒤로 가기로 돌아오면 보던 보기(?view=values)로
  // 연다 — 스크립트를 읽을 때 정해 둔다(initDashboardMap이 먼저 주소를 다시 쓰면서 view를 지우기 때문)
  view: new URLSearchParams(window.location.search).get("view") === "values" ? "values" : "status",
  equipments: [], // 79번 응답
  settingsByCompressor: new Map(), // compressorId → { CH01: { dp, unit, name, lower, upper }, … } (80번)
  selectedKey: null, // 강조한 줄 — 압축기 id(압축기 없는 장비는 "e"+장비 id)
  settingsLoadedAt: 0,
  timer: null,
  loadedOnce: false,
  error: null,
  lastSignature: "",
};

function initDashboardValues() {
  document.getElementById("dbViewSwitch").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-view]");
    if (btn) setListView(btn.dataset.view);
  });
  document.getElementById("dbValues").addEventListener("click", (event) => toggleValuesRow(event.target.closest("[data-row-key]")));
  document.getElementById("dbValues").addEventListener("keydown", (event) => {
    if (event.key === "Enter") toggleValuesRow(event.target.closest("[data-row-key]"));
  });
  wireAlarmTip();

  setListView(valuesState.view);
}

// 누른 줄을 강조한다(같은 줄을 다시 누르면 해제). 표를 다시 그리지 않고 클래스만 바꾼다
function toggleValuesRow(row) {
  if (!row) return;
  const key = row.dataset.rowKey;
  valuesState.selectedKey = valuesState.selectedKey === key ? null : key;
  document.querySelectorAll("#dbValues tr[data-row-key]").forEach((tr) => {
    tr.classList.toggle("is-selected", tr.dataset.rowKey === valuesState.selectedKey);
  });
}

function isValuesViewActive() {
  return valuesState.view === "values" && !mapState.active;
}

function setListView(view) {
  valuesState.view = view;
  document.querySelectorAll("#dbViewSwitch [data-view]").forEach((btn) => {
    const on = btn.dataset.view === view;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", String(on));
  });
  document.querySelector(".db-list").classList.toggle("is-values", view === "values");
  syncDashboardUrl();
  syncValuesPolling();
}

// 이 보기를 보고 있을 때만 3초 폴링을 돌린다 — 맵 모드·운영 상태 보기로 바꾸면 멈춘다(setDashboardMode에서도 부른다)
function syncValuesPolling() {
  const active = isValuesViewActive();
  if (active && !valuesState.timer) {
    loadLiveValues();
    valuesState.timer = setInterval(loadLiveValues, VALUES_POLL_MS);
  } else if (!active && valuesState.timer) {
    clearInterval(valuesState.timer);
    valuesState.timer = null;
  }
}

async function loadLiveValues() {
  if (Date.now() - valuesState.settingsLoadedAt > VALUES_SETTINGS_REFRESH_MS) loadValuesChannelSettings();
  try {
    valuesState.equipments = (await apiFetch("/api/equipments/live-values")) || [];
    valuesState.error = null;
  } catch (err) {
    valuesState.error = err.message;
  }
  valuesState.loadedOnce = true;
  renderValuesTable(false);
}

// 소수점 자리수·단위만 쓴다. 실패하면 다음 갱신 때 다시 받고, 그 사이에는 공통 정의(CHANNELS)의 기본값으로 그린다
async function loadValuesChannelSettings() {
  valuesState.settingsLoadedAt = Date.now();
  try {
    const list = (await apiFetch("/api/compressors/channel-settings")) || [];
    valuesState.settingsByCompressor = new Map(
      list.map((item) => [
        item.compressorId,
        Object.fromEntries(
          (item.settings || []).map((s) => [
            s.channelNo,
            { dp: s.decimalPlaces, unit: s.unit, name: s.channelName, lower: s.lowerLimit, upper: s.upperLimit },
          ])
        ),
      ])
    );
    renderValuesTable(true);
  } catch (err) {
    valuesState.settingsLoadedAt = 0;
  }
}

function valueChannelSetting(compressorId, meta) {
  const s = valuesState.settingsByCompressor.get(compressorId)?.[meta.no];
  return {
    dp: s && s.dp !== undefined && s.dp !== null ? s.dp : defaultDecimalPlacesForChannel(meta.no),
    unit: (s && s.unit) || meta.unit,
  };
}

// ---------- 표 그리기 ----------

// 3초마다 같은 내용이면 다시 그리지 않는다(마우스 오버·스크롤 흔들림 방지). force는 필터·검색·자리수가 바뀌었을 때.
function renderValuesTable(force) {
  if (!isValuesViewActive()) return;
  const container = document.getElementById("dbValues");
  if (!valuesState.loadedOnce) return;
  if (valuesState.error && valuesState.equipments.length === 0) {
    container.innerHTML = `<div class="empty-state">실시간 측정값을 불러오지 못했습니다. (${escapeHtml(valuesState.error)})</div>`;
    valuesState.lastSignature = "";
    return;
  }

  const filter = EQUIPMENT_FILTERS.find((f) => f.key === dbState.filter) || EQUIPMENT_FILTERS[0];
  const keyword = dbState.keyword;
  const visible = valuesState.equipments.filter(
    (e) => filter.test(e) && (!keyword || e.name.includes(keyword) || e.buildingName.includes(keyword))
  );
  const signature = JSON.stringify([dbState.filter, keyword, visible]);
  if (!force && signature === valuesState.lastSignature) return;
  valuesState.lastSignature = signature;

  const scroller = container.querySelector(".dv-scroll");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const scrollLeft = scroller ? scroller.scrollLeft : 0;

  const body = collectRegions(visible)
    .map((region) => {
      const items = visible.filter((e) => e.region === region);
      const buildings = [...new Set(items.map((e) => e.buildingName))].sort((a, b) => a.localeCompare(b, "ko"));
      const head = `<tr class="dv-region"><td colspan="${VALUES_TABLE_COLUMNS}">${escapeHtml(region)}<em>${items.length}대 · 시설동 ${buildings.length}</em></td></tr>`;
      return (
        head +
        buildings
          .map((b) => {
            const eqs = items.filter((e) => e.buildingName === b).sort((x, y) => x.name.localeCompare(y.name, "ko"));
            const rowCount = eqs.reduce((n, e) => n + Math.max(1, (e.compressors || []).length), 0);
            return eqs.map((e, i) => valuesEquipmentRowsHtml(e, i === 0 ? { name: b, rowCount } : null)).join("");
          })
          .join("")
      );
    })
    .join("");

  container.innerHTML = `
    <div class="dv-scroll">
      <table class="dv-table">
        <thead>
          <tr>
            <th class="l">시설동</th><th class="l">장비명</th><th class="l">압축기</th><th class="c">운전정보</th><th class="c">경보상태</th>
            ${DISPLAY_CHANNELS.map((ch) => `<th>${escapeHtml(ch.label)}</th>`).join("")}
            <th>IP 주소</th><th class="c">통신상태</th>
          </tr>
        </thead>
        <tbody>${
          body ||
          `<tr><td colspan="${VALUES_TABLE_COLUMNS}"><div class="empty-state">${
            valuesState.equipments.length === 0 ? "운영 중인 장비가 없습니다." : "조건에 맞는 장비가 없습니다."
          }</div></td></tr>`
        }</tbody>
      </table>
    </div>
  `;
  const next = container.querySelector(".dv-scroll");
  next.scrollTop = scrollTop;
  next.scrollLeft = scrollLeft;
  refreshAlarmTip();
}

// 장비 한 대 = 압축기 수만큼의 줄. 시설동 칸은 그 시설동 첫 장비의 첫 줄에만(building이 있을 때) 넣는다.
function valuesEquipmentRowsHtml(e, building) {
  const comps = (e.compressors || []).slice().sort((a, b) => a.sequenceNo - b.sequenceNo);
  const rowSpan = Math.max(1, comps.length);
  const bldCell = building ? `<td class="dv-bld" rowspan="${building.rowCount}">${escapeHtml(building.name)}</td>` : "";
  const nameCell = `
    <td class="dv-eqname" rowspan="${rowSpan}" title="${escapeHtml(e.name)}">
      <span>${escapeHtml(e.name)}</span>${e.isEmergencyStopped ? `<span class="db-emg">비상정지</span>` : ""}
    </td>`;
  const rowAttrs = (key) =>
    `data-row-key="${key}" tabindex="0" class="${String(key) === String(valuesState.selectedKey) ? "is-selected " : ""}`;

  if (comps.length === 0) {
    return `<tr ${rowAttrs("e" + e.id)}dv-first">${bldCell}${nameCell}<td colspan="${VALUES_TABLE_COLUMNS - 2}" class="dv-none">등록된 압축기가 없습니다.</td></tr>`;
  }
  return comps
    .map((c, i) => {
      const comm = c.communicationStatus !== "연결됨";
      const seqClass = comm ? " comm" : c.hasAlarm ? " alarm" : "";
      const unknown = `<span class="dv-tag unknown" title="통신이 끊겨 알 수 없습니다">?</span>`;
      const runTag = comm ? unknown : `<span class="dv-tag ${c.isRunning ? "run" : "stop"}">${c.isRunning ? "운전" : "정지"}</span>`;
      const alarmTag = comm ? unknown : `<span class="dv-tag ${c.hasAlarm ? "alarm" : "normal"}">${c.hasAlarm ? "경보" : "정상"}</span>`;
      const byNo = Object.fromEntries((c.channels || []).map((ch) => [ch.channelNo, ch]));
      const values = DISPLAY_CHANNELS.map((meta) => {
        const ch = byNo[meta.no];
        if (!ch || ch.value === null || ch.value === undefined) return `<td class="num"><span>-</span></td>`;
        const { dp, unit } = valueChannelSetting(c.id, meta);
        const tipAttrs = ch.alarm ? ` data-tip-eq="${e.id}" data-tip-comp="${c.id}" data-tip-ch="${meta.no}"` : "";
        return `<td class="num${ch.alarm ? " dv-alarm" : ""}"${tipAttrs}><span>${formatRawValue(ch.value, dp)}<small class="dv-unit">${escapeHtml(unit)}</small></span></td>`;
      }).join("");
      return `
        <tr ${rowAttrs(c.id)}${i === 0 ? "dv-first" : ""}${comm ? " dv-comm" : ""}">
          ${i === 0 ? bldCell + nameCell : ""}
          <td><span class="dv-seq${seqClass}">#${c.sequenceNo}</span></td>
          <td class="c">${runTag}</td>
          <td class="c">${alarmTag}</td>
          ${values}
          <td class="ip">${escapeHtml(c.ipAddress || "-")}</td>
          <td class="c"><span class="dv-tag ${comm ? "fail" : "ok"}" title="${escapeHtml(c.communicationStatus)}">${comm ? "불능" : "정상"}</span></td>
        </tr>`;
    })
    .join("");
}

// ---------- 경보 범위 말풍선 ----------
//
// 표는 3초 갱신 때 다시 그려질 수 있어 말풍선은 표 밖(body)에 하나만 두고, 어느 칸에 붙었는지는 "압축기:채널" 키로 기억한다.
// 다시 그린 뒤 같은 칸이 아직 경보면 새 칸에 다시 붙이고, 경보가 풀려 칸이 사라졌으면 닫는다(refreshAlarmTip).
// 경보 칸을 누르면 열고, 같은 칸을 다시 누르거나 바깥을 누르거나 ESC로 닫는다(마우스 오버 → 클릭, 2026-11-05 현장 요청).
// 칸을 누르면 줄 강조(toggleValuesRow)도 함께 바뀐다 — 어느 압축기의 말풍선인지 보이도록 일부러 그대로 둔다.
const alarmTip = { el: null, key: null };

function wireAlarmTip() {
  const container = document.getElementById("dbValues");
  container.addEventListener("click", (event) => {
    const cell = event.target.closest("td[data-tip-ch]");
    if (!cell) return;
    const key = `${cell.dataset.tipComp}:${cell.dataset.tipCh}`;
    if (alarmTip.el && !alarmTip.el.hidden && alarmTip.key === key) hideAlarmTip();
    else showAlarmTip(cell);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("td[data-tip-ch], .dv-tip")) hideAlarmTip();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideAlarmTip();
  });
  // 말풍선은 화면 기준(fixed) 위치라 표나 화면이 스크롤되면 칸과 어긋난다 — 그냥 닫는다
  container.addEventListener("scroll", hideAlarmTip, true);
  window.addEventListener("scroll", hideAlarmTip);
}

function ensureAlarmTip() {
  if (alarmTip.el) return alarmTip.el;
  const el = document.createElement("div");
  el.className = "dv-tip";
  el.hidden = true;
  document.body.appendChild(el);
  alarmTip.el = el;
  return el;
}

function showAlarmTip(cell) {
  const el = ensureAlarmTip();
  const { tipEq: equipmentId, tipComp: compressorId, tipCh: channelNo } = cell.dataset;
  const key = `${compressorId}:${channelNo}`;
  if (alarmTip.key !== key || el.hidden) {
    alarmTip.key = key;
    el.innerHTML = alarmTipHtml(equipmentId, Number(compressorId), channelNo);
    el.hidden = false;
    // 설정은 시스템관리자·담당자만 고칠 수 있어, 고칠 수 있는 장비일 때만 링크를 보인다(event-log.js와 같은 기준)
    fetchManagedEquipmentIds().then((ids) => {
      if (el.hidden || alarmTip.key !== key) return;
      el.querySelector(".dv-tip-link").hidden = !ids.has(String(equipmentId));
    });
  }
  placeAlarmTip(cell);
}

function alarmTipHtml(equipmentId, compressorId, channelNo) {
  const meta = DISPLAY_CHANNELS.find((m) => m.no === channelNo);
  const { dp, unit } = valueChannelSetting(compressorId, meta);
  const s = valuesState.settingsByCompressor.get(compressorId)?.[channelNo];
  const limit = (raw) => (raw === null || raw === undefined ? "-" : `${formatRawValue(raw, dp)} ${escapeHtml(unit)}`);
  const params = new URLSearchParams({ equipment: equipmentId, compressor: compressorId, channel: channelNo });
  const body = s
    ? `<dl><dt>하한</dt><dd>${limit(s.lower)}</dd><dt>상한</dt><dd>${limit(s.upper)}</dd></dl>`
    : `<div class="dv-tip-empty">설정값을 불러오지 못했습니다.</div>`;
  return `
    <div class="dv-tip-title">${escapeHtml((s && s.name) || meta.label)} 경보 범위</div>
    ${body}
    <a class="dv-tip-link" href="../equipment/equipment.html?${params}" target="_blank" rel="noopener" hidden>설정 화면으로 이동 ↗</a>`;
}

// 칸 아래 오른쪽 끝에 맞춰 띄운다. 화면 아래가 모자라면 칸 위로 올린다
function placeAlarmTip(cell) {
  const el = alarmTip.el;
  const rect = cell.getBoundingClientRect();
  const margin = 8;
  let top = rect.bottom + 4;
  if (top + el.offsetHeight > window.innerHeight - margin) top = rect.top - el.offsetHeight - 4;
  const left = Math.min(Math.max(margin, rect.right - el.offsetWidth), window.innerWidth - el.offsetWidth - margin);
  el.style.top = `${Math.max(margin, top)}px`;
  el.style.left = `${left}px`;
}

function refreshAlarmTip() {
  if (!alarmTip.el || alarmTip.el.hidden) return;
  const [compressorId, channelNo] = alarmTip.key.split(":");
  const cell = document.querySelector(`#dbValues td[data-tip-comp="${compressorId}"][data-tip-ch="${channelNo}"]`);
  if (cell) placeAlarmTip(cell);
  else hideAlarmTip();
}

function hideAlarmTip() {
  if (!alarmTip.el) return;
  alarmTip.el.hidden = true;
  alarmTip.key = null;
}
