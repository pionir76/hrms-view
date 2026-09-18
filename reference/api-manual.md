# HRMS API 매뉴얼 (프론트엔드용)

프론트엔드에서 호출할 수 있는 REST API 전체 목록. 새 API가 추가/변경되면 **이 문서도 반드시 같이 갱신**한다 (CLAUDE.md에 규칙으로 명시되어 있음).

## 공통 사항

- **로그인 필요**. `/api/auth/login`을 제외한 모든 API는 요청 헤더에 `Authorization: Bearer {token}`을 포함해야 한다. 토큰이 없거나 유효하지 않으면 `401 Unauthorized`.
- 토큰은 로그인 응답의 `token` 값이며, 발급 후 **12시간 뒤 만료**된다 (refresh 기능 없음 — 만료되면 재로그인). 만료된 토큰으로 호출해도 `401`.
- 개발 서버 주소: `http://localhost:5018` (인증서 문제 없이 바로 호출 가능, 기본 실행 시 이 주소) 또는 `https://localhost:7253` (자체 서명 인증서 — 브라우저에서 그 주소로 먼저 접속해 경고를 수락해야 fetch 가능)
- 개발 환경(`Development`)에서는 모든 origin에 대해 CORS가 열려있다. 프론트를 백엔드와 같은 PC의 다른 포트(Vite/CRA 개발 서버 등)에서 띄워도 별도 설정 없이 바로 호출 가능하다. 운영 환경에서는 CORS가 비활성화되어 있으므로, 실제 배포 시 프론트 origin을 확정해서 추가해야 한다.
- 모든 응답은 JSON. 필드명은 camelCase.
- **enum 필드는 전부 사람이 읽을 수 있는 한글 문자열**로 내려간다 (숫자 코드 아님). 각 필드가 가질 수 있는 값은 아래 "enum 값 목록" 참고.
- **날짜/시간 파라미터(`date`, `from`, `to`)는 한국 시간(KST) 기준**으로 해석된다.
- **압축기 채널값(`value`, `ch01`~`ch07`)은 전부 TLC 원시값(raw int16)이다.** 서버는 소수점 변환을 하지 않는다 — 실제 값으로 표시하는 건 프론트가 담당한다. 채널별 소수점 자리수(dp)는 `GET /api/compressors/{id}/channel-settings`(5-1번)로 조회한다.
- 존재하지 않는 리소스를 조회하면 `404 Not Found`를 반환한다 (본문 없음).
- **장비 상태가 `운영`이 아닌 장비는 실시간 현황 계열 API에 나오지 않는다**(사양 확정 2026-09-17 — 수집도 하지 않는다). 대상: `GET /api/compressors`(4번), `GET /api/summary`(8번), `GET /api/equipments/status`(70번). 장비관리용 `GET /api/equipments`(1번)·`GET /api/equipments/{id}`(2번)는 상태를 되돌릴 수 있도록 **모든 상태의 장비**를 그대로 내려준다 — 모니터링 화면에서 1번을 쓴다면 프론트가 `status === "운영"`으로 걸러야 한다.

## enum 값 목록

| 필드 | 가능한 값 |
|---|---|
| 장비 `status` | 운영, 미운영, 수리중, 점검중, 철거예정, 철거, 사용중지, 기타 |
| `communicationStatus`(장비/압축기 목록 API) | 연결됨, 끊김, 재접속중 |
| `channelNo` | CH01, CH02, CH03, CH04, CH05, CH06, CH07 |
| 첨부파일 `ownerType` | `EquipmentPhoto`(장비 이력카드 사진), `EquipmentInspectionHistory`(장비 검사이력 첨부), `TrainingLog`(교육훈련 일지 첨부), `Notice`(공지사항 첨부), `AppointmentReport`(사용자 선해임 신고서). 수리일지는 첨부 미지원 |
| 담당업무 `role`(조직관리) | 안전관리총괄자, 안전관리책임자, 안전관리원, 일반관리원 |

운전 상태는 처음부터 "운전/정지" 둘 뿐이라 enum 문자열이 아니라 **boolean `isRunning`**으로 내려간다. 경보 상태도 마찬가지로 장비/압축기 목록 API에서는 세부 단계(경보발생대기/정상복귀대기 등) 없이 **boolean `hasAlarm`**(경보 확정 여부)로만 내려간다 — 프론트는 확정된 경보 여부만 필요하다는 결정. 트렌드 API(`/trend`)도 같은 이유로 `communicationStatus`를 `isConnected`(boolean)로 대신한다 — 6번 항목 참고.

---

## 0. `POST /api/auth/login`

로그인. 인증이 필요 없는 유일한 API.

**요청**
```json
{ "username": "admin", "password": "admin1234" }
```

**응답 예시 (200)**
```json
{ "token": "eyJhbGciOi...", "username": "admin", "role": "시스템관리자" }
```

이후 요청에는 `Authorization: Bearer {token}` 헤더를 붙인다.

`role`은 `시스템관리자` / `안전관리총괄자` / `안전관리책임자` / `안전관리원` / `일반관리원` 중 하나. `시스템관리자`만 전체 권한을 갖는다. 나머지 4개 역할은 조직관리 화면의 **담당업무**와 같은 값이며(59~69번), 조회·작성(예: 점검일지 저장)엔 차이가 없고 **결재 동작에서** 역할별로 갈린다 — 안전관리원/안전관리책임자/안전관리총괄자만 결재 대상이고 `일반관리원`은 결재에 참여하지 않는다(결재 시스템 상세는 10번 항목 참고). (2026-09-17에 `일반관리자`를 `일반관리원`으로 이름 변경.) 비상정지 권한은 아직 별도 플래그로 존재하지 않으며, 나중에 역할 기준(예: "안전관리책임자만 가능")으로 일괄 적용할 예정이다.

**오류**: 아이디/비밀번호가 틀리거나 비활성화된 계정이면 `401 Unauthorized` (본문 없음).

## 0-1. `POST /api/auth/logout`

로그아웃 이력만 기록한다 (토큰 자체는 서버가 무효화하지 않으므로, 프론트에서 저장해둔 토큰을 버리는 것이 실질적인 로그아웃이다). `Authorization` 헤더 필요.

**응답**: `200 OK` (본문 없음)

---

## 1. `GET /api/equipments`

장비 전체 목록(**모든 상태의 장비 포함** — 장비관리 화면용. 실시간 현황의 5초 갱신에는 70번을 쓴다). 이제 실시간 상태뿐 아니라 장비 속성(모델명/제조사/냉동능력/압축기·냉각탑 사양/냉각수·브라인·전압 설정 등) **전체**를 같이 내려준다 — 필드가 40개가 넘어서 아래 예시는 일부만 표시했다. 전체 필드 목록·의미는 [Modules/Equipment/README.md](../Modules/Equipment/README.md) "장비 속성" 절이 최신 기준이다(`EquipmentDto`와 1:1 대응).

**응답 예시 (일부 필드만 표시)**
```json
[
  {
    "id": 1, "region": "A지구", "buildingNumber": "A1-1", "buildingName": "PT배기환경시험동", "location": "옥상",
    "name": "인증환경챔버&쇼크룸", "status": "운영", "modelName": null, "manufacturer": null,
    "...(중략, README 참고)...": "...",
    "hasCoolingWater": false, "coolingWaterInletMin": null, "coolingWaterInletMax": null,
    "hasBrine": false, "hasVoltage": false,
    "runningCurrentThreshold": 10, "runningCurrentThresholdDecimalPlaces": 1,
    "isRunning": true, "communicationStatus": "연결됨", "hasAlarm": false,
    "hasEquipmentPhoto": false, "hasInstallationPhoto": false
  }
]
```

- `isRunning`/`communicationStatus`/`hasAlarm`은 관리자가 설정하는 `status`와는 별개로, 소속 압축기 데이터로부터 매 폴링 사이클 자동 집계되는 실시간 파생 상태다. **이 3개를 제외한 나머지 필드는 전부 관리자/담당자가 직접 입력하는 설정값**이다(`runningCurrentThreshold` 포함 — 값 자체는 사람이 입력하고, `isRunning`은 그 값을 근거로 시스템이 계산한 결과라는 점에 유의).
- `runningCurrentThreshold`는 압축기 채널값과 같은 **raw 스케일**이라 그 자체로는 소수점 자리수를 알 수 없다(백엔드는 어떤 수치값도 소수점 처리를 하지 않는다는 원칙 — 5-1번 참고). `runningCurrentThresholdDecimalPlaces`는 이 장비의 1번 압축기(`sequenceNo` 최소) CH07 채널 설정의 `decimalPlaces`를 그대로 가져온 값으로, 프론트가 raw↔실제값 변환에 쓰는 힌트다. 압축기가 하나도 없는 장비면 `null`이다(현재 실제로는 모든 장비가 압축기를 1대 이상 갖고 있어 발생하지 않는다).
- `hasEquipmentPhoto`/`hasInstallationPhoto`는 장비 이력카드용 사진(장비 사진/설치 사진) 등록 여부만 알려주는 가벼운 플래그다. 사진 원본은 여기 실리지 않고 26번(`GET /api/attachments`) API로 따로 받는다.
- 응답은 `buildingName` 오름차순 → `name` 오름차순으로 안정 정렬되어 나간다(호출할 때마다 순서가 바뀌지 않는다). 지역/시설동/설비 선택 드롭다운을 이 목록 하나로 구성할 수 있다.

## 2. `GET /api/equipments/{id}`

장비 단건 조회. 응답 형식은 1번과 동일(`EquipmentDto` 전체 필드).

**오류**: 없는 `id`면 `404`.

## 3. `GET /api/equipments/{id}/compressors`

해당 장비 소속 압축기 목록.

**응답 예시**
```json
[
  { "id": 1, "sequenceNo": 1, "ipAddress": "10.93.78.201", "macAddress": "00:06:AC:E0:0D:5A", "communicationStatus": "연결됨", "hasAlarm": false },
  { "id": 2, "sequenceNo": 2, "ipAddress": "10.93.78.202", "macAddress": "98:06:37:70:00:1B", "communicationStatus": "끊김", "hasAlarm": true }
]
```

`sequenceNo`는 소속 장비 내 압축기 순번(1부터, 화면에 "압축기 1"처럼 표시할 때 사용). 응답은 이 값 기준으로 정렬되어 나간다. `ipAddress`/`macAddress`는 원본 자산 목록에 값이 없는 압축기의 경우 `null`일 수 있다.

**오류**: 없는 장비 `id`면 `404`.

## 4. `GET /api/compressors`

압축기 목록(소속 장비명 조인 포함). 대시보드에서 압축기 테이블을 한 번에 보여줄 때 사용. **장비 상태가 `운영`인 장비의 압축기만** 나온다(2026-09-17).

**응답 예시**
```json
[
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
]
```

응답은 `buildingName` 오름차순 → `equipmentName` 오름차순 → `sequenceNo` 오름차순으로 안정 정렬되어 나간다(호출할 때마다 순서가 바뀌지 않는다).

- `equipmentId`: 소속 장비 id(2026-09-17 추가). 장비와 짝지을 때 `buildingName`+`equipmentName` 문자열 대신 이 값을 쓴다.
- `sequenceNo`: 소속 장비 내 압축기 순번(1부터, 2026-09-17 추가). 3번의 `sequenceNo`와 같다.

## 5. `GET /api/compressors/{id}/channels`

해당 압축기의 CH01~07 현재값 (3초 주기로 갱신되는 최신값, 최대 7개 반환).

**응답 예시**
```json
[
  { "channelNo": "CH01", "value": -123, "measuredAt": "2026-08-26T05:00:00+00:00" },
  { "channelNo": "CH02", "value": 456, "measuredAt": "2026-08-26T05:00:00+00:00" }
]
```

`value`는 **TLC로부터 받은 원시값(raw int16) 그대로**다. 서버는 소수점 변환을 전혀 하지 않으며, 실제 표시값으로 바꾸는 건 프론트 책임이다 (예: 위 `-123`은 실제로는 `-12.3`을 뜻함). 채널별 소수점 자리수(dp)는 아래 5-1번 API로 조회한다.

`measuredAt`은 UTC로 내려간다 (프론트에서 필요시 로컬시각으로 변환).

**오류**: 없는 압축기 `id`면 `404`.

## 5-1. `GET /api/compressors/{id}/channel-settings`

해당 압축기의 CH01~07 채널 설정(경보 상/하한, 표시 소수점 자리수 등). `value`를 실제 표시값으로 바꾸려면 이 API로 받은 `decimalPlaces`만큼 소수점을 적용하면 된다 (예: raw `-123`, `decimalPlaces: 1` → `-12.3`).

**응답 예시**
```json
[
  {
    "channelNo": "CH01", "channelName": "저온", "unit": "℃",
    "enabled": true, "lowerLimit": 0, "upperLimit": 1000,
    "alarmEnabled": true, "alarmDelaySeconds": 30, "alarmClearDelaySeconds": 30,
    "decimalPlaces": 1
  }
]
```

- `lowerLimit`/`upperLimit`도 채널값과 같은 **raw 스케일**이다.
- 채널 설정은 자주 바뀌지 않으니, 매번 새로 조회하기보다 프론트에서 적당히 캐싱해도 된다.

**오류**: 없는 압축기 `id`면 `404`.

## 6. `GET /api/compressors/{id}/trend?date=yyyy-MM-dd`

해당 압축기의 하루치 트렌드(1분 단위, 최대 1,440개). 그래프 그릴 때 사용.

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `date` | 아니오 | 조회할 날짜(한국 시간 기준). 생략 시 오늘 |

**응답 예시**
```json
[
  {
    "measuredAt": "2026-08-25T15:00:00+00:00",
    "ch01": -123, "ch02": 456, "ch03": 301, "ch04": 52, "ch05": 87, "ch06": 34, "ch07": 125,
    "isRunning": true, "hasAlarm": false, "isConnected": true
  }
]
```

`ch01`~`ch07`도 `/channels`와 마찬가지로 **원시값(raw int16)**이다. 소수점 변환은 프론트가 담당하며, 자리수는 `channel-settings`(5-1번) 응답의 `decimalPlaces`를 쓴다.

`isRunning`/`hasAlarm`/`isConnected`는 **압축기 자신이 아니라 그 압축기가 소속된 장비의 집계 상태**이며 셋 다 boolean이다. 같은 장비에 압축기가 여러 대면 그 압축기들의 이 세 값은 전부 동일하다. `hasAlarm`/`isConnected`는 세부 단계(경보발생대기/정상복귀대기, 끊김/재접속중 등) 없이 "장비에 경보가 있는지"/"장비가 연결되어 있는지"만 나타낸다.

**통신 장애 구간 구분 방법**: 통신이 끊기면 채널값이 그 자리에서 멈춘 값으로 계속 반복된다. 그래프 선이 평평한 구간을 발견하면 그 시점들의 `isConnected`를 같이 확인해서, 실제로 값이 안정된 것인지(`true`) 통신 장애로 값이 멈춘 것인지(`false`)를 구분해서 표시할 수 있다(예: 회색 음영 처리).

- **끊김 구간의 값은 `null`이 아니다.** 직전 성공값이 그대로 반복되므로, 결측을 `null` 기준으로 판단하는 처리는 동작하지 않는다 — 반드시 `isConnected`를 봐야 한다. 채널값이 `null`인 경우는 그 압축기가 한 번도 통신에 성공한 적 없을 때뿐이다.
- **하루가 시작되는데 여전히 끊긴 상태면 전 채널이 `0`으로 기록된다**(사양 확정 2026-09-16). 전날 값을 다음 날까지 끌고 가지 않기 위한 규칙이다. 따라서 `isConnected: false`이면서 값이 전부 `0`인 구간은 "전날부터 끊긴 채 날이 바뀐 상태"이고, `isConnected: false`인데 값이 0이 아닌 구간은 "오늘 중간에 끊겨서 직전 값이 유지되는 상태"다.

**오류**: 없는 압축기 `id`면 `404`.

## 7. `GET /api/equipments/{id}/utilization?from=yyyy-MM-dd&to=yyyy-MM-dd`

지정 기간의 장비 가동률(%) — 그 기간 중 장비가 "운전" 상태였던 시간의 비율.

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `from` | 아니오 | 시작 날짜(한국 시간, 포함). 생략 시 오늘 |
| `to` | 아니오 | 종료 날짜(한국 시간, 포함). 생략 시 `from`과 동일한 하루 |

**응답 예시**
```json
{
  "equipmentId": 1,
  "from": "2026-08-01",
  "to": "2026-08-31",
  "totalMinutes": 44640,
  "runningMinutes": 38977,
  "utilizationPercent": 87.3
}
```

- `totalMinutes`는 "요청한 기간 전체 분"이 아니라 **실제로 트렌드 기록이 존재하는 분**이다. 서버 다운타임 등 기록 자체가 없는 구간은 분모에서 빠진다. 이 값이 기대보다 작다면 그 기간에 데이터가 비어있는 구간이 있었다는 뜻이다.
- 해당 기간에 기록이 전혀 없으면 `totalMinutes: 0`, `utilizationPercent: null`이 반환된다(에러 아님).
- 압축기가 하나도 없는 장비도 위와 동일하게 `null`로 반환된다.

**오류**: 없는 장비 `id`면 `404`.

## 8. `GET /api/summary`

실시간 현황 화면 상단 카운트용 집계. **장비 상태가 `운영`인 장비와 그 압축기만** 센다(2026-09-17 변경 — 그 전에는 전체 기준).

**응답 예시**
```json
{
  "totalEquipmentCount": 105,
  "totalCompressorCount": 244,
  "runningEquipmentCount": 97,
  "communicationFailedCompressorCount": 3
}
```

- `runningEquipmentCount`는 장비 단위 운전 여부(`isRunning`) 기준이다. **압축기 단위 운전 중 수량은 제공하지 않는다** — 운전 판정 자체가 장비 단위로만 존재한다.
- `communicationFailedCompressorCount`는 압축기의 `communicationStatus`가 `연결됨`이 아닌(끊김 또는 재접속중) 압축기 수다.

## 9. `GET /api/events?since=&take=`

이벤트 로그(로그인/로그아웃, 경보 발생·해제, 통신 장애 등) 조회. 실시간 현황 화면의 이벤트 피드용.

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `since` | 아니오 | 이 시각(ISO 8601, UTC) 이후의 이벤트만 조회. 생략 시 최신 이벤트부터 조회 |
| `take` | 아니오 | 최대 반환 개수. 생략 시 100, 최대 500 |

**응답 예시**
```json
[
  {
    "id": 15689,
    "category": "Alarm",
    "message": "C지구 환경차개발시험3동의 환경챔버2 쇼크룸의 압축기 1번 오일온도값이 범위를 벗어났습니다.",
    "username": null,
    "equipmentId": 101,
    "compressorId": 232,
    "channelNo": "CH03",
    "value": 1178,
    "lowerLimit": 0,
    "upperLimit": 1000,
    "decimalPlaces": 2,
    "unit": "MPa",
    "createdAt": "2026-08-31T07:15:47.876368+00:00"
  }
]
```

- `category`는 `UserAccess`/`EmergencyStop`/`Communication`/`Alarm`/`System`/`Approval` 중 하나. (아직 `EmergencyStop`은 실제로 기록되지 않음)
- `equipmentId`/`compressorId`/`channelNo`는 해당 없으면 `null`(예: 로그인 이벤트).
- **`value`/`lowerLimit`/`upperLimit`/`decimalPlaces`/`unit`은 경보(`Alarm`) 이벤트에서만 채워지는 상세 스냅샷**이고 다른 카테고리는 전부 `null`이다(2026-09-16 추가). 자료 조회 화면에서 이벤트를 클릭해 상세 팝업을 띄울 때 추가 호출 없이 바로 쓸 수 있다.
  - `value`는 경보가 확정된 순간의 **raw 측정값**, `lowerLimit`/`upperLimit`은 **그 시점 채널 설정의 정상 범위**(역시 raw)다. 채널 설정이 나중에 바뀌어도 과거 이력이 왜곡되지 않도록 단위·소수점까지 그때 값으로 박아둔다. 표시값은 `decimalPlaces`만큼 소수점을 적용해서 만든다(예: `value: 1178`, `decimalPlaces: 2`, `unit: "MPa"` → `11.78 MPa`).
  - 2026-09-16에 **`EventLogs` 테이블을 전부 비웠다**(사용자 결정, 120,256건 삭제 + id 리셋). 그 이전 이벤트는 조회되지 않으며, 지금 쌓이는 경보 이벤트는 전부 이 5개 필드가 채워져 있다.
- **같은 경보가 반복 기록되던 버그를 같은 날 수정했다.** 해제 지연을 기다리는 중 값이 다시 범위를 벗어나면 "새 경보 발생"으로 또 기록되어, 해제된 적 없는 경보가 수십 초 간격으로 수천 건 쌓였다(장비 1대 하루 1,557건 / 해제 0건). 이제 **발생 1건 ↔ 해제 1건**으로만 기록되므로, 이벤트 목록을 그대로 나열해도 읽을 수 있다.
- **정렬 방향이 `since` 여부에 따라 다르다**: `since` 없이 호출(최초 조회)하면 **최신순**으로 잘라서 반환하고, `since`를 주면(이어서 폴링) **오래된 순**으로 반환한다 — 폴링 사이에 이벤트가 몰려서 `take` 개수를 넘기더라도, 최신순으로 자르면 오래된 이벤트가 영영 안 보일 수 있어서다. 프론트는 매번 응답의 마지막 항목(또는 첫 항목, 방향에 따라)의 `createdAt`을 다음 호출의 `since`로 넘기면 된다.

---

## 10. 결재 시스템

점검일지를 비롯해 앞으로 추가될 문서(운전일지/교육훈련/수리보수일지 등)가 공통으로 쓰는 결재 규칙이다. 문서마다 결재 API 경로는 다르지만(예: 점검일지는 `/api/inspection-logs/{id}/approve`) 아래 규칙은 전부 동일하다.

**기본 구조**
- 결재 대상자는 최대 3명, 항상 **안전관리원 → 안전관리책임자 → 안전관리총괄자** 순서로 고정이다.
- 문서유형에 따라 특정 레벨이 원래 결재 대상이 아니거나(`NotApplicable`), 그 문서유형은 그 레벨을 항상 전결 처리하기로 정해져 있을 수 있다(`Delegated`). 이 둘은 시스템 사양으로 **문서유형별로 고정**되어 있고(예: "이 문서는 총괄자가 항상 전결"), 사용자가 결재할 때 선택하는 옵션이 아니다. 각 결재 레벨의 `status`는 다음 4가지 중 하나다:
  - `Pending` — 아직 결재 안 됨 (승인 가능)
  - `Approved` — 승인 완료 (`approverName`/`approvedAt` 있음)
  - `NotApplicable` — 이 문서유형엔 이 결재단계 자체가 없음 → 화면에 `/` 표시
  - `Delegated` — 이 문서유형은 이 레벨을 항상 전결 처리하기로 고정됨 → 화면에 `//전결` 표시
  - `NotApplicable`/`Delegated`는 실제 승인 절차가 없다는 점에서 동작이 같다(`approverName`/`approvedAt`는 항상 `null`). 화면 표시 문구만 다르다.
  - 현재 점검일지는 3단계 전부 `Required`다(전결/해당없음 케이스 없음). 다른 문서유형에서 이 값이 다르게 나올 수 있다.

**승인 규칙**
- 승인 API는 "누구를 승인시킬지"를 받지 않는다 — **호출한 사용자 자신**의 역할과 소속 장비로만 판정한다. 로그인한 사용자의 역할이 안전관리원/책임자/총괄자 중 하나이고, 그 문서의 장비에 담당자로 등록되어 있으면 자신의 역할에 해당하는 칸을 승인할 수 있다.
- **순서를 반드시 지켜야 한다** — 하위 단계가 완료(`Approved` 또는 `NotApplicable`/`Delegated`)되기 전에는 상위 단계를 승인할 수 없다(`409 Conflict`).
- 반려 개념은 없다. 승인 아니면 대기(`Pending`)뿐이다.
- 결재가 하나라도 진행된 문서는 수정할 수 없다(`409 Conflict`). 단, 자동으로 채워지는 항목(점검일지의 미기록 요일 자동 이어채우기 — 12번 항목 참고)은 이 잠금과 무관하게 시스템이 직접 기록한다.

**취소 규칙**
- 자기 자신이 승인한 단계만 취소할 수 있다.
- **상위 단계가 아직 승인되지 않았을 때만** 취소 가능하다(상위 단계가 이미 승인됐으면 `409 Conflict`).

**시스템관리자(admin)**
- 시스템관리자는 결재를 직접 할 수 없다(안전관리원/책임자/총괄자 역할이 아니므로 `403`).
- 대신 특정 문서의 결재를 **전부 무효화(리셋)**할 수 있다 — 진행 단계와 상관없이 Level1~3을 전부 초기화해서, 관련자들에게 재결재를 요구하는 용도다.

---

## 11. `GET /api/inspection-items`

점검항목 고정 목록(법정 자체검사 체크리스트, 항상 10개). 장비/주차와 무관하게 항상 동일하다.

**응답 예시**
```json
[
  { "itemNo": "1", "category": "누출방지", "content": "방진, 방호, 부식방지조치 여부" },
  { "itemNo": "4-1", "category": "자동제어장치", "content": "HPC, LPC, OPC 작동 여부" }
]
```

## 12. `GET /api/inspection-logs?equipmentId=&weekStart=`

특정 장비의 특정 주차(일요일~토요일) 점검일지 조회.

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `equipmentId` | 예 | 장비 ID |
| `weekStart` | 예 | 그 주의 **일요일** 날짜(`yyyy-MM-dd`). 일요일이 아니면 `400` |

**응답 예시 (저장된 적 있는 주차)**
```json
{
  "id": 1,
  "equipmentId": 1,
  "weekStartDate": "2026-08-30",
  "opinion": "특이사항 없음",
  "level1": { "status": "Approved", "approverName": "홍길동", "approvedAt": "2026-08-31T05:10:10+00:00" },
  "level2": { "status": "Pending", "approverName": null, "approvedAt": null },
  "level3": { "status": "Pending", "approverName": null, "approvedAt": null },
  "results": [
    { "itemNo": "1", "category": "누출방지", "content": "방진, 방호, 부식방지조치 여부",
      "sun": "O", "mon": "O", "tue": "O", "wed": "O", "thu": "O", "fri": "O", "sat": "O", "memo": "정상" },
    { "itemNo": "4-2", "category": "자동제어장치", "content": "과부하 보호장치, 액체동결 방지장치, 냉각수 단수 보호장치 작동여부",
      "sun": null, "mon": null, "tue": null, "wed": null, "thu": null, "fri": null, "sat": null, "memo": null }
  ]
}
```

- `results`는 항상 점검항목 10개 전부를 포함한다(11번 API와 같은 목록). 아직 기록 안 한 항목/요일은 값이 `null`이다.
- **저장된 적 없는 주차를 조회하면 `404`가 아니라 `200`으로 빈 폼을 반환한다** — `id`가 `null`이고 `results`의 모든 값이 `null`, `level1`~`level3`은 전부 `Pending`인 상태. 프론트는 이 응답으로 "새로 작성" 화면을 그대로 그리면 된다.
- **매일 한국시간 00:00에 서버가 그날 칸을 자동으로 채운다** — 특정 항목의 요일 값을 사용자가 기록하지 않으면, 그 전날 값을 그대로 이어서 채운다. **주가 바뀌어도 계속 이어진다** — 일요일이 되면 지난주 토요일 값이 있는 항목은 이번 주 일요일 칸으로 자동 이어받는다(그 항목의 이번 주 로그가 아직 없으면 새로 만들어진다). 예를 들어 어느 일요일에 "X"(고장)로 기록하고 그 뒤로 아무도 손대지 않으면, 몇 주가 지나도 수리돼서 값이 바뀌기 전까지 계속 "X"로 유지된다. 그래서 오늘 날짜가 지나면 어제까지 비어있던 칸이나 아예 없던 새 주차의 `GET`(12번) 응답이 프론트가 아무것도 안 해도 채워져 있을 수 있다 — 화면을 새로고침하면 자동으로 반영된다. 사용자가 특정 요일에 값을 직접 입력하면(13번 API) 그 날짜부터는 그 값을 기준으로 이어진다.
- **이 자동 채움은 "이미 사용자가 입력한 값"만 이어간다 — 시스템이 초기값을 임의로 만들어 넣는 일은 절대 없다.** 담당 장비의 특정 항목을 한 번도 기록한 적이 없으면 그 항목은 계속 `null`이고, 자동 채움도 그 항목엔 손대지 않는다(이어받을 값 자체가 없어서). 따라서 **각 장비 담당자는 담당 장비에 대한 점검일지를 최초 1회는 반드시 직접 작성해야 한다** — 그래야 그 뒤로 자동 이어채우기가 동작한다. 프론트는 `results` 항목이 전부 `null`인 상태(=한 번도 기록 안 된 상태)를 발견하면 "최초 점검 필요" 같은 안내를 보여주는 걸 권장한다.

**오류**: 없는 장비 `id`면 `404`. `weekStart`가 일요일이 아니면 `400`.

## 13. `PUT /api/inspection-logs`

점검일지 저장(신규 작성/수정 겸용). `equipmentId`+`weekStartDate` 조합으로 upsert된다.

**요청**
```json
{
  "equipmentId": 1,
  "weekStartDate": "2026-08-30",
  "opinion": "특이사항 없음",
  "results": [
    { "itemNo": "1", "sun": "O", "mon": "O", "tue": "O", "wed": "O", "thu": "O", "fri": "O", "sat": "O", "memo": "정상" },
    { "itemNo": "4-2", "sun": "X", "mon": null, "tue": null, "wed": null, "thu": null, "fri": null, "sat": null, "memo": "확인필요" }
  ]
}
```

- `results`에 없는 항목은 그 항목 전체가 미기록(`null`) 상태로 저장된다 — **부분 수정이 아니라 매번 전체를 통째로 교체**한다. 프론트는 저장할 때 폼 전체(10개 항목)를 항상 같이 보내야 한다.
- 요일별 값은 `"O"`(정상) / `"/"`(미해당) / `"X"`(이상) 또는 `null`만 허용된다. 그 외 값이면 `400`.
- 응답 형식은 12번 조회 API와 동일하다.

**오류**: 없는 장비 `equipmentId`면 `404`. `weekStartDate`가 일요일이 아니거나 값/항목번호가 잘못되면 `400`. **결재가 하나라도 진행된 문서는 `409`** — 이 경우 시스템관리자의 결재 리셋(15번)을 거쳐야 다시 수정할 수 있다.

## 14. `POST /api/inspection-logs/{id}/approve`

로그인한 사용자 본인의 결재 처리. 앞의 "결재 시스템"(10번) 규칙을 그대로 따른다 — 어떤 레벨을 승인할지는 호출자의 역할로 자동 결정되고, body는 없다.

**응답**: 12번과 동일한 형식의 `InspectionLogDto` (해당 레벨이 `Approved`로 갱신됨)

**오류**
- 로그인 사용자가 안전관리원/책임자/총괄자가 아니거나, 그 장비 담당자로 등록되어 있지 않으면 `403`
- 순서가 안 맞거나(하위 단계 미완료) 이미 승인된 상태면 `409`
- 없는 `id`면 `404`

## 14-1. `POST /api/inspection-logs/{id}/approve/cancel`

본인이 승인한 단계 취소. body 없음.

**오류**: 본인이 승인한 단계가 아니면 `403`. 상위 단계가 이미 승인되어 있으면 `409`. 없는 `id`면 `404`.

## 15. `POST /api/inspection-logs/{id}/approvals/reset`

시스템관리자 전용. 그 문서의 결재(Level1~3)를 진행 단계와 상관없이 전부 무효화한다. body 없음.

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

---

## 16. 운전일지 개요

장비별로 하루 4개 시각(09:00/13:00/16:00/21:00, 전 장비 공통 고정값)마다 항목값을 기록하는 문서다. 결재 3단계는 점검일지와 동일하지만(10번 항목 참고), **결재가 진행 중이어도 저장(`PUT`)이 막히지 않는다** — 점검일지와의 유일한 차이점이다. 결재 완료 후 수정을 막을지는 프론트가 UI에서 직접 처리한다.

항목은 세 갈래로 자동화 방식이 다르고, 판정은 아래 순서대로 적용된다.

**우선순위 규칙**
1. **장비가 운영 중이 아니면(장비 상태가 미운영/철거/사용중지이거나 통신 상태가 연결됨이 아님) 그 장비의 모든 항목이 무조건 `/`** — 아래 2~4번보다 우선한다. 사용자 직접입력 항목의 "마지막 입력 이어받기"도 이 규칙 앞에서는 무시되고 `/`로 강제된다.
2. **장비가 운전 중이 아니면(`GET /api/equipments`의 `isRunning`이 `false`), 채널 자동측정/장비설정 랜덤값 항목만 `/`.** 사용자 직접입력 항목은 운전 여부와 무관하다.
3. 위 1~2번에 해당하지 않으면 항목 종류별로 아래를 따른다.

**항목 종류**
- **채널 자동측정 5개**(`토출압력`/`토출가스온도`/`흡입압력`/`오일압력`/`운전전류`): 조건을 통과하면 그 시각의 압축기 채널값으로 **항상 덮어쓴다** — 사용자가 미리 입력해놨어도 무시된다. 통신 불가/읽기 실패 시 `/`. 앞의 4개는 압축기 수만큼 항목이 반복되고(`compressorId` 있음), 운전전류는 장비당 1개다(`compressorId: null`, 그 장비의 1번 압축기 값을 쓴다).
- **장비설정 기반 랜덤값 5개**(`냉각수온도(입구)`/`냉각수온도(출구)`/`브라인온도(입구)`/`브라인온도(출구)`/`운전전압`): 채널을 읽지 않고, 장비 속성(`Modules/Equipment/README.md`의 냉각수/브라인/전압 유무·min·max)을 기준으로 값을 만든다. 그 장비가 해당 항목을 "사용 안 함"이거나 min/max 중 하나라도 설정 안 됐으면 `/`. "사용함"이고 min/max가 있으면 그 사이의 랜덤값을 **소수점 1자리로 반올림**해서 기입한다(예: `100`→`100.0`, `12.345`→`12.3`. 단순 반올림이며 raw 스케일 변환이 아니다. `min=max=0`처럼 둘 다 `0`이어도 유효한 값으로 보고 `0.0`을 기입한다). 전부 장비당 1개다(`compressorId: null`).
- **사용자 직접입력 6개**(`냉매량`/`오일량`/`단자대&판넬상태`/`드레인상태`/`저압부단열재상태`/`이상진동및소음상태`): 빈 칸일 때만 직전 값을 이어받는다(이미 있는 값은 절대 안 덮어씀). 이 이어받기는 하루 안(9→13→16→21)은 물론 **날짜 경계도 넘어 무기한 이어진다** — 한 번 기록하면 사용자가 다시 수정하기 전까지 계속 유지된다(단, 위 1번 규칙에 해당하면 예외).

항목의 표시 이름/구분/순서 같은 "레포트 형식"은 **백엔드가 관리하지 않는다** — `itemKey`는 프론트가 정한 키를 그대로 저장할 뿐이다. 단, 위 채널 자동측정 5개 + 장비설정 랜덤값 5개, 총 10개 항목의 `itemKey` 문자열은 백엔드 자동화 로직이 알고 있어야 하므로 프론트와 정확히 일치해야 한다: `토출압력`, `토출가스온도`, `흡입압력`, `오일압력`, `운전전류`, `냉각수온도(입구)`, `냉각수온도(출구)`, `브라인온도(입구)`, `브라인온도(출구)`, `운전전압`.

**운전일지는 절대 누락되지 않는다** — 장비를 등록한 순간부터 매일 자동으로 로그가 생성된다(점검일지의 "사용자가 최초 1회 작성해야 한다" 정책과 반대).

## 17. `GET /api/operation-logs?equipmentId=&date=`

특정 장비의 특정 날짜 운전일지 조회.

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `equipmentId` | 예 | 장비 ID |
| `date` | 예 | 날짜(`yyyy-MM-dd`) |

**응답 예시**
```json
{
  "id": 40,
  "equipmentId": 1,
  "date": "2026-11-05",
  "level1": { "status": "Pending", "approverName": null, "approvedAt": null },
  "level2": { "status": "Pending", "approverName": null, "approvedAt": null },
  "level3": { "status": "Pending", "approverName": null, "approvedAt": null },
  "items": [
    { "itemKey": "토출압력", "compressorId": 1, "time0900": "-114", "time1300": null, "time1600": null, "time2100": null },
    { "itemKey": "냉각수온도(입구)", "compressorId": null, "time0900": "-106", "time1300": null, "time1600": null, "time2100": null },
    { "itemKey": "냉매량", "compressorId": null, "time0900": "O", "time1300": "O", "time1600": null, "time2100": null }
  ],
  "references": [
    { "itemKey": "냉매량", "referenceText": "액면계에서 액면이 보일 것" }
  ]
}
```

- 채널 자동측정 값(예: `토출압력`)은 **TLC 원시값(raw int16)을 문자열로 담은 것**이다 — 압축기 채널값과 동일하게 소수점 변환은 프론트가 담당한다.
- **저장된 적 없는 날짜를 조회하면 `404`가 아니라 `200`으로 빈 폼을 반환한다** — `id`가 `null`이고 `items`/`references`가 빈 배열인 상태. 정상 동작 중이면 자동 기록 서비스가 매일 생성하므로, 과거/오늘 날짜에 빈 폼이 나오는 건 그 장비가 아직 시스템에 등록 안 됐거나 아직 자동 기록이 한 번도 안 돈 경우뿐이다.

**오류**: 없는 장비 `id`면 `404`.

## 18. `PUT /api/operation-logs`

운전일지 저장(신규 작성/수정 겸용). `equipmentId`+`date` 조합으로 upsert된다. **결재 진행 여부와 무관하게 항상 저장된다**(점검일지와 다른 점).

**요청**
```json
{
  "equipmentId": 1,
  "date": "2026-11-05",
  "items": [
    { "itemKey": "냉매량", "compressorId": null, "time0900": "O", "time1300": null, "time1600": null, "time2100": null }
  ],
  "references": [
    { "itemKey": "냉매량", "referenceText": "액면계에서 액면이 보일 것" }
  ]
}
```

- `items`/`references`에 없는 항목은 저장에서 빠진다 — **부분 수정이 아니라 매번 전체를 통째로 교체**한다. 프론트는 저장할 때 조회 응답에 있던 항목들을 그대로 같이 보내야 한다(그렇지 않으면 사라진다).
- 값 형식은 검증하지 않는다(O/X/`/`든 숫자든 백엔드는 그대로 저장만 한다). 단, 채널 자동측정 5개 + 장비설정 랜덤값 5개(16번 항목 참고) 항목은 다음 트리거 시각(09/13/16/21시)이 되면 프론트가 저장한 값과 무관하게 다시 덮어써진다.
- 응답 형식은 17번 조회 API와 동일하다.

**오류**: 없는 장비 `equipmentId`면 `404`.

## 19. `POST /api/operation-logs/{id}/approve`

로그인한 사용자 본인의 결재 처리. 10번 "결재 시스템" 규칙을 그대로 따른다.

**오류**: 안전관리원/책임자/총괄자가 아니거나 담당 장비가 아니면 `403`. 순서가 안 맞거나 이미 승인됐으면 `409`. 없는 `id`면 `404`.

## 19-1. `POST /api/operation-logs/{id}/approve/cancel`

본인이 승인한 단계 취소.

**오류**: 본인이 승인한 단계가 아니면 `403`. 상위 단계가 이미 승인되어 있으면 `409`. 없는 `id`면 `404`.

## 20. `POST /api/operation-logs/{id}/approvals/reset`

시스템관리자 전용. 결재를 진행 단계와 상관없이 전부 무효화한다.

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

---

## 21. 장비관리 개요 (등록/수정)

장비·압축기·채널 설정을 등록/수정하는 API다. **접근 권한이 다른 API와 다르다**:

- **시스템관리자**: 전체 장비를 관리(등록/수정) 가능.
- **그 외 역할**: `UserEquipment`에 자신이 담당자로 등록된 장비만 관리 가능. 담당 아닌 장비를 수정하려 하면 `403`.
- 이 제약은 **장비관리 API에만 적용**된다 — 점검일지/운전일지 저장 API(`PUT /api/inspection-logs`, `PUT /api/operation-logs`)는 그대로 로그인한 사용자 누구나 저장 가능하다(레포트 쪽 접근 제어는 사양 미확정으로 보류).

**"삭제" 개념이 없다.** 장비를 없애려면 `PUT /api/equipments/{id}`로 `status`를 `"철거"`로 바꾼다 — 기존 이력 데이터(트렌드, 점검일지, 운전일지 등)는 전부 그대로 남는다. 압축기는 삭제/추가 API 자체가 없다 — **장비 등록(22번) 시점에만 압축기를 같이 생성할 수 있고, 그 이후로는 개수가 영구히 고정된다.**

## 22. `POST /api/equipments`

장비 + 압축기를 함께 등록한다. **시스템관리자 전용.**

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `equipment` | 예 | 장비 속성(아래 23번 `PUT` 요청과 동일한 필드 구성) |
| `compressors` | 예 | 압축기 목록(`ipAddress`, `macAddress`). 최소 1개 이상 |

**요청 예시**
```json
{
  "equipment": {
    "region": "A지구", "buildingNumber": "A1-1", "buildingName": "장비 내구동", "location": "옥상",
    "name": "신규 챔버", "status": "운영",
    "...(그 외 필드는 23번 PUT 참고, 필요 없으면 null)...": null,
    "runningCurrentThreshold": 10
  },
  "compressors": [
    { "ipAddress": "10.90.1.1", "macAddress": "98:06:37:70:00:01" },
    { "ipAddress": "10.90.1.2", "macAddress": "98:06:37:70:00:02" }
  ]
}
```

- `compressors` 배열 순서대로 `sequenceNo`가 1부터 자동 부여된다.
- 압축기마다 CH01~07 채널 설정 7행이 기본값(활성화, 경보사용, 상하한 미설정, 소수점 자리수는 단위별 기본값 — MPa 2자리, ℃/V/A 1자리)으로 자동 생성된다 — 생성 후 21번 규칙에 따라 담당자가 24번 API로 값을 채우면 된다.
- 응답은 1번(`GET /api/equipments`)과 같은 형식의 `EquipmentDto` 하나. `runningCurrentThresholdDecimalPlaces`는 방금 생성된 압축기(1번, 즉 `sequenceNo`가 가장 작은 압축기) 기준으로 서버가 계산해서 내려준다 — 요청 본문에는 이 필드가 없다(응답 전용). `hasEquipmentPhoto`/`hasInstallationPhoto`도 마찬가지로 응답 전용이며, 신규 장비는 아직 사진이 없으니 둘 다 `false`로 내려간다.

**오류**: `status`가 올바른 값이 아니면 `400`. `compressors`가 비어있으면 `400`. `(buildingName, name)` 조합이 이미 있으면 `409`. 시스템관리자가 아니면 `403`.

## 23. `PUT /api/equipments/{id}`

장비 속성 수정(삭제 대신 `status`를 `"철거"`로 변경하는 것도 이 API). 압축기 목록은 이 API로 바뀌지 않는다.

요청 본문은 1번 응답(`EquipmentDto`)에서 `id`/`isRunning`/`communicationStatus`/`hasAlarm`/`runningCurrentThresholdDecimalPlaces`/`hasEquipmentPhoto`/`hasInstallationPhoto`(전부 자동 계산값·응답 전용)를 뺀 나머지 전체다. 필드 목록은 [Modules/Equipment/README.md](../Modules/Equipment/README.md) 참고. 사진 자체를 올리거나 바꾸려면 이 API가 아니라 26번(`POST /api/attachments`)을 쓴다.

**오류**: 담당 장비가 아니면(시스템관리자 제외) `403`. 없는 `id`면 `404`. `status`가 올바른 값이 아니면 `400`. `(buildingName, name)` 조합이 다른 장비와 겹치면 `409`.

## 24. `PUT /api/compressors/{id}`

압축기의 IP/MAC/순번(`sequenceNo`) 수정. 압축기 자체를 추가하거나 제거하는 API는 없다.

**요청**
```json
{ "ipAddress": "10.90.1.1", "macAddress": "98:06:37:70:00:01", "sequenceNo": 1 }
```

**오류**: 그 압축기가 속한 장비의 담당자가 아니면(시스템관리자 제외) `403`. 없는 `id`면 `404`.

## 25. `PUT /api/compressors/{id}/channel-settings/{channelNo}`

채널 하나의 설정 수정(경보 상/하한, 지연시간, on/off, 채널명/단위, 표시 소수점 자리수). 응답 형식은 5-1번(`GET .../channel-settings`)의 원소 하나와 동일.

**요청**
```json
{
  "channelName": "저온", "unit": "℃", "enabled": true,
  "lowerLimit": 0, "upperLimit": 1000,
  "alarmEnabled": true, "alarmDelaySeconds": 30, "alarmClearDelaySeconds": 30,
  "decimalPlaces": 1
}
```

**오류**: 그 압축기가 속한 장비의 담당자가 아니면(시스템관리자 제외) `403`. 없는 압축기 `id`면 `404`. `channelNo`가 `CH01`~`CH07`이 아니면 `400`.

---

## 첨부파일 (Attachment) — 26~29번

여러 도메인에서 공용으로 쓰는 첨부파일 API다. `ownerType`+`ownerId`로 "무엇에 딸린 파일인지"를 가리킨다. **현재 연동된 `ownerType`은 `EquipmentPhoto`, `EquipmentInspectionHistory`, `TrainingLog`, `Notice` 네 개다** — 수리일지(35~42번)는 사양상 첨부파일을 지원하지 않는다.

| | `EquipmentPhoto` | `EquipmentInspectionHistory` | `TrainingLog` | `Notice` |
|---|---|---|---|---|
| 용도 | 장비 이력카드 사진 | 장비 검사이력(30~34번) | 교육훈련 일지(43~50번) | 공지사항(51~57번) |
| `slot` | 필수(`equipment`/`installation`), 슬롯당 1장 — 재업로드 시 덮어쓰기 | 안 씀(다건) | 안 씀(다건) | 안 씀(다건) |
| 업로드·삭제 권한 | 시스템관리자 또는 **그 장비의 담당자**(`UserEquipment`) | **그 문서의 작성자** 또는 시스템관리자 | **그 문서의 작성자** 또는 시스템관리자 — 단 결재가 시작되면 누구도 불가(`409`) | **그 문서의 작성자** 또는 시스템관리자 |
| 확장자 제한 | `jpg`/`jpeg`/`png`만 | 없음 | 없음 | 없음 |
| 용량 제한 | 파일당 10MB | 파일당 10MB | 파일당 10MB | 파일당 10MB |

- **문서형 첨부의 권한은 "그 문서를 수정할 수 있는 사람만 첨부도 바꿀 수 있다"로 통일되어 있다**(2026-09-16 사양 확정). 그 전에는 문서형 첨부를 로그인한 누구나 올리고 지울 수 있었는데, 문서 수정 권한과 어긋나 남의 문서에 파일을 붙일 수 있는 구멍이었다. `EquipmentInspectionHistory`/`TrainingLog`도 이때 함께 조정되었으니, **기존에 이 두 타입으로 업로드하던 화면이 있으면 작성자/관리자 기준을 확인**해야 한다.
- 조회(26·27번)는 어느 `ownerType`이든 로그인만 요구한다.
- `ownerId`는 `EquipmentPhoto`는 장비 `id`, 나머지는 해당 문서 레코드의 `id`(등록 응답의 `id`)다. 존재하지 않는 문서 `ownerId`로 업로드하면 `404`다.
- **`AppointmentReport`(선해임 신고서)** 는 위 표와 별도 규칙이다 — `ownerId`는 **사용자 `id`**, 업로드·삭제는 **시스템관리자만**(`403`), 사용자당 1건이라 서버가 `slot`을 `report`로 고정해서 **다시 올리면 교체**된다(첨부 `id` 유지), 확장자 제한 없음, 파일당 10MB. 없는 사용자(또는 시스템관리자 계정)면 `404`. 사용자 조회 응답의 `appointmentReportId`로 존재 여부와 다운로드 `id`를 바로 알 수 있다(59~69번).

## 26. `GET /api/attachments`

특정 리소스에 달린 첨부파일 메타데이터 목록(파일 내용은 안 실림).

| 쿼리 파라미터 | 필수 | 설명 |
|---|---|---|
| `ownerType` | 예 | 예: `EquipmentPhoto` |
| `ownerId` | 예 | 예: 장비 `id` |

**요청 예시**: `GET /api/attachments?ownerType=EquipmentPhoto&ownerId=41`

**응답 예시**
```json
[
  {
    "id": 12, "ownerType": "EquipmentPhoto", "ownerId": 41, "slot": "equipment",
    "fileName": "chamber.jpg", "contentType": "image/jpeg", "sizeBytes": 284213,
    "uploadedByUserName": "홍길동1", "uploadedAt": "2026-09-14T02:10:00+00:00"
  }
]
```

## 27. `GET /api/attachments/{id}`

첨부파일 바이너리 그대로 응답(`Content-Type`이 업로드 당시 파일 타입, `Content-Disposition: attachment`로 원본 파일명 포함). `<img src="...">`처럼 직접 박아서 쓸 수 없다 — 이 API도 다른 API와 마찬가지로 `Authorization` 헤더가 필요해서, `<img>` 태그가 자동으로 실어주는 헤더로는 인증이 안 된다. 프론트에서 `fetch`(또는 `apiFetch`)로 받은 뒤 `URL.createObjectURL()`로 변환해서 `<img>`에 넣는 방식을 쓴다.

**오류**: 없는 `id`거나 파일이 유실됐으면 `404`.

## 28. `POST /api/attachments`

파일 업로드(`multipart/form-data`, 파트 이름 `file`). 같은 `ownerType`+`ownerId`+`slot` 조합이 이미 있으면 기존 파일을 덮어쓴다(첨부 `id` 유지).

| 쿼리 파라미터 | 필수 | 설명 |
|---|---|---|
| `ownerType` | 예 | `EquipmentPhoto` / `EquipmentInspectionHistory` / `TrainingLog` / `Notice` |
| `ownerId` | 예 | `EquipmentPhoto`는 장비 `id`, 나머지는 해당 문서 `id` |
| `slot` | `EquipmentPhoto`만 필수 | `equipment` 또는 `installation`. 다른 `ownerType`은 안 보내도 됨(보내도 무시) |

**요청 예시(장비 사진)**: `POST /api/attachments?ownerType=EquipmentPhoto&ownerId=41&slot=equipment` (본문: `file` 파트에 이미지)

**요청 예시(검사이력 첨부, 여러 개)**: `POST /api/attachments?ownerType=EquipmentInspectionHistory&ownerId=7` 를 파일 개수만큼 반복 호출(한 번에 여러 파일을 받는 API는 아직 없음 — 호출할 때마다 새 첨부가 추가됨)

**응답**: 26번과 같은 형식의 첨부파일 메타데이터 하나(`200`).

**오류**: 파일이 비었거나 10MB를 넘으면 `400`. `ownerType`이 지원 목록에 없으면 `400`.
- `EquipmentPhoto`: 담당 장비가 아니면(시스템관리자 제외) `403`, 없는 장비 `ownerId`면 `404`, `slot`이 `equipment`/`installation`이 아니거나 확장자가 `jpg`/`jpeg`/`png`가 아니면 `400`.
- 문서형(`EquipmentInspectionHistory`/`TrainingLog`/`Notice`): 없는 문서 `ownerId`면 `404`, 그 문서의 작성자도 아니고 시스템관리자도 아니면 `403`. `TrainingLog`는 결재가 한 단계라도 승인되어 있으면 `409`.

## 29. `DELETE /api/attachments/{id}`

첨부파일 삭제(파일과 메타데이터 모두 제거 — 장비/압축기와 달리 첨부파일은 이력 보존 대상이 아니라 실제로 지운다). 문서에 딸린 첨부는 그 문서를 삭제할 때(34번 검사이력, 47번 교육훈련, 55번 공지사항) 자동으로도 같이 삭제되니, 이 API는 "문서는 남기고 파일 하나만 지우고 싶을 때" 쓰면 된다.

**오류**: 권한 조건은 28번(업로드)과 완전히 동일하다 — `EquipmentPhoto`는 담당 장비가 아니면 `403`, 문서형은 작성자·시스템관리자가 아니면 `403`, `TrainingLog`는 결재가 승인되어 있으면 `409`. 없는 첨부 `id`면 `404`.

---

## 장비 검사이력 (EquipmentInspectionHistory) — 30~34번

장비 이력카드에서 장비별 검사/점검 이력을 자유 서술형으로 기록하는 기능이다. **점검일지(`InspectionReport`, 9~15번 — 매주 고정 10항목 체크리스트 + 3단계 결재)와는 완전히 별개**이니 혼동하지 않는다. 이쪽은 결재 없고 담당 장비 제약도 없다. 다만 동작별 권한이 다르다 — **조회(30·31번)/등록(32번)은 로그인한 사용자 누구나, 수정(33번)은 시스템관리자 또는 작성자 본인만, 삭제(34번)는 시스템관리자만** 가능하다. 첨부파일은 28번(`POST /api/attachments?ownerType=EquipmentInspectionHistory&ownerId={이력id}`)로 별도 업로드한다.

## 30. `GET /api/equipment-inspection-history`

특정 장비의 검사이력 목록. `date` 내림차순(최신 먼저)으로 내려간다.

| 쿼리 파라미터 | 필수 | 설명 |
|---|---|---|
| `equipmentId` | 예 | 장비 `id` |

**응답 예시**
```json
[
  {
    "id": 7, "equipmentId": 41, "date": "2026-09-10", "title": "정기 안전밸브 점검",
    "content": "안전밸브 작동압력 확인, 이상 없음", "notes": null,
    "createdByUserName": "홍길동1", "createdAt": "2026-09-10T01:00:00+00:00",
    "updatedByUserName": null, "updatedAt": null,
    "attachmentCount": 2,
    "canEdit": true
  }
]
```

- `attachmentCount`는 이 이력에 달린 첨부파일 개수만 가볍게 알려주는 값이다(목록에서 클립 아이콘 표시용) — 실제 파일 목록은 26번으로 따로 받는다.
- `canEdit`은 **지금 이 요청을 보낸 사용자**가 이 이력을 수정(33번)할 수 있는지를 서버가 계산해서 내려주는 값이다(시스템관리자거나 작성자 본인이면 `true`). 응답에는 작성자 Id가 아니라 이름만 있고 로그인 응답에도 사용자 Id가 없어서, 프론트가 JWT를 직접 디코드하지 않고 수정 버튼 표시 여부를 판단할 수 있게 넣은 값이다. 같은 이력이라도 조회한 사용자에 따라 값이 달라진다. 응답 전용 필드이므로 요청 본문에는 넣지 않는다.
- 삭제(34번) 가능 여부는 별도 필드가 없다 — 시스템관리자 여부만 보면 되고, 그건 로그인 응답의 `role`로 이미 알 수 있다.

## 31. `GET /api/equipment-inspection-history/{id}`

검사이력 단건 조회(편집 폼 채울 때 사용). 응답 형식은 30번의 원소 하나와 동일.

**오류**: 없는 `id`면 `404`.

## 32. `POST /api/equipment-inspection-history`

검사이력 등록.

**요청 예시**
```json
{ "equipmentId": 41, "date": "2026-09-10", "title": "정기 안전밸브 점검", "content": "안전밸브 작동압력 확인, 이상 없음", "notes": null }
```

**응답**: 30번과 같은 형식(`attachmentCount`는 등록 직후라 항상 `0`, `canEdit`은 방금 본인이 작성했으므로 항상 `true`). 이 응답의 `id`로 28번을 호출해 첨부파일을 올린다.

**오류**: `title`/`content`가 비어있으면 `400`. 없는 `equipmentId`면 `404`.

## 33. `PUT /api/equipment-inspection-history/{id}`

검사이력 편집. **시스템관리자 또는 그 이력을 작성한 본인만 가능**하다(2026-09-16 사양 변경 — 그 전에는 로그인한 누구나 수정 가능했음). `equipmentId`는 생성 후 바꿀 수 없어서 요청에 없다.

**요청 예시**
```json
{ "date": "2026-09-10", "title": "정기 안전밸브 점검(수정)", "content": "...", "notes": "재점검 필요" }
```

편집하면 `updatedByUserName`/`updatedAt`이 채워진다(누가 마지막으로 고쳤는지 표시용 — 시스템관리자가 남의 이력을 고친 경우에도 여기에 관리자 이름이 기록된다).

**오류**: `title`/`content`가 비어있으면 `400`. 없는 `id`면 `404`. 시스템관리자도 아니고 작성자 본인도 아니면 `403`.

## 34. `DELETE /api/equipment-inspection-history/{id}`

검사이력 삭제. **시스템관리자 전용**(등록/조회/편집과 달리 삭제만 권한 제한이 있다). 이 이력에 달린 첨부파일도 전부 같이 삭제된다(파일+메타데이터).

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

---

## 수리일지 (RepairLog) — 35~42번

장비별 수리/보수 작업 내역을 기록하고 결재를 받는 문서다. 점검일지(9~15번)·운전일지(16~20번)·장비 검사이력(30~34번)과 전부 별개다.

**결재**: 10번의 공통 규칙을 그대로 따르되, 이 문서유형은 **안전관리원이 "해당없음"(`/` 표시)** 이라 실제 승인은 **안전관리책임자 → 안전관리총괄자 2단계**다. 안전관리원이 승인 API를 호출하면 `409`가 난다. 승인 권한은 호출자의 역할 + 담당 장비(`UserEquipment`) 기준이며, 취소는 본인 단계만·상위 미승인 시에만 가능하고 반려 개념은 없다. 시스템관리자는 결재를 못 하지만 리셋(42번)은 할 수 있다.

**권한**

| 동작 | 결재 진행 전 | 결재가 1건이라도 승인된 후 |
|---|---|---|
| 조회(35·36번) | 로그인한 누구나 | 동일 |
| 등록(37번) | 로그인한 누구나 | — |
| 수정(38번) | 시스템관리자 또는 작성자 | 누구도 불가(`409`) |
| 삭제(39번) | 시스템관리자 또는 작성자 | 시스템관리자만(`403`) |

**첨부파일은 지원하지 않는다**(사양 변경 — 26~29번 첨부파일 API를 이 문서에는 쓰지 않는다).

**`performedAt` 주의**: 요청 시 어떤 시간대 오프셋으로 보내도 되지만(예: `2026-09-16T09:30:00+09:00`), 서버는 UTC로 정규화해서 저장하고 응답도 UTC(`2026-09-16T00:30:00+00:00`)로 내려준다 — 같은 시점이며, 표시용 변환은 프론트가 담당한다(다른 API의 `measuredAt`과 동일한 규칙).

## 35. `GET /api/repair-logs`

특정 장비의 수리일지 목록. `performedAt` 내림차순(최신 먼저).

| 쿼리 파라미터 | 필수 | 설명 |
|---|---|---|
| `equipmentId` | 예 | 장비 `id` |

**응답 예시**
```json
[
  {
    "id": 3, "equipmentId": 1,
    "title": "압축기 오일펌프 교체", "performedAt": "2026-09-16T00:30:00+00:00",
    "location": "PT배기환경시험동 기계실", "performedBy": "외부업체 한국냉동",
    "target": "1번 압축기 오일펌프",
    "stateBefore": "오일압력 저하, 이상소음", "stateAfter": "정상 압력 회복",
    "result": "교체 완료 후 24시간 시운전 정상",
    "failureCause": "펌프 베어링 마모", "preventiveAction": "6개월 주기 오일 상태 점검 추가",
    "opinion": "동일 모델 3대 모두 점검 권장",
    "createdByUserName": "홍길동1", "createdAt": "2026-09-16T01:30:01+00:00",
    "updatedByUserName": null, "updatedAt": null,
    "level1": { "status": "NotApplicable", "approverName": null, "approvedAt": null },
    "level2": { "status": "Approved", "approverName": "홍길동2", "approvedAt": "2026-09-16T02:00:00+00:00" },
    "level3": { "status": "Pending", "approverName": null, "approvedAt": null },
    "canEdit": false, "canDelete": false
  }
]
```

- `level1`~`level3`의 `status`는 점검일지와 동일한 값(`NotApplicable`/`Delegated`/`Pending`/`Approved`)이다. 이 문서는 `level1`이 항상 `NotApplicable`이라 프론트에서 `/`로 표시한다.
- `canEdit`/`canDelete`는 **지금 요청한 사용자**가 이 문서를 수정/삭제할 수 있는지를 서버가 위 권한 표대로 계산해서 내려주는 값이다. 조회한 사용자에 따라 값이 달라진다(응답 전용 필드). 프론트는 이 값만 보고 버튼 표시 여부를 정하면 된다.

## 36. `GET /api/repair-logs/{id}`

수리일지 단건 조회. 응답 형식은 35번의 원소 하나와 동일.

**오류**: 없는 `id`면 `404`.

## 37. `POST /api/repair-logs`

수리일지 등록. 로그인한 사용자 누구나 가능하다.

**요청 예시**
```json
{
  "equipmentId": 1,
  "title": "압축기 오일펌프 교체",
  "performedAt": "2026-09-16T09:30:00+09:00",
  "location": "PT배기환경시험동 기계실",
  "performedBy": "외부업체 한국냉동",
  "target": "1번 압축기 오일펌프",
  "stateBefore": "오일압력 저하, 이상소음",
  "stateAfter": "정상 압력 회복",
  "result": "교체 완료 후 24시간 시운전 정상",
  "failureCause": "펌프 베어링 마모",
  "preventiveAction": "6개월 주기 오일 상태 점검 추가",
  "opinion": "동일 모델 3대 모두 점검 권장"
}
```

`equipmentId`/`title`/`performedAt`만 필수고 나머지는 전부 생략(`null`) 가능하다. `target`은 수리한 부위/부품을 적는 자유 텍스트이며, 장비 자체는 `equipmentId`로 가리킨다.

**오류**: `title`이 비어있으면 `400`. 없는 `equipmentId`면 `404`.

## 38. `PUT /api/repair-logs/{id}`

수리일지 수정. `equipmentId`는 생성 후 변경할 수 없어 요청 본문에 없고, 나머지 필드 구성은 37번과 같다. 수정하면 `updatedByUserName`/`updatedAt`이 채워진다.

**오류**: 결재가 한 단계라도 승인된 문서면 `409`(누구도 수정 불가 — 리셋(42번) 후에는 다시 수정 가능). 시스템관리자도 아니고 작성자도 아니면 `403`. `title`이 비어있으면 `400`. 없는 `id`면 `404`.

## 39. `DELETE /api/repair-logs/{id}`

수리일지 삭제.

**오류**: 결재 진행 전인데 시스템관리자·작성자가 아니면 `403`. 결재가 한 단계라도 승인된 문서를 시스템관리자가 아닌 사람이 삭제하려 하면 `403`. 없는 `id`면 `404`.

## 40. `POST /api/repair-logs/{id}/approve`

결재 승인. 호출자의 역할로 결재 단계가 자동 결정된다(별도 파라미터 없음). 응답은 35번과 같은 형식.

**오류**: 결재 대상 역할이 아니거나(시스템관리자·일반관리원) 그 장비의 담당자가 아니면 `403`. 지금 승인할 수 없는 단계면(안전관리원처럼 해당없음 단계, 이미 승인됨, 이전 단계 미완료) `409`. 없는 `id`면 `404`.

## 41. `POST /api/repair-logs/{id}/approve/cancel`

본인이 승인한 단계를 취소한다. 응답은 35번과 같은 형식.

**오류**: 그 단계를 승인한 사람이 본인이 아니면 `403`. 상위 단계가 이미 승인되어 있으면 `409`. 없는 `id`면 `404`.

## 42. `POST /api/repair-logs/{id}/approvals/reset`

**시스템관리자 전용.** 진행 단계와 상관없이 결재를 전부 무효화한다. 리셋하면 수정 잠금도 함께 풀린다(잠금 기준이 "승인된 단계가 있는지"이므로).

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

---

## 교육훈련 일지 (TrainingLog) — 43~50번

안전 교육/훈련 실시 내역을 기록하고 결재를 받는 문서다. **다른 결재 문서와 달리 장비에 매달리지 않는 전사 문서**라 `equipmentId`가 없다.

**결재**: 10번 공통 규칙을 따르되 **안전관리원이 "해당없음"(`/` 표시)** 이라 실제 승인은 **안전관리책임자 → 안전관리총괄자 2단계**다. 취소는 본인 단계만·상위 미승인 시에만, 반려 없음, 시스템관리자는 승인 불가·리셋만 가능.

> **주의 — 이 문서만의 예외**: 다른 결재 문서는 승인 시 "역할 + 그 장비의 담당자인지(`UserEquipment`)"를 함께 검사하지만, 교육훈련은 검사할 장비가 없어 **역할만으로 승인 권한을 판정**한다. 즉 안전관리책임자/안전관리총괄자면 담당 장비와 무관하게 누구나 승인할 수 있다.

**권한** (수리일지와 동일)

| 동작 | 결재 진행 전 | 결재가 1건이라도 승인된 후 |
|---|---|---|
| 조회(43·44번) | 로그인한 누구나 | 동일 |
| 등록(45번) | 로그인한 누구나 | — |
| 수정(46번) | 시스템관리자 또는 작성자 | 누구도 불가(`409`) |
| 삭제(47번) | 시스템관리자 또는 작성자 | 시스템관리자만(`403`) |
| 첨부파일 추가/삭제(28·29번) | 로그인한 누구나 | 누구도 불가(`409`) |

**첨부파일**: 28번(`POST /api/attachments?ownerType=TrainingLog&ownerId={일지id}`)로 파일 개수만큼 반복 호출한다(다건, 확장자 제한 없음, 파일당 10MB). 일지를 삭제하면 딸린 첨부파일도 함께 삭제된다.

**`performedAt` 주의**: 요청 시 어떤 오프셋으로 보내도 되지만(예: `2026-09-16T14:00:00+09:00`) 서버는 UTC로 정규화해 저장하고 응답도 UTC(`2026-09-16T05:00:00+00:00`)로 내려준다 — 같은 시점이며 표시용 변환은 프론트 담당(수리일지와 동일).

## 43. `GET /api/training-logs`

교육훈련 일지 전체 목록, `performedAt` 내림차순(최신 먼저). **쿼리 파라미터 없음** — 장비별 문서가 아니라서 필터가 없고, 건수가 적어 페이징도 두지 않았다.

**응답 예시**
```json
[
  {
    "id": 1,
    "title": "2026년 3분기 냉동기 안전교육",
    "performedAt": "2026-09-16T05:00:00+00:00",
    "location": "본관 3층 대회의실",
    "instructor": "한국가스안전공사 김강사",
    "content": "냉매 누출 대응 절차, 비상정지 조작 실습",
    "attendees": "홍길동1, 홍길동2, 홍길동3, 외부 참석 2명",
    "createdByUserName": "홍길동1", "createdAt": "2026-09-16T02:42:25+00:00",
    "updatedByUserName": null, "updatedAt": null,
    "level1": { "status": "NotApplicable", "approverName": null, "approvedAt": null },
    "level2": { "status": "Approved", "approverName": "홍길동2", "approvedAt": "2026-09-16T03:00:00+00:00" },
    "level3": { "status": "Pending", "approverName": null, "approvedAt": null },
    "attachmentCount": 2,
    "canEdit": false, "canDelete": false
  }
]
```

- `attendees`는 **단순 문자열**이다 — 시스템 등록 인원(`Users`)과 무관하게 자유롭게 적는다.
- `attachmentCount`는 첨부파일 개수만 알려주는 값이고, 실제 파일 목록은 26번으로 따로 받는다.
- `canEdit`/`canDelete`는 요청한 사용자 기준으로 서버가 위 권한 표대로 계산한 값이다(응답 전용).

## 44. `GET /api/training-logs/{id}`

단건 조회. 응답 형식은 43번의 원소 하나와 동일.

**오류**: 없는 `id`면 `404`.

## 45. `POST /api/training-logs`

등록. 로그인한 사용자 누구나 가능하다.

**요청 예시**
```json
{
  "title": "2026년 3분기 냉동기 안전교육",
  "performedAt": "2026-09-16T14:00:00+09:00",
  "location": "본관 3층 대회의실",
  "instructor": "한국가스안전공사 김강사",
  "content": "냉매 누출 대응 절차, 비상정지 조작 실습",
  "attendees": "홍길동1, 홍길동2, 홍길동3, 외부 참석 2명"
}
```

`title`/`performedAt`만 필수고 나머지는 생략(`null`) 가능하다. 응답의 `id`로 28번을 호출해 첨부파일을 올린다.

**오류**: `title`이 비어있으면 `400`.

## 46. `PUT /api/training-logs/{id}`

수정. 요청 본문 구성은 45번과 동일하다. 수정하면 `updatedByUserName`/`updatedAt`이 채워진다.

**오류**: 결재가 한 단계라도 승인된 문서면 `409`(리셋(50번) 후에는 다시 수정 가능). 시스템관리자도 아니고 작성자도 아니면 `403`. `title`이 비어있으면 `400`. 없는 `id`면 `404`.

## 47. `DELETE /api/training-logs/{id}`

삭제. 딸린 첨부파일(파일+메타데이터)도 함께 정리된다.

**오류**: 결재 진행 전인데 시스템관리자·작성자가 아니면 `403`. 결재가 승인된 문서를 시스템관리자가 아닌 사람이 삭제하려 하면 `403`. 없는 `id`면 `404`.

## 48. `POST /api/training-logs/{id}/approve`

결재 승인. 호출자의 역할로 단계가 자동 결정된다(담당 장비 검사 없음). 응답은 43번과 같은 형식.

**오류**: 결재 대상 역할이 아니면(시스템관리자·일반관리원) `403`. 지금 승인할 수 없는 단계면(안전관리원처럼 해당없음 단계, 이미 승인됨, 이전 단계 미완료) `409`. 없는 `id`면 `404`.

## 49. `POST /api/training-logs/{id}/approve/cancel`

본인이 승인한 단계를 취소한다. 취소하면 수정·첨부 변경 잠금도 함께 풀린다.

**오류**: 그 단계를 승인한 사람이 본인이 아니면 `403`. 상위 단계가 이미 승인되어 있으면 `409`. 없는 `id`면 `404`.

## 50. `POST /api/training-logs/{id}/approvals/reset`

**시스템관리자 전용.** 결재를 전부 무효화한다(수정 잠금도 함께 해제).

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

---

## 공지사항 (Notice) — 51~57번

전사 공지사항. **결재가 없는 가장 단순한 문서**다. 장비와도 무관하다. (당초 계획했던 자유게시판 기능은 사양에서 제거되고 이 공지사항으로 통합됐다 — 2026-09-16 결정.)

**권한**

| 동작 | 권한 |
|---|---|
| 조회(51·52번) | 로그인한 누구나 |
| 등록(53번) | 로그인한 누구나 |
| 수정(54번) / 삭제(55번) | **작성자 또는 시스템관리자** |
| 상단 고정/해제(56·57번) | **시스템관리자만** |
| 첨부파일 추가/삭제(28·29번) | 작성자 또는 시스템관리자(수정 권한과 동일) |

**첨부파일**: 28번(`POST /api/attachments?ownerType=Notice&ownerId={공지id}`)로 파일 개수만큼 반복 호출(다건, 확장자 제한 없음, 파일당 10MB). 공지를 삭제하면 딸린 첨부파일도 함께 삭제된다.

## 51. `GET /api/notices`

공지사항 전체 목록. **상단 고정된 공지가 항상 먼저 나오고, 그 다음 작성일시 내림차순**이다. 쿼리 파라미터·페이징 없음.

**응답 예시**
```json
[
  {
    "id": 1,
    "title": "9월 정기 안전점검 일정 공지",
    "content": "9월 20일부터 22일까지 전 지구 냉동기 정기점검을 실시합니다.",
    "isPinned": true,
    "createdByUserName": "홍길동1", "createdAt": "2026-09-16T05:54:47+00:00",
    "updatedByUserName": null, "updatedAt": null,
    "attachmentCount": 2,
    "canEdit": true, "canDelete": true
  }
]
```

- `canEdit`/`canDelete`는 요청한 사용자 기준 계산값이다(작성자 또는 시스템관리자면 `true`). 수정·삭제 조건이 같아서 두 값은 항상 동일하지만 버튼별로 쓰기 편하도록 따로 내려준다.
- 상단 고정 가능 여부는 별도 필드가 없다 — 시스템관리자 여부만 보면 되고, 그건 로그인 응답의 `role`로 알 수 있다.

## 52. `GET /api/notices/{id}`

단건 조회. 응답 형식은 51번의 원소 하나와 동일.

**오류**: 없는 `id`면 `404`.

## 53. `POST /api/notices`

등록. 로그인한 사용자 누구나 가능하다.

**요청 예시**
```json
{ "title": "9월 정기 안전점검 일정 공지", "content": "9월 20일부터 22일까지 ..." }
```

`title`만 필수이고 `content`는 생략(`null`) 가능하다. **`isPinned`는 요청 본문에 없다** — 상단 고정은 56·57번(관리자 전용)으로만 바꾼다. 등록 직후 응답의 `isPinned`는 항상 `false`.

**오류**: `title`이 비어있으면 `400`.

## 54. `PUT /api/notices/{id}`

수정. 요청 본문은 53번과 동일(`title`, `content`). 상단 고정 상태는 이 API로 바뀌지 않는다. 수정하면 `updatedByUserName`/`updatedAt`이 채워진다.

**오류**: 작성자도 아니고 시스템관리자도 아니면 `403`. `title`이 비어있으면 `400`. 없는 `id`면 `404`.

## 55. `DELETE /api/notices/{id}`

삭제. 딸린 첨부파일(파일+메타데이터)도 함께 정리된다.

**오류**: 작성자도 아니고 시스템관리자도 아니면 `403`. 없는 `id`면 `404`.

## 56. `POST /api/notices/{id}/pin`

상단 고정. **시스템관리자 전용.** 응답은 51번과 같은 형식(`isPinned: true`).

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

## 57. `POST /api/notices/{id}/unpin`

상단 고정 해제. **시스템관리자 전용.** 응답은 51번과 같은 형식(`isPinned: false`).

**오류**: 시스템관리자가 아니면 `403`. 없는 `id`면 `404`.

---

## 자료 조회 (장비별 일자 조회) — 58번

특정 장비의 특정 날짜 기록을 모아 보는 화면(Front_Work.md 4장)은 **전용 API 하나가 아니라 아래 네 개를 조합**해서 구성한다. 새로 추가된 건 58번 하나뿐이고 나머지는 기존 API를 그대로 쓴다.

| 화면 요소 | 사용 API |
|---|---|
| 압축기 리스트 | `GET /api/equipments/{id}/compressors` (3번) |
| 압축기 클릭 → 하루 트렌드(1440분 × 7채널) | `GET /api/compressors/{id}/trend?date=` (6번) |
| 해당일 가동률 | `GET /api/equipments/{id}/utilization?from={날짜}` (8번, `to` 생략하면 그 하루만 계산) |
| 해당 장비·해당일 이벤트 리스트 | **`GET /api/equipments/{id}/events?date=` (58번)** |
| 이벤트 클릭 상세 팝업 | 58번 응답의 해당 항목을 그대로 사용(단건 조회 API 없음 — 목록에 모든 필드가 이미 내려간다) |

트렌드는 **압축기 1대씩** 받는다. 장비 단위로 묶어 한 번에 주는 API는 두지 않았다 — 압축기 4대면 1440×4 = 5,760포인트가 한 응답에 실려 수 MB가 되고, 화면도 압축기를 클릭할 때 한 대씩 보여주는 구조라서다.

## 58. `GET /api/equipments/{id}/events`

특정 장비에서 특정 날짜에 발생한 이벤트 전체. 9번(실시간 피드)과 응답 형식은 같지만 용도가 다르다 — 9번은 `since` 기반 폴링(최대 500건)이고, 이쪽은 **하루치를 전부** 반환한다(페이징 없음).

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `date` | 아니오 | 조회 날짜(한국 시간 기준 하루). 생략 시 오늘 |
| `category` | 아니오 | `Alarm`/`Communication`/`UserAccess`/`System`/`Approval`/`EmergencyStop` 중 하나. 생략 시 전체 |

**요청 예시**: `GET /api/equipments/39/events?date=2026-09-16&category=Alarm`

**응답**: 9번과 동일한 형식의 배열(`createdAt` 내림차순 = 최신 먼저). 경보 이벤트면 `value`/`lowerLimit`/`upperLimit`/`decimalPlaces`/`unit`이 채워져 오므로 상세 팝업을 추가 호출 없이 구성할 수 있다.

**건수**: 2026-09-16에 같은 경보를 반복 기록하던 버그를 수정해서(9번 항목 설명 참고) 중복은 사라졌다. 다만 **건수 자체는 채널 설정(경보 지연·해제 지연)과 센서값이 얼마나 요동치는지에 따라 달라진다** — 값이 경계 부근에서 자주 오가는 채널이 많으면 하루 수백 건까지 나올 수 있다(현재 TestMode 랜덤값 환경에서 실측: 시스템 전체 분당 약 57건, 장비 1대 기준 4분에 최대 12건). 페이징은 두지 않았으니 양이 부담되면 `category=Alarm`처럼 필터를 걸어 쓰고, 화면에서 연속 경보를 구간으로 묶어 표시하는 방식을 함께 쓰는 것을 권한다.

**오류**: 없는 장비 `id`면 `404`. `category`가 목록에 없는 값이면 `400`.

---

## 조직관리 (사용자) — 59~69번

안전관리 담당자 계정과 인적사항을 관리한다.

**권한**

| 동작 | 권한 |
|---|---|
| 목록·상세 조회(59·60번) | 로그인한 누구나 |
| 본인 조회(61번) | 로그인한 누구나(시스템관리자 포함) |
| ID 중복확인·등록·수정·비밀번호 초기화·비활성화/활성화(62~67번) | **시스템관리자만** (`403`) |
| 본인 비밀번호 변경·연락처 변경(68·69번) | 본인 |
| 선해임 신고서 업로드·삭제(28·29번, `ownerType=AppointmentReport`) | 시스템관리자만 |

**담당업무(`role`)는 결재 권한과 같은 값**이다 — 담당업무를 바꾸면 결재 가능 단계도 바뀐다. 지정 가능한 값은 `안전관리총괄자`/`안전관리책임자`/`안전관리원`/`일반관리원` 네 가지다. **시스템관리자는 담당업무가 아니라 별도 관리 계정**이라 이 API로 지정할 수 없고(`400`), 목록에 나오지 않으며, 수정·비활성화·비밀번호 초기화 대상도 아니다(`404`). 관리자 본인 비밀번호는 68번으로 바꾼다.

**삭제 API는 없다** — 비활성화(66번)하면 로그인만 막히고 모든 기록이 남는다. 단, **이미 발급된 로그인 토큰은 만료(12시간)까지 계속 유효**하다(서버가 토큰을 무효화하지 않는 구조).

## 59. `GET /api/users`

조직 구성원 전체(비활성 포함, 시스템관리자 제외). 담당업무 순(총괄자→책임자→안전관리원→일반관리원) → 성명 순.

**응답 예시**
```json
[
  {
    "id": 6, "username": "test1", "fullName": "홍길동1",
    "department": "설비안전팀", "position": "대리", "role": "안전관리원",
    "phone1": "010-1111-2222", "phone2": null,
    "backupPersonName": "홍길동2", "isAppointed": true,
    "legalTrainingDate": "2026-03-10", "nextTrainingDate": "2027-03-10",
    "isActive": true,
    "equipmentIds": [6, 10],
    "appointmentReportId": 38
  }
]
```

- 비밀번호(해시)는 어떤 응답에도 포함되지 않는다.
- `isAppointed`: `true`=선임, `false`=미선임.
- `equipmentIds`: 담당장비 `id` 목록. 장비 이름 등은 `GET /api/equipments`(1번)와 매칭해서 표시한다.
- `appointmentReportId`: 선해임 신고서 첨부파일 `id`(없으면 `null`). `GET /api/attachments/{id}`(27번)로 받는다.
- `department`/`position`/`phone1`/`phone2`/`backupPersonName`은 값이 없으면 `null`(빈 문자열로 보내도 `null`로 저장된다).

## 60. `GET /api/users/{id}`

단건 조회. 응답은 59번의 원소 하나. **오류**: 없는 `id`거나 시스템관리자 계정이면 `404`.

## 61. `GET /api/users/me`

로그인한 본인 정보. 응답 형식은 59번과 같다(시스템관리자로 로그인했으면 `role: "시스템관리자"`). 본인 정보 수정 화면에서 쓴다.

## 62. `GET /api/users/check-username?username=`

사용자 ID 중복확인. **시스템관리자 전용.** 비활성 계정이 쓰는 ID도 "사용 중"으로 본다.

**응답 예시**: `{ "username": "orgtest01", "available": true }`

**오류**: `username`이 비어있으면 `400`.

## 63. `POST /api/users`

사용자 등록. **시스템관리자 전용.**

**요청 예시**
```json
{
  "username": "kim01", "password": "초기비밀번호",
  "fullName": "김안전", "department": "설비안전팀", "position": "대리",
  "role": "안전관리원",
  "phone1": "010-1111-2222", "phone2": null,
  "backupPersonName": "홍길동2", "isAppointed": true,
  "legalTrainingDate": "2026-03-10", "nextTrainingDate": "2027-03-10",
  "equipmentIds": [6, 10]
}
```

- 필수: `username`, `password`, `fullName`, `role`. 나머지는 생략(`null`) 가능, `equipmentIds`는 빈 배열 가능.
- **사용자 ID는 생성 후 바꿀 수 없다.** 비밀번호 규칙은 "비어있지 않을 것"만 검사한다.
- `equipmentIds`에 같은 `id`가 중복돼도 하나로 정리된다. 여러 사용자가 같은 장비를 담당할 수 있다.
- 선해임 신고서는 등록 응답의 `id`로 28번(`ownerType=AppointmentReport&ownerId={id}`)을 호출해서 올린다.

**오류**: ID·비밀번호·성명이 비어있거나, `role`이 네 가지 담당업무가 아니거나(시스템관리자 포함), 존재하지 않는 장비 `id`가 있으면 `400`. 이미 쓰는 ID면 `409`.

## 64. `PUT /api/users/{id}`

인적사항·담당업무·담당장비 수정. **시스템관리자 전용.** 요청 본문은 63번에서 `username`/`password`를 뺀 나머지다.

- **`equipmentIds`는 목록 전체 교체**다 — 보낸 목록에 없는 장비는 담당에서 빠지고 새 장비는 추가된다.
- 비밀번호는 이 API로 바뀌지 않는다(65번).

**오류**: 없는 `id`거나 시스템관리자 계정이면 `404`. 검증 오류는 63번과 동일하게 `400`.

## 65. `PUT /api/users/{id}/password`

비밀번호 초기화(관리자가 새 비밀번호를 지정). **시스템관리자 전용.** 현재 비밀번호 확인 없음.

**요청**: `{ "newPassword": "새비밀번호" }` → **응답**: `204`

**오류**: 비밀번호가 비어있으면 `400`. 없는 `id`거나 시스템관리자 계정이면 `404`.

## 66. `POST /api/users/{id}/deactivate` · 67. `POST /api/users/{id}/activate`

비활성화 / 다시 활성화. **시스템관리자 전용.** 응답은 59번 원소 하나(`isActive` 반영). 비활성 계정은 로그인(0번)이 `401`로 막힌다.

**오류**: 없는 `id`거나 시스템관리자 계정이면 `404`.

## 68. `PUT /api/users/me/password`

본인 비밀번호 변경. 현재 비밀번호 확인이 필요하다. 시스템관리자도 이 API로 자기 비밀번호를 바꾼다.

**요청**: `{ "currentPassword": "현재비밀번호", "newPassword": "새비밀번호" }` → **응답**: `204`

**오류**: 새 비밀번호가 비어있거나 현재 비밀번호가 틀리면 `400`.

## 69. `PUT /api/users/me/contact`

본인 연락처 변경. **본인이 직접 바꿀 수 있는 인적사항은 연락처1·2뿐**이다(나머지는 시스템관리자가 64번으로 수정).

**요청**: `{ "phone1": "010-9999-8888", "phone2": "" }` → **응답**: 59번 원소 하나(빈 문자열은 `null`로 저장)

---

## 실시간 현황 (대시보드) — 70~71번

## 70. `GET /api/equipments/status`

실시간 현황 5초 갱신용 **경량 상태 API**. 1번(장비 속성 40여 개 전체)과 4번을 매번 받는 대신, 화면에 필요한 장비·압축기 상태값만 한 번에 내려준다. 권한: 로그인한 누구나.

- **장비 상태가 `운영`인 장비만** 나온다.
- 정렬: 1번과 같음(`buildingName` → `name`). `compressors`는 `sequenceNo` 오름차순.
- 필드 의미는 1번(장비)·3번(압축기)의 같은 이름 필드와 동일하다(`hasAlarm`도 같은 기준).

**응답 예시**
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

## 71. `GET /api/system/status`

"시스템 정보"·"서버 상태" 카드용. 프론트는 30초마다 호출한다. 권한: 로그인한 누구나.

**응답 예시**
```json
{
  "checkedAt": "2026-09-17T07:52:02.9204261+00:00",
  "storage": { "usedBytes": 154325528576, "totalBytes": 1047615500288, "target": "C:" },
  "cpu": { "usagePercent": 11.4, "coreCount": 12 },
  "memory": { "usedBytes": 13832888320, "totalBytes": 34311213056 },
  "server": { "status": "정상", "startedAt": "2026-09-17T07:51:25.7618226+00:00" },
  "databaseBackup": null,
  "collection": { "intervalSeconds": 3, "compressorCount": 244 },
  "api": { "status": "정상" }
}
```

| 필드 | 설명 |
|---|---|
| `checkedAt` | 서버가 값을 측정한 시각(UTC) |
| `storage` | DB 데이터가 있는 드라이브(서버 설정값)의 사용량/전체 용량(바이트). `target`은 드라이브 이름(예: `"C:"`) |
| `cpu.usagePercent` | 서버 전체 CPU 사용률(0~100, 소수 1자리). **직전 호출 이후 구간의 평균**이다 — 30초마다 부르면 최근 30초 평균 |
| `cpu.coreCount` | 논리 코어 수 |
| `memory` | 서버 전체 물리 메모리 사용량/전체(바이트) |
| `server.status` | `정상`/`주의`/`오류`. 오류: 저장소 95% 이상 / 주의: 저장소·메모리·CPU 중 하나라도 90% 이상 |
| `server.startedAt` | **백엔드 프로세스** 시작 시각(OS 부팅 시각 아님 — 서비스 재시작 시 바뀜) |
| `databaseBackup` | **현재 항상 `null`** — 백업 기능이 아직 없다. 기능이 생기면 `{ lastBackupAt, lastBackupSucceeded, scheduleText }` 형태로 채운다 |
| `collection.intervalSeconds` | 압축기 폴링 주기(3) |
| `collection.compressorCount` | **실제 수집 대상** 압축기 수(운영 장비의 압축기, 실운영 모드면 IP가 있는 것만). 전체 압축기 수가 아니다 |
| `api.status` | 백엔드 내부 의존 요소 점검. 오류: DB 연결 실패 또는 마지막 수집 사이클 완료가 30초 이상 전 / 주의: 10초 이상 전 / 정상 |

- 측정에 실패한 항목(`storage`/`cpu`/`memory`/`collection`)은 그 객체가 `null`로 온다 — 그 칸만 "-"로 표시한다.
- 남은 용량, 사용률 %, 가동시간, 응답 시간은 백엔드가 주지 않는다(프론트 계산).
- 서버 시작 후 **첫 호출만** CPU 측정 때문에 약 0.2~0.3초 더 걸린다(이후 호출은 즉시 응답). 응답 시간 표시에 첫 값이 튈 수 있다.

---

## 아직 없는 API (참고)

- 비상정지
- (점검일지는 9~15번, 운전일지는 16~20번, 장비관리는 21~25번, 첨부파일은 26~29번, 장비 검사이력은 30~34번, 수리일지는 35~42번, 교육훈련 일지는 43~50번, 공지사항은 51~57번, 자료 조회는 58번, 조직관리는 59~69번, 실시간 현황(대시보드)은 70~71번 항목으로 구현됨. 자유게시판은 사양에서 제거되어 공지사항으로 통합됨)
