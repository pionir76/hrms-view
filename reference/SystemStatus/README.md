# SystemStatus 모듈

실시간 현황(대시보드) 화면의 **"시스템 정보"·"서버 상태" 카드**용 API 모듈. 프론트 요청(`view/requests/backend_request_dashboard_20260917.md`)을 받아 2026-09-17 추가했다.

## 내부 구성

- `Controllers/SystemStatusController.cs` — `GET /api/system/status` (로그인한 누구나). 판정 로직도 여기 있다.
- `SystemResources.cs` — 서버 PC 전체의 CPU/메모리 사용량을 Windows API(`kernel32`의 `GetSystemTimes`, `GlobalMemoryStatusEx`)로 읽는 헬퍼
- `Models/Dtos.cs` — 응답 DTO
- `Models/HealthStatus.cs` — `정상`/`주의`/`오류` enum

모듈 이름을 `System`이 아니라 `SystemStatus`로 둔 이유: 네임스페이스가 `HRMS.Modules.System`이 되면 .NET의 `System` 네임스페이스와 이름이 겹쳐 모듈 안 코드에서 `System.xxx` 참조가 전부 꼬인다.

## 항목별 사양

| 필드 | 값을 얻는 방법 | 비고 |
|---|---|---|
| `checkedAt` | 요청 처리 시각(UTC) | |
| `storage` | `appsettings`의 `SystemStatus:StorageDrive` 드라이브를 `DriveInfo`로 읽음 | 설정이 없거나 드라이브를 못 읽으면 `null` |
| `cpu.usagePercent` | `GetSystemTimes` 누적값을 **직전 호출과 비교**해서 계산 | 프론트가 30초마다 부르므로 자연히 최근 30초 평균이 된다(순간값 튐 방지). 서버 시작 후 첫 호출만 200ms 간격으로 두 번 읽는다 |
| `cpu.coreCount` | `Environment.ProcessorCount` | 논리 코어 수 |
| `memory` | `GlobalMemoryStatusEx` — 사용량 = 전체 물리 메모리 − 사용 가능 메모리 | 서버 전체 기준(이 프로세스만이 아님) |
| `server.startedAt` | 백엔드 프로세스 시작 시각 | **OS 부팅 시각이 아니다** — 서비스 재시작 시 초기화된다 |
| `databaseBackup` | 항상 `null` | 아래 "DB 백업" 참고 |
| `collection.intervalSeconds` | `CompressorPollingService.PollIntervalMs` (코드 상수 3초) | 설정값 아님 |
| `collection.compressorCount` | `CompressorPollingService.CollectionTargets`로 센 **실제 수집 대상** 압축기 수 | 전체 압축기 수가 아니다. 폴링 루프와 같은 기준(운영 장비만, 실운영 모드면 IP 있는 것만)을 공유한다. DB 연결 실패 시 `collection` 전체가 `null` |

- CPU/메모리는 Windows에서만 읽는다(운영 서버가 Windows 서비스로 배포됨). 다른 OS에서는 `null`.
- 두 Windows API 모두 관리자 권한 없이 일반 서비스 계정으로 읽힌다. `DriveInfo`도 마찬가지.
- 측정에 실패한 항목은 그 객체 자체를 `null`로 준다(프론트가 그 칸만 "-" 표시).

## 판정 기준 (사용자 결정 2026-09-17)

### `server.status` — 서버 자원 상태

| 결과 | 조건 |
|---|---|
| `오류` | 저장소 사용률 **95% 이상** |
| `주의` | 저장소·메모리·CPU 중 하나라도 **90% 이상** |
| `정상` | 그 외 |

측정하지 못한(`null`) 항목은 판정에서 빠진다. 기준값은 `SystemStatusController`의 상수(`WarningUsagePercent`, `ErrorStorageUsagePercent`)로 둔다.

### `api.status` — 백엔드 내부 의존 요소 상태

| 결과 | 조건 |
|---|---|
| `오류` | DB 연결 실패(`Database.CanConnectAsync`) **또는** 마지막 폴링 사이클 완료가 **30초 이상** 전 |
| `주의` | 마지막 폴링 사이클 완료가 **10초 이상** 전 |
| `정상` | 그 외 |

- "마지막 폴링 사이클 완료 시각"은 `CompressorPollingService.LastCycleCompletedAt`(사이클이 끝까지 성공할 때마다 갱신)이다. 서버가 막 떠서 아직 한 사이클도 안 끝났으면 **서버 시작 시각**부터 경과 시간을 잰다.
- API가 응답하는 것 자체(살아있음)는 프론트가 호출 성공 여부로 안다 — 여기서는 내부 의존 요소만 본다.

### 알려진 이슈 — 실제 장비 환경에서 `주의`가 가끔 뜰 수 있음

사이클은 모든 압축기 통신이 끝나야 완료되는데, 응답 없는 압축기가 하나라도 있으면 `PcLinkClient`의 **연결 타임아웃 3초 + 응답 타임아웃 3초**를 다 기다린다. 그 뒤 3초 대기까지 더하면 사이클 완료 간격이 최악 약 9~10초가 되어 `주의`(10초) 경계에 걸린다. 테스트 모드에서는 드러나지 않으므로, **현장 설치 후 실제 장비로 확인해서 필요하면 주의 기준을 늘린다**(예: 15초).

## DB 백업

**현재 백업 기능이 없다**(overview.md "데이터 백업 및 복원 정책 — 추후 결정"). 그래서 `databaseBackup`은 항상 `null`로 내려간다(사용자 결정 2026-09-17). 응답 형태(`lastBackupAt`, `lastBackupSucceeded`, `scheduleText`)만 `DatabaseBackupStatusDto`로 미리 정해뒀다 — 백업 정책이 정해지면 이력을 어디서 읽을지 정하고 채운다.

## 실제 설치 시 변경 필요 항목

| 항목 | 위치 | 현재값(개발 PC) | 설치 시 할 일 |
|---|---|---|---|
| 저장소 대상 드라이브 | `appsettings.json` → `SystemStatus:StorageDrive` | `C:\` (개발 PC의 PostgreSQL 데이터 폴더가 `C:\Program Files\PostgreSQL\17\data`) | 운영 서버에서 **PostgreSQL 데이터 폴더가 있는 드라이브**로 바꾼다. 확인 방법: `Get-CimInstance Win32_Service -Filter "Name like 'postgres%'"`의 `PathName`에서 `-D` 뒤 경로 |
| `api.status` 주의 기준(10초) | `SystemStatusController.CollectionWarningAge` | 10초 | 위 "알려진 이슈" — 실제 장비에서 `주의`가 잦으면 늘린다 |
| DB 백업 | — | 기능 없음(`null`) | 백업 정책 결정 후 구현 |

같은 내용이 `Doc/setup.md` "실제 설치 시 변경 필요 항목"에도 있다.
