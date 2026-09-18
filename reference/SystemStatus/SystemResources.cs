using System.Runtime.InteropServices;

namespace HRMS.Modules.SystemStatus;

//--------------------------------------------------------------------------------//
// 서버 PC 전체의 CPU/메모리 사용량을 읽는 헬퍼. .NET 기본 API로는 "이 프로세스"가 아니라
// "서버 전체" 사용률이 바로 나오지 않아서 Windows API(kernel32)를 직접 호출한다.
// 운영 서버가 Windows 서비스로 배포되므로 Windows에서만 동작하고, 그 외 OS에서는 null을 준다.
// 두 API 모두 관리자 권한 없이 일반 서비스 계정으로 읽힌다.
//--------------------------------------------------------------------------------//
public static class SystemResources
{
    [DllImport("kernel32.dll")]
    private static extern bool GetSystemTimes(out long idleTime, out long kernelTime, out long userTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll")]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    //--------------------------------------------------------------------------------//
    // CPU 사용률은 "두 시점 사이의 누적 시간 차이"로만 계산할 수 있다. 그래서 직전 호출 때의
    // 누적값을 기억해뒀다가 이번 값과 비교한다 — 프론트가 30초마다 부르므로 자연히 최근 30초
    // 평균이 되어, 순간값이 튀는 문제도 같이 해결된다.
    // 서버 시작 후 첫 호출처럼 직전값이 없으면 200ms 간격으로 두 번 읽어서 계산한다.
    //--------------------------------------------------------------------------------//
    private static readonly Lock CpuLock = new();
    private static (long Idle, long Total)? previousCpuSample;

    public static async Task<double?> ReadCpuUsagePercentAsync()
    {
        if (!OperatingSystem.IsWindows()) return null;

        (long Idle, long Total)? previous;
        lock (CpuLock) previous = previousCpuSample;

        if (previous is null)
        {
            previous = SampleCpu();
            if (previous is null) return null;
            await Task.Delay(200);
        }

        var current = SampleCpu();
        if (current is null) return null;
        lock (CpuLock) previousCpuSample = current;

        long totalDelta = current.Value.Total - previous.Value.Total;
        long idleDelta = current.Value.Idle - previous.Value.Idle;
        if (totalDelta <= 0) return 0;

        double usage = 100.0 * (totalDelta - idleDelta) / totalDelta;
        return Math.Round(Math.Clamp(usage, 0, 100), 1);
    }

    // kernelTime에는 idle 시간이 포함되어 있으므로 전체 = kernel + user 다.
    private static (long Idle, long Total)? SampleCpu() =>
        GetSystemTimes(out long idle, out long kernel, out long user) ? (idle, kernel + user) : null;

    public static (long UsedBytes, long TotalBytes)? ReadMemory()
    {
        if (!OperatingSystem.IsWindows()) return null;

        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        if (!GlobalMemoryStatusEx(ref status)) return null;

        return ((long)(status.TotalPhys - status.AvailPhys), (long)status.TotalPhys);
    }
}
