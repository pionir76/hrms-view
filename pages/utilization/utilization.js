// 가동율 페이지 — 하루(일별) 또는 한 달(월별) 동안 운영 장비 전체의 가동율 (사용자 결정 2026-10-14)
//
// 백엔드 수정 없이 기존 API만 쓴다(최대한 단순한 구조):
//   운영 장비 목록  GET /api/equipments/status          (70번 — 운영 장비만, 가볍다)
//   장비별 가동율   GET /api/equipments/{id}/utilization?from=&to=   (7번 — 장비 수만큼 호출)
//
// 장비마다 한 번씩 부르므로(운영 장비 약 150대) 동시에 MAX_PARALLEL개씩 나눠 부르고 진행 상황을 보여준다.
// 서버는 장비의 대표 압축기 1대의 1분 기록을 세어 계산한다 — 하루 1,440건, 한 달 약 4만 3천 건이라
// 일별은 금방, 월별은 몇 초 걸린다. 조회 중에 날짜를 바꾸면 늦게 온 이전 결과는 버린다.
//
// 가동율 = 운전한 분 ÷ 기록이 있는 분(api-manual 7번). 서버가 꺼져 있던 시간은 분모에서 빠지므로,
// "기록률"(기록 시간 ÷ 조회 기간)을 같이 보여준다 — 오늘·이번 달은 지금까지 지난 시간 기준.
//
// 검색(장비명·시설동·지구)은 표·요약·PDF에 모두 적용된다. PDF는 지금 보이는 목록(검색·정렬 반영)을
// A4 세로로 저장한다(common/js/pdf-export.js) — 불러오는 중에는 잠근다.

const MAX_PARALLEL = 6; // 브라우저가 한 서버에 동시에 보내는 요청 수와 맞춤

const utState = {
  mode: "day", // "day" | "month"
  date: null, // "yyyy-MM-dd"
  month: null, // "yyyy-MM"
  rows: [], // [{ equipment, result }]
  sortDesc: true, // 가동율 높은 순
  sorted: false, // 가동율 머리글을 눌렀는지 — 처음엔 지구·시설동·장비명 순
  keyword: "",
  loading: false,
  requestId: 0,
};

function initUtilizationPage() {
  const today = todayDateString();
  utState.date = today;
  utState.month = today.slice(0, 7);

  const dateEl = document.getElementById("utDate");
  const monthEl = document.getElementById("utMonth");
  dateEl.value = utState.date;
  dateEl.max = today; // 앞날은 기록이 없다
  monthEl.value = utState.month;
  monthEl.max = utState.month;

  document.getElementById("utMode").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-mode]");
    if (!btn || btn.dataset.mode === utState.mode) return;
    utState.mode = btn.dataset.mode;
    renderModeControls();
    loadUtilization();
  });
  dateEl.addEventListener("change", () => {
    if (!dateEl.value) return;
    utState.date = dateEl.value;
    loadUtilization();
  });
  monthEl.addEventListener("change", () => {
    if (!monthEl.value) return;
    utState.month = monthEl.value;
    loadUtilization();
  });
  document.getElementById("utSearch").addEventListener("input", (event) => {
    utState.keyword = event.target.value.trim();
    renderTable();
  });
  document.getElementById("utPdfBtn").addEventListener("click", exportUtilizationPdf);
  document.getElementById("utPrev").addEventListener("click", () => movePeriod(-1));
  document.getElementById("utNext").addEventListener("click", () => movePeriod(1));
  document.querySelector(".ut-table th[data-sort]").addEventListener("click", () => {
    utState.sortDesc = utState.sorted ? !utState.sortDesc : true;
    utState.sorted = true;
    renderTable();
  });

  renderModeControls();
  loadUtilization();
}

function renderModeControls() {
  const day = utState.mode === "day";
  document.querySelectorAll("#utMode [data-mode]").forEach((btn) => {
    const on = btn.dataset.mode === utState.mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  });
  document.getElementById("utDate").hidden = !day;
  document.getElementById("utMonth").hidden = day;
  document.getElementById("utPrev").setAttribute("aria-label", day ? "하루 전" : "한 달 전");
  document.getElementById("utNext").setAttribute("aria-label", day ? "하루 후" : "한 달 후");
}

// ◀ ▶ — 하루 또는 한 달씩. 오늘·이번 달 뒤로는 가지 않는다
function movePeriod(delta) {
  const today = todayDateString();
  if (utState.mode === "day") {
    const next = shiftDateString(utState.date, delta);
    if (next > today) return;
    utState.date = next;
    document.getElementById("utDate").value = next;
  } else {
    const [y, m] = utState.month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (next > today.slice(0, 7)) return;
    utState.month = next;
    document.getElementById("utMonth").value = next;
  }
  loadUtilization();
}

// 조회 기간 — { from, to, label, periodMinutes(지금까지 지난 분, 기록률 분모) }
function currentPeriod() {
  const now = new Date();
  const minutesSince = (start) => Math.max(0, Math.floor((now - start) / 60000));
  if (utState.mode === "day") {
    const [y, m, d] = utState.date.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const isToday = utState.date === todayDateString();
    return {
      from: utState.date,
      to: utState.date,
      label: `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}${isToday ? " (오늘, 지금까지)" : ""}`,
      periodMinutes: isToday ? minutesSince(start) : 1440,
    };
  }
  const [y, m] = utState.month.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0).getDate();
  const isThisMonth = utState.month === todayDateString().slice(0, 7);
  return {
    from: `${utState.month}-01`,
    to: `${utState.month}-${String(lastDay).padStart(2, "0")}`,
    label: `${y}년 ${m}월${isThisMonth ? " (이번 달, 지금까지)" : ""}`,
    periodMinutes: isThisMonth ? minutesSince(start) : lastDay * 1440,
  };
}

async function loadUtilization() {
  const requestId = ++utState.requestId;
  const period = currentPeriod();
  setLoading(true);
  const status = document.getElementById("utStatus");
  status.classList.remove("error");

  let equipments;
  try {
    equipments = await apiFetch("/api/equipments/status");
  } catch (err) {
    if (requestId !== utState.requestId) return;
    status.textContent = `장비 목록을 불러오지 못했습니다. (${err.message})`;
    status.classList.add("error");
    setLoading(false);
    return;
  }
  if (requestId !== utState.requestId) return;

  equipments = (equipments || []).slice().sort(
    (a, b) =>
      compareRegion(a.region, b.region) ||
      String(a.buildingName).localeCompare(String(b.buildingName), "ko") ||
      String(a.name).localeCompare(String(b.name), "ko")
  );
  utState.rows = equipments.map((equipment) => ({ equipment, result: undefined })); // undefined = 아직, null = 실패
  utState.period = period;
  renderTable();

  // 동시에 MAX_PARALLEL개씩 — 끝나는 대로 다음 장비를 부른다
  let next = 0;
  let done = 0;
  const total = utState.rows.length;
  const showProgress = () => {
    status.textContent = done < total ? `${period.label} · 불러오는 중 ${done}/${total}` : `${period.label} · 장비 ${total}대`;
  };
  showProgress();

  const worker = async () => {
    while (next < total) {
      const row = utState.rows[next++];
      let result = null;
      try {
        result = await apiFetch(`/api/equipments/${row.equipment.id}/utilization?from=${period.from}&to=${period.to}`);
      } catch (err) {
        result = null; // 이 장비만 실패 — 표에 "조회 실패"
      }
      if (requestId !== utState.requestId) return; // 그새 날짜를 바꿨다
      row.result = result;
      done++;
      showProgress();
      renderTableThrottled();
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, total) }, worker));
  if (requestId !== utState.requestId) return;
  setLoading(false);
  renderTable();
}

function setLoading(loading) {
  utState.loading = loading;
  const btn = document.getElementById("utPdfBtn");
  btn.disabled = loading;
  btn.title = loading ? "불러오기가 끝나면 저장할 수 있습니다" : "";
}

// 표·요약·PDF가 함께 쓰는 "지금 보이는 행" — 검색 + 정렬 반영
function visibleRows() {
  const kw = utState.keyword.toLowerCase();
  let rows = utState.rows;
  if (kw) {
    rows = rows.filter(({ equipment: e }) => `${e.name} ${e.buildingName} ${e.region}`.toLowerCase().includes(kw));
  }
  if (utState.sorted) {
    // 가동율 순 — 기록 없음·조회 중·실패는 항상 맨 아래
    const value = (r) => (r.result && r.result.utilizationPercent !== null ? r.result.utilizationPercent : null);
    rows = rows.slice().sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return utState.sortDesc ? vb - va : va - vb;
    });
  }
  return rows;
}

function coveragePercent(r, period) {
  if (!r || !period || period.periodMinutes <= 0) return null;
  return Math.min(100, Math.round((r.totalMinutes / period.periodMinutes) * 1000) / 10);
}

// 결과가 하나씩 들어올 때마다 표 전체를 다시 그리면 무거워서 0.3초에 한 번만
let renderTimer = null;
function renderTableThrottled() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderTable();
  }, 300);
}

function formatHm(minutes) {
  if (minutes === null || minutes === undefined) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

function renderTable() {
  const tbody = document.getElementById("utBody");
  const period = utState.period;
  if (utState.rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">운영 중인 장비가 없습니다.</div></td></tr>`;
    renderSummary();
    return;
  }

  const rows = visibleRows();
  document.getElementById("utSortIcon").textContent = utState.sorted ? (utState.sortDesc ? "↓" : "↑") : "↕";

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">검색 결과가 없습니다.</div></td></tr>`;
    renderSummary();
    return;
  }
  tbody.innerHTML = rows
    .map(({ equipment: e, result: r }) => {
      let rateCell;
      let runCell = "-";
      let recCell = "-";
      let coverCell = "-";
      if (r === undefined) {
        rateCell = `<span class="ut-muted">불러오는 중...</span>`;
      } else if (r === null) {
        rateCell = `<span class="ut-fail">조회 실패</span>`;
      } else if (r.utilizationPercent === null) {
        rateCell = `<span class="ut-muted">기록 없음</span>`;
      } else {
        const p = Math.max(0, Math.min(100, r.utilizationPercent));
        rateCell = `<div class="ut-rate"><div class="ut-bar"><i style="width:${p}%"></i></div><b>${r.utilizationPercent}<small>%</small></b></div>`;
      }
      if (r) {
        runCell = formatHm(r.runningMinutes);
        recCell = formatHm(r.totalMinutes);
        const cover = coveragePercent(r, period);
        if (cover !== null) {
          coverCell = `<span class="${cover < 90 ? "ut-low" : ""}" title="기록 ${formatHm(r.totalMinutes)} / 기간 ${formatHm(period.periodMinutes)}">${cover}%</span>`;
        }
      }
      return `
        <tr>
          <td>${escapeHtml(e.region)}</td>
          <td>${escapeHtml(e.buildingName)}</td>
          <td class="ut-name">${escapeHtml(e.name)}</td>
          <td>${rateCell}</td>
          <td class="num">${runCell}</td>
          <td class="num">${recCell}</td>
          <td class="num">${coverCell}</td>
        </tr>`;
    })
    .join("");
  renderSummary();
}

// 평균 가동율은 기록이 있는 장비들의 단순 평균(장비마다 같은 비중)
function renderSummary() {
  const box = document.getElementById("utSummary");
  const rows = visibleRows(); // 검색 결과 기준
  box.hidden = utState.rows.length === 0;
  const loaded = rows.filter((r) => r.result !== undefined);
  const withData = loaded.filter((r) => r.result && r.result.utilizationPercent !== null);
  const noData = loaded.filter((r) => r.result && r.result.utilizationPercent === null).length;
  const failed = loaded.filter((r) => r.result === null).length;
  const avg = withData.length
    ? Math.round((withData.reduce((s, r) => s + r.result.utilizationPercent, 0) / withData.length) * 10) / 10
    : null;
  document.getElementById("utAvg").innerHTML = avg === null ? "-" : `${avg}<small>%</small>`;
  document.getElementById("utCount").innerHTML = `${rows.length}<small>대</small>`;
  document.getElementById("utNoData").innerHTML = `${noData}<small>대</small>`;
  document.getElementById("utSumNote").textContent =
    (utState.keyword ? `검색 "${utState.keyword}" 결과 기준 · ` : "") +
    (failed ? `조회 실패 ${failed}대 · ` : "") + "평균은 기록이 있는 장비 기준 · 기록률 90% 미만은 주황(서버가 꺼져 있던 시간이 있었다는 뜻)";
}

// ---------- PDF 저장 (common/js/pdf-export.js) ----------
// 지금 보이는 목록(검색·정렬 반영)을 A4 세로로. 장비가 많으면 여러 쪽이 되고 표 머리글이 쪽마다 다시 찍힌다.

function exportUtilizationPdf() {
  if (utState.loading || !utState.period) return;
  const period = utState.period;
  const rows = visibleRows();
  const text = (v) => escapeHtml(v ?? "");
  const body = rows
    .map(({ equipment: e, result: r }) => {
      let rate = "-";
      if (r === null) rate = "조회 실패";
      else if (r && r.utilizationPercent === null) rate = "기록 없음";
      else if (r) rate = `${r.utilizationPercent}%`;
      const cover = coveragePercent(r, period);
      return `<tr>
        <td class="pdf-center">${text(e.region)}</td>
        <td>${text(e.buildingName)}</td>
        <td>${text(e.name)}</td>
        <td class="ut-pdf-num"><b>${text(rate)}</b></td>
        <td class="ut-pdf-num">${r ? formatHm(r.runningMinutes) : "-"}</td>
        <td class="ut-pdf-num">${r ? formatHm(r.totalMinutes) : "-"}</td>
        <td class="ut-pdf-num">${cover === null ? "-" : `${cover}%`}</td>
      </tr>`;
    })
    .join("");
  const avgText = document.getElementById("utAvg").textContent;
  const fileStamp = utState.mode === "day" ? utState.date : utState.month;

  printPdfDocument({
    fileName: pdfSafeFileName(["가동율", utState.mode === "day" ? "일별" : "월별", fileStamp, utState.keyword]),
    html: `
      <div class="pdf-doc">
        <div class="pdf-head">
          <div>
            <h1 class="pdf-title"><small>UTILIZATION</small>가동율 (${utState.mode === "day" ? "일별" : "월별"})</h1>
            <p class="pdf-meta">
              조회 기간 ${text(period.label)}${utState.keyword ? ` · 검색 "${text(utState.keyword)}"` : ""}<br />
              장비 ${rows.length}대 · 평균 가동율 ${text(avgText)}(기록이 있는 장비 기준)
            </p>
          </div>
        </div>
        <table class="pdf-table ut-pdf-table">
          <colgroup>
            <col style="width: 48px" /><col style="width: 120px" /><col /><col style="width: 68px" />
            <col style="width: 92px" /><col style="width: 92px" /><col style="width: 58px" />
          </colgroup>
          <thead>
            <tr><th>지구</th><th>시설동</th><th>장비명</th><th>가동율</th><th>운전 시간</th><th>기록 시간</th><th>기록률</th></tr>
          </thead>
          <tbody>${body || `<tr><td colspan="7" class="pdf-center">해당하는 장비가 없습니다.</td></tr>`}</tbody>
        </table>
        <p class="pdf-note">가동율 = 운전 시간 ÷ 기록 시간. 기록률 = 기록 시간 ÷ 조회 기간(오늘·이번 달은 출력 시점까지) — 서버가 꺼져 있던 시간은 기록 시간에서 빠진다.</p>
        <div class="pdf-foot"><span></span><span>${text(pdfPrintedByText())}</span></div>
      </div>
    `,
  });
}

document.addEventListener("DOMContentLoaded", initUtilizationPage);
