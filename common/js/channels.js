// CH01~CH07 채널 공통 정의 (백엔드 기능 명세의 센서 채널 정의 기준)
// 채널값 자체는 TLC 원시값(raw int16)이며, 실제 값으로 변환하려면
// GET /api/compressors/{id}/channel-settings의 decimalPlaces를 적용한다
// (reference/api-manual.md 5-1번).

const CHANNELS = [
  { no: "CH01", label: "흡입온도", unit: "℃" },
  { no: "CH02", label: "토출온도", unit: "℃" },
  { no: "CH03", label: "오일온도", unit: "℃" },
  { no: "CH04", label: "흡입압력", unit: "MPa" },
  { no: "CH05", label: "토출압력", unit: "MPa" },
  { no: "CH06", label: "오일압력", unit: "MPa" },
  { no: "CH07", label: "운전전류", unit: "A" },
];

// 단위별 표시 소수점 자리수 기본값 — 백엔드 ChannelDefaults와 같은 값이다
// (reference/Equipment/README.md: 압력 2자리, 온도·전압·전류 1자리).
// 압축기를 새로 만들 때 서버가 이 기준으로 채널 설정을 채우므로, 아직 채널 설정을
// 조회할 수 없는 "신규 장비 등록" 화면에서 raw 변환에 쓰는 가정값이기도 하다.
const DEFAULT_DECIMAL_PLACES_BY_UNIT = {
  MPa: 2,
  "℃": 1,
  V: 1,
  A: 1,
};

// 채널별 기본 소수점 자리수 — 채널 설정을 아직 못 받았을 때 쓴다
function defaultDecimalPlacesForChannel(channelNo) {
  const meta = CHANNELS.find((c) => c.no === channelNo);
  return meta ? DEFAULT_DECIMAL_PLACES_BY_UNIT[meta.unit] ?? null : null;
}

// 채널값을 읽어오는 TLC D-Register 주소의 표준값(reference/pclink protocol.md).
// 실제 주소는 압축기별 설정값이라 장비에 따라 다를 수 있다 — 여기 값은 입력칸을 채워주는
// 제안값일 뿐이고, 맞지 않으면 담당자가 고쳐서 저장한다.
const STANDARD_REGISTER_ADDRESSES = {
  CH01: 360,
  CH02: 361,
  CH03: 362,
  CH04: 364,
  CH05: 365,
  CH06: 366,
  CH07: 367,
};

// 채널별 그래프 선 색 — 트렌드 그래프·채널 카드·이벤트 채널 태그가 모두 같은 색을 쓴다
const CHANNEL_COLORS = {
  CH01: "#2a78d6", // blue
  CH02: "#eb6834", // orange
  CH03: "#1baf7a", // aqua
  CH04: "#eda100", // yellow
  CH05: "#e87ba4", // magenta
  CH06: "#008300", // green
  CH07: "#4a3aa7", // violet
};

const MINUTES_PER_DAY = 1440;

// 압축기별 채널 설정(decimalPlaces 포함)은 자주 바뀌지 않으므로 캐싱해서 재사용한다
// (api-manual.md 5-1번 "매번 새로 조회하기보다 프론트에서 적당히 캐싱해도 된다" 참고).
const channelSettingsCache = new Map();

async function getChannelSettings(compressorId) {
  if (channelSettingsCache.has(compressorId)) {
    return channelSettingsCache.get(compressorId);
  }
  const settings = await apiFetch(`/api/compressors/${compressorId}/channel-settings`);
  channelSettingsCache.set(compressorId, settings);
  return settings;
}

function findChannelSetting(settingsList, channelNo) {
  return (settingsList || []).find((s) => s.channelNo === channelNo);
}

// 채널 설정을 저장(PUT)한 뒤에는 반드시 호출해야 한다 — 캐시를 지우지 않으면 같은
// 압축기를 다시 열었을 때 저장 전 값이 그대로 다시 보여서 "저장이 안 된 것처럼" 보인다.
function invalidateChannelSettingsCache(compressorId) {
  channelSettingsCache.delete(compressorId);
}

// raw int16 값을 decimalPlaces만큼 소수점을 적용한 실제 값 문자열로 변환한다.
// decimalPlaces를 아직 모르면(설정 조회 실패 등) raw 값을 그대로 보여준다.
function formatRawValue(rawValue, decimalPlaces) {
  if (rawValue === null || rawValue === undefined) return "-";
  if (decimalPlaces === null || decimalPlaces === undefined) return String(rawValue);
  return (rawValue / Math.pow(10, decimalPlaces)).toFixed(decimalPlaces);
}

// formatRawValue와 같은 변환을 숫자로 반환한다 (차트에 실제 값을 그릴 때 사용).
function toActualValue(rawValue, decimalPlaces) {
  if (rawValue === null || rawValue === undefined) return null;
  if (decimalPlaces === null || decimalPlaces === undefined) return rawValue;
  return rawValue / Math.pow(10, decimalPlaces);
}

// toActualValue의 역변환. 판정 로직(AlarmEvaluator 등)이 raw int16끼리만 비교하므로
// 소수점 적용은 100% 프론트 책임 — 사용자가 "18.5"를 입력하면 decimalPlaces(예: 1)를
// 적용해 185(raw)로 변환해서 API에 보내야 한다.
function toRawValue(actualValue, decimalPlaces) {
  if (actualValue === null || actualValue === undefined || Number.isNaN(actualValue)) return null;
  if (decimalPlaces === null || decimalPlaces === undefined) return Math.round(actualValue);
  return Math.round(actualValue * Math.pow(10, decimalPlaces));
}
