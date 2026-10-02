# 납품·테스트 서버에 올릴 전달용 폴더를 만든다(2026-10-02).
#
# 빌드 과정이 없는 프로젝트라 화면에 필요한 파일만 그대로 복사한다:
#   index.html, pages/, common/, assets/
# 빼는 것: mokup/(시안), README.md, TODO.md, reference/(백엔드 문서), .git, 이 스크립트
#   — README·TODO에는 API 구조·권한 규칙 같은 내부 정보가 있어 서버에 올리면 누구나 열람할 수 있다.
# API 주소는 common/js/config.js가 화면을 연 주소를 보고 자동으로 고르므로(현장은 상대 경로) 고칠 것이 없다.
#
# 사용법(PowerShell, 이 폴더에서):
#   .\make-deploy.ps1                 → 상위 폴더의 deploy\ 에 만든다
#   .\make-deploy.ps1 -Out D:\전달\HRMS → 원하는 위치에 만든다
# 만들어진 폴더의 "내용"을 서버의 wwwroot(예: C:\HRMS\wwwroot)에 덮어쓴다.

param(
  [string]$Out = (Join-Path (Split-Path $PSScriptRoot -Parent) "deploy")
)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$items = @("index.html", "pages", "common", "assets")

# 출력 위치 안전장치 — 프로젝트 폴더 자체나 그 안을 지우지 않도록
$outFull = [System.IO.Path]::GetFullPath($Out)
if ($outFull.TrimEnd('\') -eq $src.TrimEnd('\') -or $outFull.StartsWith($src.TrimEnd('\') + '\')) {
  throw "출력 위치가 프로젝트 폴더 안입니다: $outFull"
}

# 이전 결과를 비우고 새로 만든다(이 스크립트가 만든 폴더만 대상)
if (Test-Path $outFull) {
  if (-not (Test-Path (Join-Path $outFull "index.html"))) {
    throw "출력 위치에 이미 다른 내용이 있습니다(전달용 폴더가 아님): $outFull"
  }
  Remove-Item -Recurse -Force -Confirm:$false $outFull
}
New-Item -ItemType Directory -Force $outFull | Out-Null

foreach ($item in $items) {
  Copy-Item -Recurse -Force (Join-Path $src $item) (Join-Path $outFull $item)
}

$files = Get-ChildItem -Recurse -File $outFull
$sizeMb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 2)
Write-Host "전달용 폴더를 만들었습니다: $outFull"
Write-Host ("파일 {0}개, {1} MB" -f $files.Count, $sizeMb)
Write-Host "이 폴더의 내용을 서버의 wwwroot에 덮어쓴 뒤, 브라우저에서 Ctrl+F5로 확인하세요."
