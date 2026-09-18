# 백엔드 요청 — 실시간 현황(대시보드) 개편

작성: 2026-09-17 (프론트)
관련 화면: `pages/dashboard/dashboard.html` 전면 개편
화면 시안: `_mockup/dashboard_design_v4.html` (캡처 `_mockup/dashboard_design_v4_1920.png`)

## 요약

| # | 요청 | 종류 | 우선순위 |
|---|---|---|---|
| 1 | 시스템 정보 API 신설 — 저장소·CPU·메모리·서버 상태·DB 백업·수집 주기·API 상태·가동시간 | 신규 | 필수 |
| 2 | 대시보드 5초 갱신용 경량 상태 API — 장비 + 소속 압축기 상태만 | 신규 | 권장 |
| 3 | (2를 안 할 경우) `GET /api/compressors` 응답에 `equipmentId`, `sequenceNo` 추가 | 변경 | 2의 대안 |

1이 준비되기 전까지 화면의 "시스템 정보"·"서버 상태" 카드는 "연동 준비 중"으로 표시한다.

---

## 1. 시스템 정보 API (신규)

### `GET /api/system/status`

화면 우측 "시스템 정보"·"서버 상태" 카드 전체를 이 API 하나로 채운다. 프론트는 **30초마다** 호출한다.

- 권한: 로그인한 누구나
- 응답 예시:

```json
{
  "checkedAt": "2026-09-17T07:05:00+00:00",

  "storage": {
    "usedBytes": 442381631488,
    "totalBytes": 1073741824000,
    "target": "D:"
  },

  "cpu": {
    "usagePercent": 23.4,
    "coreCount": 8
  },

  "memory": {
    "usedBytes": 10522669875,
    "totalBytes": 17179869184
  },

  "server": {
    "status": "정상",
    "startedAt": "2026-09-05T02:32:00+00:00"
  },

  "databaseBackup": {
    "lastBackupAt": "2026-09-16T18:00:00+00:00",
    "lastBackupSucceeded": true,
    "scheduleText": "매일 03:00"
  },

  "collection": {
    "intervalSeconds": 3,
    "compressorCount": 245
  },

  "api": {
    "status": "정상"
  }
}
```

### 필드 설명

| 필드 | 화면 표시 | 설명 |
|---|---|---|
| `checkedAt` | "30초 갱신" 옆 기준 시각 | 서버가 값을 측정한 시각(UTC) |
| `storage.usedBytes` / `totalBytes` | 저장소 사용량 도넛(사용률 %), 사용량 / 전체 용량 / 남은 용량 | 바이트 단위. 남은 용량·%는 프론트가 계산 |
| `storage.target` | (툴팁) | 어느 디스크 기준인지. **DB 데이터가 저장되는 드라이브**를 기준으로 해 주세요 |
| `cpu.usagePercent` | CPU 막대 | 0~100. 순간값이 튀면 최근 몇 초 평균이면 좋음 |
| `cpu.coreCount` | "8코어" | 논리 코어 수 |
| `memory.usedBytes` / `totalBytes` | 메모리 막대, "9.8 / 16 GB" | 서버 전체 메모리 기준 |
| `server.status` | 서버 상태 배지 | `정상` / `주의` / `오류` 중 하나(판정 기준은 백엔드 결정 — 예: 디스크 90% 이상이면 주의) |
| `server.startedAt` | 시스템 가동시간("12일 4시간"), 시작 시각 | 백엔드 프로세스(또는 서버) 시작 시각. 가동시간은 프론트가 계산 |
| `databaseBackup.lastBackupAt` | DB 백업 날짜 | 마지막으로 **성공한** 백업 시각. 백업 이력이 없으면 `null` |
| `databaseBackup.lastBackupSucceeded` | 백업 상태 배지 | 가장 최근 백업 시도의 성공 여부 |
| `databaseBackup.scheduleText` | "매일 03:00 자동" | 백업 일정 설명 문자열. 일정이 없으면 `null` |
| `collection.intervalSeconds` | 데이터 수집 주기 "3초" | 압축기 폴링 주기(설정값) |
| `collection.compressorCount` | "압축기 245대" | 수집 대상 압축기 수 |
| `api.status` | API 상태 배지 | 백엔드 내부 구성요소 점검 결과 — 예: DB 연결, 압축기 수집 서비스 동작 여부. `정상` / `주의` / `오류`. (API가 응답하는 것 자체로 "살아있음"은 프론트가 알 수 있으므로, 여기서는 **내부 의존 요소 상태**를 알려주면 됨) |

- 응답 시간(ms)은 프론트가 이 API 호출 시간을 직접 재서 표시한다(백엔드 필드 불필요).
- 측정이 실패한 항목은 해당 객체를 `null`로 주면 프론트가 그 칸만 "-"로 표시한다.
- enum 성격의 값(`정상`/`주의`/`오류`)은 기존 규칙대로 한글 문자열로 부탁드립니다.

### 확인이 필요한 사항

1. DB 백업이 현재 어떤 방식으로 돌고 있는지(백업 이력을 어디서 읽을 수 있는지). 백업 기능이 아직 없다면 `databaseBackup`은 `null`로 시작하고 별도 논의.
2. CPU/메모리/디스크를 서버 OS에서 읽을 권한(운영 서버 배포 형태: IIS / 서비스 / 컨테이너 등).
3. `server.status`, `api.status` 판정 기준.

---

## 2. 대시보드 경량 상태 API (신규, 권장)

### 배경

새 실시간 현황은 **5초마다** 장비 106대와 압축기 245대의 상태를 갱신한다. 장비 리스트 행에 압축기 수만큼 번호 배지를 두고 **통신 이상인 압축기 번호만 빨간색**으로 표시하며, 장비별 통신·경보 on/off 배지를 상시 보여준다.

현재 이 정보를 얻으려면 두 API를 5초마다 불러야 한다(2026-09-17 테스트 서버 실측).

| API | 응답 크기 | 응답 시간 |
|---|---|---|
| `GET /api/equipments` (장비 속성 40여 개 필드 전체) | 약 120 KB | 약 13 ms |
| `GET /api/compressors` | 약 39 KB | 약 12 ms |

접속자 1명당 5초에 약 160 KB(분당 약 1.9 MB)다. 화면에 필요한 건 상태값 몇 개뿐이라, 상태만 담은 API가 있으면 트래픽이 크게 줄고 아래 3번 문제도 함께 해결된다.

### `GET /api/equipments/status`

- 권한: 로그인한 누구나
- 응답 예시:

```json
[
  {
    "id": 1,
    "region": "A지구",
    "buildingName": "PT배기환경시험동",
    "name": "인증환경챔버&쇼크룸",
    "status": "운영",
    "isRunning": true,
    "communicationStatus": "연결됨",
    "hasAlarm": false,
    "compressors": [
      { "id": 1, "sequenceNo": 1, "communicationStatus": "연결됨", "hasAlarm": false },
      { "id": 2, "sequenceNo": 2, "communicationStatus": "끊김", "hasAlarm": false }
    ]
  }
]
```

- 정렬: 기존 `GET /api/equipments`와 같게(`buildingName` → `name`), `compressors`는 `sequenceNo` 오름차순.
- 필드 의미는 기존 1번(장비)·3번(압축기) API와 동일.

---

## 3. `GET /api/compressors` 응답 필드 추가 (2의 대안)

2를 만들지 않는다면 최소한 이 변경이 필요하다.

- 추가 필드: **`equipmentId`**, **`sequenceNo`**
- 이유: 현재 응답에는 소속 장비 id가 없어 프론트가 `buildingName` + `equipmentName` 문자열로 장비와 짝지어야 한다. 지금 106대에는 이름 중복이 없어 동작하지만, 같은 시설동에 같은 이름의 장비가 생기면 어긋난다. 압축기 번호도 응답 순서에 의존하게 된다.

```json
{
  "id": 1,
  "equipmentId": 1,
  "sequenceNo": 1,
  "buildingName": "PT배기환경시험동",
  "equipmentName": "인증환경챔버&쇼크룸",
  "ipAddress": "10.93.78.201",
  "macAddress": "00:06:AC:E0:0D:5A",
  "communicationStatus": "연결됨",
  "hasAlarm": false
}
```

---

## 참고 — 프론트에서 처리하는 것 (백엔드 작업 불필요)

- **통신 불량 장비 수(장비 기준)**: 장비 목록의 `communicationStatus`로 프론트가 집계한다(`/api/summary`는 압축기 기준만 제공).
- **이벤트 하단 티커**: 기존 `GET /api/events?since=` 폴링을 그대로 쓴다.
- **메모리·저장소 GB 표시, 사용률 %, 가동시간 문자열**: 바이트·시각 값으로 프론트가 계산한다.
