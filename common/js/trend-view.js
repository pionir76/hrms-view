// 압축기 하루 트렌드 뷰 — 자료 조회 · 장비 실시간 화면 공통 컴포넌트
//
// 필요한 스크립트: channels.js(CHANNELS, CHANNEL_COLORS, MINUTES_PER_DAY, 소수점 변환),
//                 ui.js(minuteLabel, minuteOfDayKst, escapeHtml, hexToRgba), vendor/chart.umd.min.js
// 필요한 스타일:   common/css/trend-view.css
//
// 사용법:
//   const view = createTrendView({ root: 그래프가 들어갈 요소, timelineRoot: 타임라인 카드 요소(선택) });
//   view.setData({ points, channelSettings, alarmRanges, label: "COMP #1" });
//   view.showMessage("불러오는 중...");   // 그래프 대신 안내 문구(높이는 유지)
//   view.resetView();                       // 하루 전체 보기로(애니메이션 없음)
//
// 화면 구성(root 안): 확대/이동 툴바 → 그래프(캔버스) → 채널 카드 7개(값·미니 추이·보기/숨기기)
// 타임라인(timelineRoot 안): 하루 전체의 통신장애·경보 구간 막대 + 지금 그래프에 보이는 구간 표시
//
// 그래프 사양(사용자 결정):
//   - 7채널을 한 차트에 그리고 채널마다 별도 y축, 선택한 채널 하나만 강조·눈금 표시(선택 해제 없음)
//   - 보기/숨기기는 선택과 별개 — 숨긴 채널을 선택해도 자동으로 보이게 하지 않는다
//   - 가로축은 00:00~23:59 고정, 값이 없는 분은 선을 끊는다. 통신장애 구간은 선을 잇고 배경만 칠한다
//   - 확대·축소는 버튼으로만(휠 없음), 가운데 기준, 최소 30분. 버튼은 가감속 애니메이션,
//     드래그 이동은 1:1로 따라간다. setData를 다시 불러도 보던 구간·선택·숨김은 유지된다

const TREND_VIEW_FULL_MAX = MINUTES_PER_DAY - 1; // 23:59
const TREND_VIEW_MIN_SPAN = 30; // 최대 확대 = 30분
const TREND_ZOOM_STEP = 1.5; // 버튼 한 번에 1.5배
const TREND_PAN_RATIO = 0.5; // 이동 버튼 한 번에 화면 폭의 절반
const TREND_VIEW_ANIMATION_MS = 280;
const TREND_VIEW_EPSILON = 0.5; // 애니메이션 도착점과의 부동소수점 오차 허용
const TREND_TICK_STEPS = [5, 10, 15, 30, 60, 120, 180]; // 눈금이 12개를 넘지 않는 가장 촘촘한 간격을 고른다
const TREND_TIMELINE_TICK_STEP = 120; // 타임라인 눈금 2시간 + 23:59

// 그래프 영역 크기를 확대 상태와 무관하게 고정하기 위한 축 크기
const TREND_Y_AXIS_WIDTH = 64; // "-1200.00" 정도가 들어가는 폭
const TREND_X_AXIS_EDGE_PADDING = 20; // 끝 눈금 글자 절반("23:59"의 반)이 들어가는 여백

const TREND_GRID_COLOR = "#e6eaf1";
const TREND_TICK_COLOR = "#8a93a6";
const TREND_FONT_FAMILY = '"Pretendard", "Malgun Gothic", "Segoe UI", -apple-system, sans-serif';

// 채널 카드 미니 추이 — 10분 평균으로 줄여 그린다
const TREND_SPARK_BUCKET_MINUTES = 10;
const TREND_SPARK_WIDTH = MINUTES_PER_DAY / TREND_SPARK_BUCKET_MINUTES;
const TREND_SPARK_HEIGHT = 26;

// ---------- 보이는 시간 범위 계산 (DOM과 무관한 순수 함수 — 테스트 대상) ----------

function buildTimeTicks(min, max) {
  const span = max - min;
  const step = TREND_TICK_STEPS.find((s) => span / s <= 12) || TREND_TICK_STEPS[TREND_TICK_STEPS.length - 1];
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) ticks.push({ value: v });
  // 하루 끝(23:59)이 보이면 눈금을 꼭 넣는다 — 없으면 오른쪽 끝에 그리드가 없어 뚫려 보인다
  if (max >= TREND_VIEW_FULL_MAX - 1e-6 && (ticks.length === 0 || ticks[ticks.length - 1].value < TREND_VIEW_FULL_MAX)) {
    ticks.push({ value: TREND_VIEW_FULL_MAX });
  }
  return ticks;
}

// 범위를 00:00~23:59 안으로 밀어 넣는다. 폭은 30분~하루 전체로 제한하고, 한쪽 끝을 넘으면
// 폭을 유지한 채 반대쪽으로 민다. 폭 보정은 가운데 기준 — 왼쪽 끝 기준으로 늘리면 최대 확대에서
// 버튼을 계속 누를 때마다 보던 구간이 오른쪽으로 조금씩 밀린다.
function clampView(min, max) {
  const span = Math.min(TREND_VIEW_FULL_MAX, Math.max(TREND_VIEW_MIN_SPAN, max - min));
  const center = (min + max) / 2;
  const lo = Math.max(0, Math.min(center - span / 2, TREND_VIEW_FULL_MAX - span));
  return { min: lo, max: lo + span };
}

function isFullView(view) {
  return view.max - view.min >= TREND_VIEW_FULL_MAX - TREND_VIEW_EPSILON;
}

// factor < 1 이면 확대, > 1 이면 축소
function zoomedView(view, factor) {
  const center = (view.min + view.max) / 2;
  const span = (view.max - view.min) * factor;
  return clampView(center - span / 2, center + span / 2);
}

function pannedView(view, direction) {
  const shift = (view.max - view.min) * TREND_PAN_RATIO * direction;
  return clampView(view.min + shift, view.max + shift);
}

// 드래그 시작 범위에서 마우스를 deltaPx만큼 끌었을 때 — 오른쪽으로 끌면 과거(왼쪽)가 드러난다
function draggedView(startView, deltaPx, areaWidthPx) {
  const minutesPerPixel = (startView.max - startView.min) / areaWidthPx;
  const delta = -deltaPx * minutesPerPixel;
  return clampView(startView.min + delta, startView.max + delta);
}

// 확대/이동 버튼의 비활성화 상태 — 끝에 닿은 방향은 막는다
function zoomControlState(viewTarget, hasChart) {
  const span = viewTarget.max - viewTarget.min;
  const full = isFullView(viewTarget);
  return {
    zoomIn: !hasChart || span <= TREND_VIEW_MIN_SPAN + TREND_VIEW_EPSILON,
    zoomOut: !hasChart || full,
    panLeft: !hasChart || viewTarget.min <= TREND_VIEW_EPSILON,
    panRight: !hasChart || viewTarget.max >= TREND_VIEW_FULL_MAX - TREND_VIEW_EPSILON,
    reset: !hasChart || full,
  };
}

// ---------- 데이터 변환 ----------

// 듬성듬성할 수 있는 트렌드 포인트를 00:00~23:59 KST 1,440분 슬롯에 채운다
function buildDailySlots(points) {
  const slots = new Array(MINUTES_PER_DAY).fill(null);
  (points || []).forEach((p) => {
    const minute = minuteOfDayKst(p.measuredAt);
    if (minute >= 0 && minute < MINUTES_PER_DAY) slots[minute] = p;
  });
  return slots;
}

// 통신이 끊긴(isConnected === false) 분이 이어지는 구간들
function buildCommLossRanges(slots) {
  const ranges = [];
  let start = null;
  for (let i = 0; i < slots.length; i++) {
    const isLoss = !!slots[i] && slots[i].isConnected === false;
    if (isLoss && start === null) start = i;
    if (!isLoss && start !== null) {
      ranges.push({ startMinute: start, endMinute: i - 1 });
      start = null;
    }
  }
  if (start !== null) ranges.push({ startMinute: start, endMinute: slots.length - 1 });
  return ranges;
}

// 채널 설정의 소수점 자리수 — 설정을 못 받았으면(null) 눈금을 건드리지 않는다
function trendTickPrecision(dp) {
  return dp === null || dp === undefined ? undefined : dp;
}

// 채널 카드 하단 미니 추이(SVG). 기록이 없는 구간은 선을 끊고, 세로 범위는 그날 최소~최대.
function buildSparklineSvg(channelNo, values1440) {
  const values = [];
  for (let b = 0; b < TREND_SPARK_WIDTH; b++) {
    let sum = 0;
    let count = 0;
    for (let i = b * TREND_SPARK_BUCKET_MINUTES; i < (b + 1) * TREND_SPARK_BUCKET_MINUTES; i++) {
      const y = values1440[i];
      if (y !== null && y !== undefined && !Number.isNaN(y)) {
        sum += y;
        count += 1;
      }
    }
    values.push(count > 0 ? sum / count : null);
  }

  const present = values.filter((v) => v !== null);
  if (present.length === 0) return `<svg class="tv-readout-spark" aria-hidden="true"></svg>`;
  const lo = Math.min(...present);
  const hi = Math.max(...present);
  const h = TREND_SPARK_HEIGHT;
  const toY = (v) => (hi === lo ? h / 2 : h - 3 - ((v - lo) / (hi - lo)) * (h - 8));

  const pieces = [];
  let current = [];
  values.forEach((v, b) => {
    if (v === null) {
      if (current.length) pieces.push(current);
      current = [];
    } else {
      current.push([b + 0.5, toY(v)]);
    }
  });
  if (current.length) pieces.push(current);

  const color = CHANNEL_COLORS[channelNo];
  const gradId = `tvSparkGrad-${channelNo}-${Math.random().toString(36).slice(2, 8)}`;
  const pts = (piece) => piece.map(([x, y]) => `${x},${y.toFixed(1)}`).join(" ");
  const areas = pieces
    .map((p) => `<polygon points="${p[0][0]},${h} ${pts(p)} ${p[p.length - 1][0]},${h}" fill="url(#${gradId})" />`)
    .join("");
  const lines = pieces
    .map((p) => `<polyline points="${pts(p)}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" />`)
    .join("");

  return `
    <svg class="tv-readout-spark" viewBox="0 0 ${TREND_SPARK_WIDTH} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="${color}" stop-opacity="0.25" />
          <stop offset="1" stop-color="${color}" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${areas}${lines}
    </svg>`;
}

// ---------- Chart.js 플러그인 (차트마다 options.plugins.<id>로 값을 받는다) ----------

// 확대하면 화면 밖 구간의 좌표가 그래프 영역을 벗어난다 — 음영이 축·여백까지 칠해지지 않게 자른다
function trendClipToChartArea(ctx, chartArea) {
  ctx.beginPath();
  ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
  ctx.clip();
}

function trendForEachVisibleBand(chart, ranges, draw) {
  const { chartArea, scales } = chart;
  const xScale = scales.x;
  ranges.forEach((r) => {
    if (r.endMinute < xScale.min || r.startMinute > xScale.max) return;
    const x0 = xScale.getPixelForValue(r.startMinute);
    const x1 = xScale.getPixelForValue(r.endMinute);
    draw(x0, Math.max(2, x1 - x0), chartArea);
  });
}

let trendCommLossPattern = null;
function trendGetCommLossPattern(ctx) {
  if (trendCommLossPattern) return trendCommLossPattern;
  const size = 8;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d");
  t.fillStyle = "rgba(120, 128, 145, 0.07)";
  t.fillRect(0, 0, size, size);
  t.strokeStyle = "rgba(120, 128, 145, 0.20)";
  t.lineWidth = 2.5;
  // 타일 경계에서 끊기지 않게 대각선을 세 번 긋는다
  [-size, 0, size].forEach((offset) => {
    t.beginPath();
    t.moveTo(offset, size);
    t.lineTo(offset + size, 0);
    t.stroke();
  });
  trendCommLossPattern = ctx.createPattern(tile, "repeat");
  return trendCommLossPattern;
}

function trendFillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

const TREND_CHART_PLUGINS = [
  // 통신 장애 구간 회색 빗금 — 값은 직전 값을 유지한 채 이어지므로 선은 끊지 않고 배경만 칠한다
  {
    id: "commLoss",
    beforeDatasetsDraw(chart, _args, opts) {
      if (!opts.ranges || opts.ranges.length === 0) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      trendClipToChartArea(ctx, chartArea);
      ctx.fillStyle = trendGetCommLossPattern(ctx);
      trendForEachVisibleBand(chart, opts.ranges, (x, w, area) => ctx.fillRect(x, area.top, w, area.bottom - area.top));
      ctx.restore();
    },
  },
  // 경보 구간(발생~해제) — 위가 진하고 아래로 옅어지는 붉은 띠 + 위쪽 끝선
  {
    id: "alarmRange",
    beforeDatasetsDraw(chart, _args, opts) {
      if (!opts.ranges || opts.ranges.length === 0) return;
      const { ctx, chartArea } = chart;
      const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      gradient.addColorStop(0, "rgba(239, 75, 91, 0.20)");
      gradient.addColorStop(1, "rgba(239, 75, 91, 0.03)");
      ctx.save();
      trendClipToChartArea(ctx, chartArea);
      trendForEachVisibleBand(chart, opts.ranges, (x, w, area) => {
        ctx.fillStyle = gradient;
        ctx.fillRect(x, area.top, w, area.bottom - area.top);
        ctx.fillStyle = "rgba(239, 75, 91, 0.7)";
        ctx.fillRect(x, area.top, w, 2);
      });
      ctx.restore();
    },
  },
  // 마우스 위치 세로 점선 + 가로축 글자 아래에 그 시각 배지
  {
    id: "crosshairLine",
    afterDraw(chart) {
      const active = chart.getActiveElements();
      if (!active || active.length === 0) return;
      const x = active[0].element.x;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(23, 32, 51, 0.35)";
      ctx.stroke();
      ctx.setLineDash([]);

      const label = minuteLabel(active[0].index);
      ctx.font = `700 10.5px ${TREND_FONT_FAMILY}`;
      const w = ctx.measureText(label).width + 16;
      const h = 18;
      const bx = Math.max(0, Math.min(chart.width - w, x - w / 2));
      const by = chart.height - h - 2; // layout.padding.bottom 자리
      ctx.fillStyle = "#172033";
      trendFillRoundRect(ctx, bx, by, w, h, 9);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, bx + w / 2, by + h / 2 + 0.5);
      ctx.restore();
    },
  },
  // 세로축 위에 선택 채널의 단위를 채널 색으로 표시한다(예: ℃)
  {
    id: "axisUnit",
    afterDraw(chart, _args, opts) {
      const scale = chart.scales[`y-${opts.channelNo}`];
      if (!scale || !scale.options.display || !opts.unit) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = `700 10.5px ${TREND_FONT_FAMILY}`;
      ctx.fillStyle = CHANNEL_COLORS[opts.channelNo];
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(opts.unit, scale.right - 10, chartArea.top - 8);
      ctx.restore();
    },
  },
  // 그래프 영역 테두리 — 확대하면 끝 지점에 눈금(그리드선)이 없어 테두리가 사라지므로 항상 그린다
  {
    id: "chartFrame",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.strokeStyle = TREND_GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(chartArea.left) + 0.5,
        Math.round(chartArea.top) + 0.5,
        Math.round(chartArea.right - chartArea.left) - 1,
        Math.round(chartArea.bottom - chartArea.top) - 1
      );
      ctx.restore();
    },
  },
];

if (typeof Chart !== "undefined" && Chart.register) Chart.register(...TREND_CHART_PLUGINS);

// 선택한 채널 선 아래를 채널 색 그라데이션으로 채운다(위 진하게 → 아래 투명)
function trendAreaFill(context) {
  const { chart, dataset } = context;
  const area = chart.chartArea;
  if (!area || !dataset) return "transparent";
  const color = CHANNEL_COLORS[dataset.channelNo];
  const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  gradient.addColorStop(0, hexToRgba(color, 0.2));
  gradient.addColorStop(1, hexToRgba(color, 0));
  return gradient;
}

// ---------- 컴포넌트 ----------

const TREND_ICON_CLOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>`;
const TREND_ICON_LIST = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>`;

function createTrendView({ root, timelineRoot = null }) {
  const st = {
    chart: null,
    slots: [],
    datasets: [],
    lastDataIndex: 0,
    selectedChannel: CHANNELS[0].no,
    hiddenChannels: new Set(),
    // view는 지금 화면에 그려진 범위(애니메이션 중에는 중간값), viewTarget은 도착할 범위 —
    // 버튼을 연달아 누르면 도착점 기준으로 누적돼야 해서 둘을 따로 둔다
    view: { min: 0, max: TREND_VIEW_FULL_MAX },
    viewTarget: { min: 0, max: TREND_VIEW_FULL_MAX },
    decimalPlacesByChannel: {},
    animationFrame: null,
    drag: { active: false, startX: 0, startView: null },
  };

  root.classList.add("tv");
  root.innerHTML = `
    <div class="tv-toolbar">
      <div class="tv-zoom-buttons">
        <button type="button" class="tv-zoom-btn" data-action="zoom-out" title="축소" aria-label="축소">−</button>
        <button type="button" class="tv-zoom-btn" data-action="zoom-in" title="확대" aria-label="확대">+</button>
        <button type="button" class="tv-zoom-btn" data-action="pan-left" title="이전 시간으로 이동" aria-label="왼쪽으로 이동">◀</button>
        <button type="button" class="tv-zoom-btn" data-action="pan-right" title="다음 시간으로 이동" aria-label="오른쪽으로 이동">▶</button>
        <button type="button" class="tv-zoom-btn tv-zoom-reset" data-action="reset" title="하루 전체 보기">전체</button>
      </div>
      <span class="tv-range">
        ${TREND_ICON_CLOCK}
        <span class="tv-range-label">그래프 구간</span>
        <span class="tv-range-value">00:00 ~ 23:59</span>
      </span>
    </div>
    <div class="tv-body"><div class="empty-state">불러오는 중...</div></div>
  `;
  const bodyEl = root.querySelector(".tv-body");
  const rangeValueEl = root.querySelector(".tv-range-value");
  const zoomButtons = {
    zoomOut: root.querySelector('[data-action="zoom-out"]'),
    zoomIn: root.querySelector('[data-action="zoom-in"]'),
    panLeft: root.querySelector('[data-action="pan-left"]'),
    panRight: root.querySelector('[data-action="pan-right"]'),
    reset: root.querySelector('[data-action="reset"]'),
  };

  if (timelineRoot) {
    timelineRoot.classList.add("tv-timeline-panel");
    timelineRoot.innerHTML = `
      <div class="tv-timeline-head">
        <h2 class="tv-timeline-title">${TREND_ICON_LIST}운전 상태 타임라인<span class="tv-timeline-target"></span></h2>
        <div class="tv-legend">
          <span class="tv-legend-item"><span class="tv-legend-swatch comm"></span>통신장애 구간</span>
          <span class="tv-legend-item"><span class="tv-legend-swatch alarm"></span>경보 구간(발생~해제)</span>
        </div>
      </div>
      <div class="tv-timeline"></div>
    `;
  }

  // ----- 확대 / 이동 -----

  function setView(min, max) {
    st.view = { min, max };
    if (st.chart) {
      st.chart.options.scales.x.min = min;
      st.chart.options.scales.x.max = max;
      st.chart.update("none");
    }
    rangeValueEl.textContent = `${minuteLabel(Math.round(min))} ~ ${minuteLabel(Math.round(max))}`;
    updateTimelineWindow();
  }

  function updateZoomControls() {
    const disabled = zoomControlState(st.viewTarget, !!st.chart);
    Object.keys(zoomButtons).forEach((key) => {
      zoomButtons[key].disabled = disabled[key];
    });
    const wrap = bodyEl.querySelector(".tv-chart-wrap");
    if (wrap) wrap.classList.toggle("is-zoomed", !!st.chart && !isFullView(st.viewTarget));
  }

  // 도착점을 정하고 가감속 애니메이션으로 이동한다(버튼 동작 전용)
  function goToView(next) {
    st.viewTarget = next;
    updateZoomControls();
    if (!st.chart) {
      setView(next.min, next.max);
      return;
    }
    if (st.animationFrame) cancelAnimationFrame(st.animationFrame);
    const from = { ...st.view };
    const startedAt = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / TREND_VIEW_ANIMATION_MS);
      const k = ease(t);
      setView(from.min + (next.min - from.min) * k, from.max + (next.max - from.max) * k);
      st.animationFrame = t < 1 ? requestAnimationFrame(step) : null;
    };
    st.animationFrame = requestAnimationFrame(step);
  }

  function resetView() {
    if (st.animationFrame) cancelAnimationFrame(st.animationFrame);
    st.animationFrame = null;
    st.viewTarget = { min: 0, max: TREND_VIEW_FULL_MAX };
    setView(0, TREND_VIEW_FULL_MAX);
    updateZoomControls();
  }

  root.querySelector(".tv-toolbar").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action === "zoom-in") goToView(zoomedView(st.viewTarget, 1 / TREND_ZOOM_STEP));
    else if (action === "zoom-out") goToView(zoomedView(st.viewTarget, TREND_ZOOM_STEP));
    else if (action === "pan-left") goToView(pannedView(st.viewTarget, -1));
    else if (action === "pan-right") goToView(pannedView(st.viewTarget, 1));
    else if (action === "reset") goToView({ min: 0, max: TREND_VIEW_FULL_MAX });
  });

  // 드래그 이동 — 가감속·관성 없이 마우스를 1:1로 따라간다. 캔버스 밖으로 나가도 끊기지 않게
  // 추적은 window에서 받는다.
  function onMouseDown(event) {
    if (event.button !== 0 || !st.chart || event.target.tagName !== "CANVAS") return;
    if (isFullView(st.view)) return; // 하루 전체를 보고 있으면 옮길 곳이 없다
    if (st.animationFrame) cancelAnimationFrame(st.animationFrame);
    st.animationFrame = null;
    st.drag = { active: true, startX: event.clientX, startView: { ...st.view } };
    document.body.classList.add("tv-dragging");
    event.preventDefault();
  }
  function onMouseMove(event) {
    if (!st.drag.active || !st.chart) return;
    const area = st.chart.chartArea;
    const next = draggedView(st.drag.startView, event.clientX - st.drag.startX, area.right - area.left);
    st.viewTarget = next;
    setView(next.min, next.max);
    updateZoomControls();
  }
  function onMouseUp() {
    if (!st.drag.active) return;
    st.drag.active = false;
    document.body.classList.remove("tv-dragging");
  }
  bodyEl.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  // ----- 채널 카드 -----

  function buildReadout() {
    const el = bodyEl.querySelector(".tv-readout");
    el.innerHTML = st.datasets
      .map(
        (ds) => `
          <div class="tv-readout-row" data-channel="${ds.channelNo}" style="--channel-color: ${CHANNEL_COLORS[ds.channelNo]}">
            <div class="tv-readout-head">
              <span class="tv-readout-dot"></span>
              <span class="tv-readout-name">${escapeHtml(ds.label)}</span>
              <span class="tv-readout-ch">${ds.channelNo}</span>
            </div>
            <div class="tv-readout-value">
              <span class="tv-readout-num">-</span>
              <span class="tv-readout-unit">${escapeHtml(ds.unit)}</span>
              <button type="button" class="tv-readout-toggle" aria-label="${ds.channelNo} 보기/숨기기"></button>
            </div>
            ${buildSparklineSvg(ds.channelNo, ds.data.map((p) => p.y))}
          </div>
        `
      )
      .join("");

    el.querySelectorAll(".tv-readout-row").forEach((row) => {
      row.addEventListener("click", () => selectChannel(row.dataset.channel));
    });
    // 토글은 선택과 별개 동작이라 클릭이 카드로 번지지 않게 막는다
    el.querySelectorAll(".tv-readout-toggle").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleChannelVisibility(btn.closest(".tv-readout-row").dataset.channel);
      });
    });
    applyReadoutSelection();
    applyChannelVisibility();
  }

  // 마우스 위치의 값만 텍스트로 갱신한다(DOM 재생성 없음 — 잦은 mousemove에도 가볍다)
  function updateReadoutValues(index) {
    const point = st.slots[index];
    bodyEl.querySelectorAll(".tv-readout-row").forEach((row) => {
      const ds = st.datasets.find((d) => d.channelNo === row.dataset.channel);
      const raw = point && ds ? point[ds.channelNo.toLowerCase()] : null;
      // 통신장애 구간은 그래프 배경으로 이미 드러나므로 값에 별도 문구를 붙이지 않는다
      row.querySelector(".tv-readout-num").textContent =
        raw === null || raw === undefined ? "-" : formatRawValue(raw, ds.decimalPlaces);
    });
  }

  function applyReadoutSelection() {
    bodyEl.querySelectorAll(".tv-readout-row").forEach((row) => {
      row.classList.toggle("selected", row.dataset.channel === st.selectedChannel);
    });
  }

  function toggleChannelVisibility(channelNo) {
    if (st.hiddenChannels.has(channelNo)) st.hiddenChannels.delete(channelNo);
    else st.hiddenChannels.add(channelNo);
    applyChannelVisibility();
  }

  function applyChannelVisibility() {
    if (st.chart) {
      st.chart.data.datasets.forEach((ds) => {
        ds.hidden = st.hiddenChannels.has(ds.channelNo);
      });
      st.chart.update("none");
    }
    bodyEl.querySelectorAll(".tv-readout-row").forEach((row) => {
      const isHidden = st.hiddenChannels.has(row.dataset.channel);
      row.classList.toggle("is-hidden", isHidden);
      const btn = row.querySelector(".tv-readout-toggle");
      btn.classList.toggle("off", isHidden);
      btn.setAttribute("aria-pressed", String(!isHidden));
      btn.title = isHidden ? "그래프에 표시하기" : "그래프에서 숨기기";
    });
  }

  // 채널 하나는 항상 선택되어 있다 — 다른 채널을 누르면 그 채널로 바뀔 뿐 해제는 없다
  function selectChannel(channelNo) {
    if (st.selectedChannel === channelNo) return;
    st.selectedChannel = channelNo;
    applyHighlight();
    applyReadoutSelection();
    updateReadoutValues(st.lastDataIndex);
  }

  // 선택 채널은 굵게·맨 앞·선 아래 채움·세로축 표시, 나머지는 옅게
  function applyHighlight() {
    const chart = st.chart;
    if (!chart) return;
    chart.data.datasets.forEach((ds) => {
      const isSelected = ds.channelNo === st.selectedChannel;
      ds.borderWidth = isSelected ? 2.6 : 1.6;
      ds.borderColor = isSelected ? CHANNEL_COLORS[ds.channelNo] : hexToRgba(CHANNEL_COLORS[ds.channelNo], 0.22);
      ds.fill = isSelected ? "start" : false;
      ds.order = isSelected ? 0 : 1;
      const axis = chart.options.scales[`y-${ds.channelNo}`];
      if (axis) axis.display = isSelected;
    });
    const selected = chart.data.datasets.find((ds) => ds.channelNo === st.selectedChannel);
    chart.options.plugins.axisUnit = { channelNo: st.selectedChannel, unit: selected ? selected.unit : "" };
    chart.update("none");
  }

  // ----- 타임라인 -----

  function renderTimeline(label, commRanges, alarmRanges) {
    if (!timelineRoot) return;
    timelineRoot.querySelector(".tv-timeline-target").textContent = label || "";
    const pct = (minute) => (minute / TREND_VIEW_FULL_MAX) * 100;
    const segment = (kind, r, title) => {
      const left = pct(r.startMinute);
      const width = Math.min(100 - left, pct(r.endMinute - r.startMinute));
      return `<div class="tv-timeline-seg ${kind}" style="left:${left}%;width:${width}%" title="${escapeHtml(title)}"></div>`;
    };
    const ticks = [];
    for (let m = 0; m < TREND_VIEW_FULL_MAX; m += TREND_TIMELINE_TICK_STEP) ticks.push(m);
    ticks.push(TREND_VIEW_FULL_MAX);

    timelineRoot.querySelector(".tv-timeline").innerHTML = `
      <div class="tv-timeline-track">
        ${ticks
          .slice(1, -1)
          .map((m) => `<div class="tv-timeline-grid" style="left:${pct(m)}%"></div>`)
          .join("")}
        ${commRanges.map((r) => segment("comm", r, `통신장애 ${minuteLabel(r.startMinute)} ~ ${minuteLabel(r.endMinute)}`)).join("")}
        ${alarmRanges
          .map((r) => segment("alarm", r, `경보 ${r.channelNo} ${minuteLabel(r.startMinute)} ~ ${minuteLabel(r.endMinute)}`))
          .join("")}
        <div class="tv-timeline-window" hidden></div>
      </div>
      <div class="tv-timeline-axis">
        ${ticks.map((m) => `<span style="left:${pct(m)}%">${minuteLabel(m)}</span>`).join("")}
      </div>
    `;
    updateTimelineWindow();
  }

  // 그래프에 보이는 구간을 타임라인 위에 테두리로 표시한다 — 하루 전체를 보고 있으면 감춘다
  function updateTimelineWindow() {
    if (!timelineRoot) return;
    const el = timelineRoot.querySelector(".tv-timeline-window");
    if (!el) return;
    el.hidden = isFullView(st.view);
    el.style.left = `${(st.view.min / TREND_VIEW_FULL_MAX) * 100}%`;
    el.style.width = `${((st.view.max - st.view.min) / TREND_VIEW_FULL_MAX) * 100}%`;
  }

  // ----- 그리기 -----

  function destroyChart() {
    if (!st.chart) return;
    st.chart.destroy();
    st.chart = null;
  }

  // 그래프 대신 안내 문구를 보여준다(높이는 CSS로 유지). 타임라인은 경보 구간만이라도 그린다.
  function showMessage(message, { label = "", alarmRanges = [] } = {}) {
    destroyChart();
    bodyEl.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    renderTimeline(label, [], alarmRanges);
    updateZoomControls();
  }

  function setData({ points, channelSettings, alarmRanges = [], label = "", emptyMessage = "이 날짜에 기록된 트렌드가 없습니다." }) {
    if (!points || points.length === 0) {
      showMessage(emptyMessage, { label, alarmRanges });
      return;
    }

    const slots = buildDailySlots(points);
    st.slots = slots;
    st.lastDataIndex = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) st.lastDataIndex = i;
    }
    const commRanges = buildCommLossRanges(slots);

    st.datasets = CHANNELS.map((ch) => {
      const setting = findChannelSetting(channelSettings, ch.no);
      const dp = setting ? setting.decimalPlaces : null;
      const key = ch.no.toLowerCase();
      return {
        label: (setting && setting.channelName) || ch.label,
        channelNo: ch.no,
        unit: (setting && setting.unit) || ch.unit,
        decimalPlaces: dp,
        // 가로축은 분 단위 숫자축(0~1439) — 확대/이동 애니메이션 중 소수점 범위로 부드럽게 움직이려면
        // 범주형 축이 아니라 숫자축이어야 한다
        data: slots.map((p, i) => ({ x: i, y: p ? toActualValue(p[key], dp) : null })),
      };
    });
    st.decimalPlacesByChannel = Object.fromEntries(st.datasets.map((ds) => [ds.channelNo, ds.decimalPlaces]));

    renderTimeline(label, commRanges, alarmRanges);

    // 차트가 이미 있으면 캔버스를 다시 만들지 않고 데이터만 갈아끼운다(깜빡임 없음, 보던 구간 유지)
    if (st.chart && bodyEl.querySelector(".tv-split")) {
      const chart = st.chart;
      chart.data.datasets.forEach((ds, i) => {
        const next = st.datasets[i];
        ds.data = next.data;
        ds.label = next.label;
        ds.unit = next.unit;
        ds.decimalPlaces = next.decimalPlaces;
      });
      chart.options.plugins.commLoss.ranges = commRanges;
      chart.options.plugins.alarmRange.ranges = alarmRanges;
      chart.options.scales.x.min = st.view.min;
      chart.options.scales.x.max = st.view.max;
      CHANNELS.forEach((ch) => {
        chart.options.scales[`y-${ch.no}`].ticks.precision = trendTickPrecision(st.decimalPlacesByChannel[ch.no]);
      });
      buildReadout(); // 압축기마다 채널명·단위가 다를 수 있다
      updateReadoutValues(st.lastDataIndex);
      applyHighlight();
      updateZoomControls();
      return;
    }

    bodyEl.innerHTML = `
      <div class="tv-split">
        <div class="tv-chart-wrap"><canvas></canvas></div>
        <div class="tv-readout"></div>
      </div>
    `;
    buildReadout();
    updateReadoutValues(st.lastDataIndex);
    createChart(commRanges, alarmRanges);
    applyHighlight();
    updateZoomControls();
  }

  function createChart(commRanges, alarmRanges) {
    const yScales = {};
    CHANNELS.forEach((ch) => {
      yScales[`y-${ch.no}`] = {
        display: ch.no === st.selectedChannel,
        grace: "10%",
        grid: { color: TREND_GRID_COLOR },
        border: { display: false, dash: [3, 4] }, // 가로 그리드선은 점선
        ticks: {
          color: TREND_TICK_COLOR,
          font: { size: 11 },
          // precision은 눈금 간격을 이 자리수 단위로 맞춰, 소수점 1자리 채널에 0.25 같은 간격이 안 생기게 한다
          precision: trendTickPrecision(st.decimalPlacesByChannel[ch.no]),
          callback: (value) => {
            const dp = trendTickPrecision(st.decimalPlacesByChannel[ch.no]);
            return dp === undefined ? value : Number(value).toFixed(dp);
          },
        },
        // 세로축 폭 고정 — 확대하면 눈금 숫자 길이가 달라져 그래프가 좌우로 출렁인다.
        // 보이는 축(선택 채널)만 고정해야 한다 — 숨긴 축 6개까지 고정하면 그래프가 오른쪽으로 쏠린다
        afterFit: (scale) => {
          if (scale.options.display) scale.width = TREND_Y_AXIS_WIDTH;
        },
      };
    });

    const datasets = st.datasets.map((ds) => ({
      ...ds,
      borderColor: CHANNEL_COLORS[ds.channelNo],
      backgroundColor: trendAreaFill,
      borderWidth: 2,
      borderJoinStyle: "round",
      fill: false,
      pointRadius: 0,
      // 마우스 위치 점은 선택 채널에만 찍는다(옅은 채널까지 찍으면 세로선 위가 어지럽다)
      pointHoverRadius: (context) => (context.dataset.channelNo === st.selectedChannel ? 4 : 0),
      pointHitRadius: 8,
      pointHoverBackgroundColor: "#fff",
      pointHoverBorderWidth: 2,
      tension: 0.15,
      yAxisID: `y-${ds.channelNo}`,
      hidden: st.hiddenChannels.has(ds.channelNo),
    }));

    Chart.defaults.font.family = TREND_FONT_FAMILY;
    st.chart = new Chart(bodyEl.querySelector("canvas").getContext("2d"), {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        // 위: 세로축 단위 글자 자리, 아래: 가로축 글자 밑에 마우스 시각 배지 자리
        layout: { padding: { top: 24, right: 6, bottom: 22, left: 2 } },
        parsing: { xAxisKey: "x", yAxisKey: "y" },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "linear",
            min: st.view.min,
            max: st.view.max,
            // 보이는 범위에 맞춰 눈금 간격을 바꾼다(하루 전체 2시간 ~ 30분 5분)
            afterBuildTicks: (axis) => {
              axis.ticks = buildTimeTicks(axis.min, axis.max);
            },
            // 양 끝 여백 고정 — 끝 눈금 유무에 따라 그래프 폭이 달라지지 않게
            afterFit: (scale) => {
              scale.paddingLeft = TREND_X_AXIS_EDGE_PADDING;
              scale.paddingRight = TREND_X_AXIS_EDGE_PADDING;
            },
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: TREND_TICK_COLOR,
              font: { size: 11 },
              maxRotation: 0,
              autoSkip: false,
              callback: (value) => minuteLabel(Math.round(value)),
            },
          },
          ...yScales,
        },
        plugins: {
          legend: { display: false },
          commLoss: { ranges: commRanges },
          alarmRange: { ranges: alarmRanges },
          axisUnit: { channelNo: st.selectedChannel, unit: "" },
          tooltip: {
            enabled: false,
            external: (context) => {
              const tooltip = context.tooltip;
              if (!tooltip || tooltip.opacity === 0 || !tooltip.dataPoints || tooltip.dataPoints.length === 0) {
                updateReadoutValues(st.lastDataIndex);
                return;
              }
              updateReadoutValues(tooltip.dataPoints[0].dataIndex);
            },
          },
        },
      },
    });
  }

  function destroy() {
    destroyChart();
    if (st.animationFrame) cancelAnimationFrame(st.animationFrame);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  updateZoomControls();

  return {
    setData,
    showMessage,
    resetView,
    destroy,
    getView: () => ({ ...st.view }),
    getViewTarget: () => ({ ...st.viewTarget }),
    get chart() {
      return st.chart;
    },
  };
}
