// 백업 관리 페이지 전용 스크립트 (api-manual.md 81~84번, 2026-11-17 현장 추가)
//
// 시스템관리자 전용 — 메뉴도 시스템관리자에게만 보이고(layout.js adminOnly), 다른 역할로 들어오면
// 안내만 보인다(서버도 403). 설정을 저장하면 다음 예약 시각부터 바로 적용된다(서버 재시작 없음).
// "지금 백업"은 서버가 시작만 시키고 바로 응답하므로, 실행 중인 동안 이력을 5초마다 다시 읽는다.
// 복구는 화면에서 하지 않는다 — 서버에서 restore.ps1로 한다(백엔드 Modules/Backup/README.md).

const BACKUP_RUNNING_POLL_MS = 5000;

// 점검일지(00:00)·운전일지(09/13/16/21시) 자동 기록 시각. 백업이 겹쳐도 동작에는 문제없지만
// (pg_dump는 잠금이 없다) 그 시각 부하를 피하도록 안내만 한다.
const AUTO_RECORD_HOURS = [0, 9, 13, 16, 21];
const AUTO_RECORD_MARGIN_MINUTES = 10;

const backupState = {
  settings: null,
  pollTimer: null,
};

function isBackupAdmin() {
  return getSession()?.role === "시스템관리자";
}

async function initBackupPage() {
  if (!isBackupAdmin()) {
    document.getElementById("bkDenied").hidden = false;
    return;
  }
  document.getElementById("bkBody").hidden = false;
  document.getElementById("bkRunBtn").hidden = false;

  document.getElementById("bkFrequency").addEventListener("change", syncWeeklyDayField);
  document.getElementById("bkRunTime").addEventListener("input", syncTimeWarning);
  document.getElementById("bkSaveBtn").addEventListener("click", saveBackupSettings);
  document.getElementById("bkRunBtn").addEventListener("click", runBackupNow);

  await Promise.all([loadBackupSettings(), loadBackupHistory()]);
}

// ---------- 설정 ----------

async function loadBackupSettings() {
  try {
    backupState.settings = await apiFetch("/api/backup/settings");
  } catch (err) {
    document.getElementById("bkSummary").textContent = `설정을 불러오지 못했습니다. (${err.message})`;
    return;
  }
  const s = backupState.settings;
  document.getElementById("bkEnabled").checked = s.enabled;
  document.getElementById("bkFrequency").value = s.frequency;
  document.getElementById("bkWeeklyDay").value = String(s.weeklyDay ?? 0);
  document.getElementById("bkRunTime").value = s.runTime;
  document.getElementById("bkDirectory").value = s.directory;
  document.getElementById("bkKeepCount").value = s.keepCount;
  syncWeeklyDayField();
  syncTimeWarning();
  renderBackupSummary();
  syncRunningState(s.isRunning);
}

function renderBackupSummary() {
  const s = backupState.settings;
  const free = s.freeSpaceBytes != null ? ` · 남은 공간 ${formatBackupSize(s.freeSpaceBytes)}` : "";
  const updated = s.updatedAt
    ? ` · 마지막 변경 ${escapeHtml(formatDateTimeSeconds(s.updatedAt).slice(0, 16))}${s.updatedByUserName ? ` (${escapeHtml(s.updatedByUserName)})` : ""}`
    : "";
  document.getElementById("bkSummary").innerHTML = `<b>${escapeHtml(s.scheduleText)}</b> · ${s.keepCount}개 보관${free}${updated}`;
}

function syncWeeklyDayField() {
  document.getElementById("bkWeeklyDayField").hidden = document.getElementById("bkFrequency").value !== "매주";
}

function syncTimeWarning() {
  const value = document.getElementById("bkRunTime").value;
  const warning = document.getElementById("bkTimeWarning");
  const [h, m] = value.split(":").map(Number);
  const minute = h * 60 + m;
  const near = AUTO_RECORD_HOURS.find((hour) => {
    const diff = minute - hour * 60;
    return diff >= 0 && diff < AUTO_RECORD_MARGIN_MINUTES;
  });
  warning.hidden = near === undefined || Number.isNaN(minute);
  warning.textContent = warning.hidden
    ? ""
    : `${String(near).padStart(2, "0")}:00은 일지 자동 기록 시각입니다. 백업은 문제없이 되지만, 겹치지 않는 시각(예: 03:00)을 권장합니다.`;
}

async function saveBackupSettings() {
  const frequency = document.getElementById("bkFrequency").value;
  const body = {
    enabled: document.getElementById("bkEnabled").checked,
    frequency,
    weeklyDay: frequency === "매주" ? Number(document.getElementById("bkWeeklyDay").value) : null,
    runTime: document.getElementById("bkRunTime").value,
    directory: document.getElementById("bkDirectory").value.trim(),
    keepCount: Number(document.getElementById("bkKeepCount").value),
  };
  try {
    backupState.settings = await withGlobalBusy(() =>
      apiFetch("/api/backup/settings", { method: "PUT", body: JSON.stringify(body) })
    );
    renderBackupSummary();
    window.alert("저장했습니다. 다음 예약 시각부터 적용됩니다.");
  } catch (err) {
    window.alert(`저장하지 못했습니다.\n${err.message}`);
  }
}

// ---------- 지금 백업 ----------

async function runBackupNow() {
  if (!window.confirm("지금 백업을 시작할까요? 1~2분 정도 걸리며, 그동안에도 화면과 수집은 그대로 동작합니다.")) return;
  try {
    await apiFetch("/api/backup/run", { method: "POST" });
  } catch (err) {
    window.alert(`백업을 시작하지 못했습니다.\n${err.message}`);
    return;
  }
  syncRunningState(true);
  await loadBackupHistory();
}

// 실행 중이면 버튼을 막고 이력을 5초마다 다시 읽는다. 끝나면 설정(남은 공간)도 새로 읽는다.
function syncRunningState(running) {
  const btn = document.getElementById("bkRunBtn");
  btn.disabled = running;
  btn.textContent = running ? "백업 중..." : "지금 백업";
  if (running && !backupState.pollTimer) {
    backupState.pollTimer = setInterval(loadBackupHistory, BACKUP_RUNNING_POLL_MS);
  } else if (!running && backupState.pollTimer) {
    clearInterval(backupState.pollTimer);
    backupState.pollTimer = null;
    loadBackupSettings();
  }
}

// ---------- 이력 ----------

const BACKUP_STATUS_BADGE = {
  성공: "badge-normal",
  실패: "badge-alarm",
  진행중: "badge-info",
  중단됨: "badge-warning",
};

async function loadBackupHistory() {
  const body = document.getElementById("bkHistoryBody");
  let records;
  try {
    records = (await apiFetch("/api/backup/history?take=30")) || [];
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty-state">이력을 불러오지 못했습니다. (${escapeHtml(err.message)})</div></td></tr>`;
    return;
  }

  if (backupState.pollTimer && !records.some((r) => r.status === "진행중")) syncRunningState(false);

  body.innerHTML = records.length
    ? records.map(backupRecordRowHtml).join("")
    : `<tr><td colspan="5"><div class="empty-state">아직 백업 이력이 없습니다.</div></td></tr>`;
}

function backupRecordRowHtml(r) {
  const who = r.trigger === "수동" && r.requestedByUserName ? ` (${escapeHtml(r.requestedByUserName)})` : "";
  const detail = r.status === "성공" ? r.folderPath : r.message;
  const note = r.status === "성공" && r.message ? `<small>${escapeHtml(r.message)}</small>` : "";
  return `
    <tr>
      <td>${escapeHtml(formatDateTimeSeconds(r.startedAt))}</td>
      <td>${escapeHtml(r.trigger)}${who}</td>
      <td><span class="badge ${BACKUP_STATUS_BADGE[r.status] || "badge-muted"}">${escapeHtml(r.status)}</span></td>
      <td class="bk-num">${r.sizeBytes != null ? formatBackupSize(r.sizeBytes) : "-"}</td>
      <td class="bk-detail">${escapeHtml(detail || "-")}${note}</td>
    </tr>`;
}

function formatBackupSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

document.addEventListener("DOMContentLoaded", initBackupPage);
