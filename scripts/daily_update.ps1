<#
    qtrade daily market data update.

    Runs after the A-share close:
      1. refresh the instrument master
      2. incremental daily bars for every active symbol (through today)
      3. today's 1-minute snapshot
      4. load the recent window into PostgreSQL (live_* snapshots)

    Registered by Task Scheduler as "qtrade daily update" at 17:30.
    Logs: <repo>\logs\daily_update_YYYYMMDD.log
#>
param(
    [int]$Workers = 8,
    [double]$Rate = 0.02,
    [int]$LoadSinceDays = 7
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root "python\.venv\Scripts\python.exe"
$data = Join-Path $root "data"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd"
$log = Join-Path $logDir ("daily_update_{0}.log" -f $stamp)
$env:PYTHONPATH = Join-Path $root "python\src"
$dsn = if ($env:QTRADE_DATABASE_URL) { $env:QTRADE_DATABASE_URL } else { "postgresql://qtrade:qtrade@localhost:15432/qtrade" }

function Write-Log([string]$message) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Write-Output $line
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Invoke-Step([string]$name, [string[]]$arguments) {
    Write-Log "START $name"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $python @arguments 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    foreach ($line in $output) { Write-Log "  $line" }
    if ($code -ne 0) { throw "$name failed with exit code $code" }
    Write-Log "DONE $name"
}

try {
    Write-Log "daily update started (workers=$Workers rate=$Rate)"

    Invoke-Step "instruments" @(
        "-m", "qtrade_research.data.cli", "instruments", "--out", $data, "--json"
    )

    $latest = Get-ChildItem (Join-Path $data "instruments") -Directory | Sort-Object Name | Select-Object -Last 1
    if (-not $latest) { throw "no instrument snapshot found" }
    $symbolsFile = Join-Path $logDir "universe.txt"
    Import-Csv (Join-Path $latest.FullName "instruments.csv") |
        Where-Object { $_.is_active -eq "True" } |
        ForEach-Object { $_.symbol } |
        Set-Content -LiteralPath $symbolsFile -Encoding ASCII
    Write-Log "universe: $((Get-Content $symbolsFile).Count) active symbols"

    Invoke-Step "daily bars" @(
        "-m", "qtrade_research.data.cli", "daily",
        "--universe-file", $symbolsFile,
        "--start", "2020-01-01", "--incremental",
        "--workers", "$Workers", "--rate", "$Rate",
        "--quiet", "--json", "--out", $data
    )

    Invoke-Step "minute snapshot" @(
        "-m", "qtrade_research.data.cli", "minute",
        "--source", "eastmoney", "--universe-file", $symbolsFile,
        "--interval", "1", "--today", "--incremental",
        "--workers", "$Workers", "--rate", "$Rate",
        "--quiet", "--json", "--out", $data
    )

    $since = (Get-Date).AddDays(-1 * $LoadSinceDays).ToString("yyyy-MM-dd")
    Invoke-Step "load postgres" @(
        "-m", "qtrade_research.data.cli", "load-postgres",
        "--dataset", "all", "--intervals", "1,5", "--since", $since,
        "--dsn", $dsn, "--json", "--out", $data
    )

    Invoke-Step "export console data" @(
        "-m", "qtrade_research.data.cli", "export-ui",
        "--dsn", $dsn, "--json", "--out", $data
    )

    Write-Log "daily update finished"
    exit 0
}
catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    exit 1
}
