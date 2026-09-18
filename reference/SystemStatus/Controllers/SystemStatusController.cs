using System.Diagnostics;
using HRMS.Infrastructure;
using HRMS.Modules.Communication;
using HRMS.Modules.SystemStatus.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace HRMS.Modules.SystemStatus.Controllers;

//---------------------------------------------------------------------------//
// 실시간 현황 화면의 "시스템 정보"·"서버 상태" 카드용 API. 프론트가 30초마다 호출한다.
// 판정 기준·설치 시 바꿔야 할 설정은 Modules/SystemStatus/README.md가 기준이다.
//---------------------------------------------------------------------------//
[ApiController]
[Route("api/system/status")]
[Authorize]
public class SystemStatusController(AppDbContext db, IConfiguration configuration) : ControllerBase
{
    // server.status 판정 기준(%) — README "판정 기준"과 같이 고칠 것
    private const double WarningUsagePercent = 90;
    private const double ErrorStorageUsagePercent = 95;

    // api.status 판정 기준 — 마지막 폴링 사이클 완료 후 경과 시간
    private static readonly TimeSpan CollectionWarningAge = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CollectionErrorAge = TimeSpan.FromSeconds(30);

    [HttpGet]
    public async Task<ActionResult<SystemStatusDto>> Get()
    {
        var now = DateTimeOffset.UtcNow;
        var startedAt = new DateTimeOffset(Process.GetCurrentProcess().StartTime).ToUniversalTime();

        var storage = ReadStorage();
        var cpuUsage = await SystemResources.ReadCpuUsagePercentAsync();
        var cpu = cpuUsage is { } usage ? new CpuStatusDto(usage, Environment.ProcessorCount) : null;
        var memory = SystemResources.ReadMemory() is { } m ? new MemoryStatusDto(m.UsedBytes, m.TotalBytes) : null;

        //---------------------------------------------------------------------------//
        // DB 연결 점검 + 수집 대상 압축기 수. DB가 안 되면 수집 정보도 null.
        //---------------------------------------------------------------------------//
        bool dbOk;
        CollectionStatusDto? collection = null;
        try
        {
            dbOk = await db.Database.CanConnectAsync();
            if (dbOk)
            {
                bool testMode = configuration.GetValue("Communication:TestMode", false);
                int count = await CompressorPollingService.CollectionTargets(db, testMode).CountAsync();
                collection = new CollectionStatusDto(CompressorPollingService.PollIntervalMs / 1000, count);
            }
        }
        catch
        {
            dbOk = false;
        }

        return Ok(new SystemStatusDto(
            now,
            storage,
            cpu,
            memory,
            new ServerStatusDto(JudgeServer(storage, cpu, memory).ToString(), startedAt),
            DatabaseBackup: null, // 백업 기능 없음(README "DB 백업")
            collection,
            new ApiStatusDto(JudgeApi(dbOk, now, startedAt).ToString())));
    }

    //---------------------------------------------------------------------------//
    // 저장소: appsettings의 SystemStatus:StorageDrive(DB 데이터가 저장되는 드라이브)를 읽는다.
    // 설정이 없거나 드라이브를 못 읽으면 null.
    //---------------------------------------------------------------------------//
    private StorageStatusDto? ReadStorage()
    {
        string? drive = configuration["SystemStatus:StorageDrive"];
        if (string.IsNullOrWhiteSpace(drive)) return null;

        try
        {
            var info = new DriveInfo(drive);
            if (!info.IsReady) return null;
            return new StorageStatusDto(info.TotalSize - info.TotalFreeSpace, info.TotalSize, info.Name.TrimEnd('\\', '/'));
        }
        catch
        {
            return null;
        }
    }

    //---------------------------------------------------------------------------//
    // server.status — 오류: 저장소 95% 이상 / 주의: 저장소·메모리·CPU 중 하나라도 90% 이상.
    // 측정 못 한 항목(null)은 판정에서 빠진다.
    //---------------------------------------------------------------------------//
    private static HealthStatus JudgeServer(StorageStatusDto? storage, CpuStatusDto? cpu, MemoryStatusDto? memory)
    {
        double? storagePercent = storage is { TotalBytes: > 0 } s ? 100.0 * s.UsedBytes / s.TotalBytes : null;
        double? memoryPercent = memory is { TotalBytes: > 0 } m ? 100.0 * m.UsedBytes / m.TotalBytes : null;

        if (storagePercent >= ErrorStorageUsagePercent) return HealthStatus.오류;
        if (storagePercent >= WarningUsagePercent || memoryPercent >= WarningUsagePercent || cpu?.UsagePercent >= WarningUsagePercent)
            return HealthStatus.주의;
        return HealthStatus.정상;
    }

    //---------------------------------------------------------------------------//
    // api.status — 오류: DB 연결 실패 또는 마지막 폴링 완료가 30초 이상 전 / 주의: 10초 이상 전.
    // 서버가 막 떠서 아직 한 사이클도 안 끝났으면 서버 시작 시각부터 경과 시간을 잰다.
    //---------------------------------------------------------------------------//
    private static HealthStatus JudgeApi(bool dbOk, DateTimeOffset now, DateTimeOffset startedAt)
    {
        if (!dbOk) return HealthStatus.오류;

        var age = now - (CompressorPollingService.LastCycleCompletedAt ?? startedAt);
        if (age >= CollectionErrorAge) return HealthStatus.오류;
        if (age >= CollectionWarningAge) return HealthStatus.주의;
        return HealthStatus.정상;
    }
}
