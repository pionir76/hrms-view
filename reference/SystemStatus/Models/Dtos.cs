namespace HRMS.Modules.SystemStatus.Models;

//------------------------------------------------------------------------------//
// GET /api/system/status 응답. 측정에 실패한 항목은 해당 객체 자체를 null로 내려서
// 프론트가 그 칸만 "-"로 표시하게 한다(프론트 요청 2026-09-17).
// 남은 용량/사용률 %/가동시간/응답 시간은 프론트가 계산하므로 여기 없다.
//------------------------------------------------------------------------------//
public record SystemStatusDto(
    DateTimeOffset CheckedAt,
    StorageStatusDto? Storage,
    CpuStatusDto? Cpu,
    MemoryStatusDto? Memory,
    ServerStatusDto Server,
    DatabaseBackupStatusDto? DatabaseBackup,
    CollectionStatusDto? Collection,
    ApiStatusDto Api);

public record StorageStatusDto(long UsedBytes, long TotalBytes, string Target);

public record CpuStatusDto(double UsagePercent, int CoreCount);

public record MemoryStatusDto(long UsedBytes, long TotalBytes);

public record ServerStatusDto(string Status, DateTimeOffset StartedAt);

// 백업 기능이 아직 없어 현재는 항상 null로 내려간다(README "DB 백업" 참고). 형태만 미리 정해둔다.
public record DatabaseBackupStatusDto(DateTimeOffset? LastBackupAt, bool LastBackupSucceeded, string? ScheduleText);

public record CollectionStatusDto(int IntervalSeconds, int CompressorCount);

public record ApiStatusDto(string Status);
