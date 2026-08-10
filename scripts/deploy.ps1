param(
  [ValidateSet("core", "search", "vector", "full")]
  [string]$Mode = "core",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDirectory = Split-Path -Parent $ScriptDirectory
Set-Location $ProjectDirectory

# 所有模式共享核心 Compose 文件，可选能力按参数追加。
$ComposeArguments = @("compose", "--env-file", ".env", "-f", "compose.yaml")
switch ($Mode) {
  "search" { $ComposeArguments += @("-f", "compose.search.yaml") }
  "vector" { $ComposeArguments += @("-f", "compose.vector.yaml") }
  "full" { $ComposeArguments += @("-f", "compose.search.yaml", "-f", "compose.vector.yaml") }
}
$DeployArguments = $ComposeArguments + @("up", "-d", "--build", "--remove-orphans")

if ($DryRun) {
  Write-Output ("docker " + ($DeployArguments -join " "))
  exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "未找到 Docker，请先安装 Docker Desktop。"
}
& docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker Compose v2 不可用。" }
& docker info | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法连接 Docker daemon。" }

# 使用显式 UTF-8 API 读取示例，避免本地 PowerShell 默认编码造成中文损坏。
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Output "已从 .env.example 创建 .env。"
}

if ($Mode -in @("search", "full")) {
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $EnvironmentText = [System.IO.File]::ReadAllText((Join-Path $ProjectDirectory ".env"), [System.Text.Encoding]::UTF8)
  $SecretMatch = [System.Text.RegularExpressions.Regex]::Match($EnvironmentText, "(?m)^SEARXNG_SECRET=(.*)$")
  if (-not $SecretMatch.Success -or [string]::IsNullOrWhiteSpace($SecretMatch.Groups[1].Value)) {
    $RandomBytes = New-Object byte[] 32
    $RandomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $RandomGenerator.GetBytes($RandomBytes)
    } finally {
      $RandomGenerator.Dispose()
    }
    $GeneratedSecret = -join ($RandomBytes | ForEach-Object { $_.ToString("x2") })
    if ($SecretMatch.Success) {
      $EnvironmentText = [System.Text.RegularExpressions.Regex]::Replace(
        $EnvironmentText,
        "(?m)^SEARXNG_SECRET=.*$",
        "SEARXNG_SECRET=$GeneratedSecret",
        1
      )
    } else {
      $EnvironmentText = $EnvironmentText.TrimEnd() + [Environment]::NewLine + "SEARXNG_SECRET=$GeneratedSecret" + [Environment]::NewLine
    }
    [System.IO.File]::WriteAllText((Join-Path $ProjectDirectory ".env"), $EnvironmentText, $Utf8NoBom)
    Write-Output "已为 SearXNG 生成本机部署密钥。"
  }
}

& docker @ComposeArguments config --quiet
if ($LASTEXITCODE -ne 0) { throw "Compose 配置校验失败。" }
& docker @DeployArguments
if ($LASTEXITCODE -ne 0) { throw "Compose 部署失败。" }

$WebContainerId = (& docker @ComposeArguments ps -q bug-paw-web).Trim()
if ([string]::IsNullOrWhiteSpace($WebContainerId)) { throw "未找到 bug-paw-web 容器。" }

for ($HealthAttempt = 0; $HealthAttempt -lt 45; $HealthAttempt++) {
  $WebHealth = (& docker inspect --format "{{.State.Health.Status}}" $WebContainerId 2>$null).Trim()
  if ($WebHealth -eq "healthy") {
    $PublishedEndpoint = (& docker @ComposeArguments port bug-paw-web 7080).Trim()
    $PublishedPort = $PublishedEndpoint.Substring($PublishedEndpoint.LastIndexOf(":") + 1)
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:${PublishedPort}/healthz" | Out-Null
    Write-Output "BugPaw $Mode 部署已通过健康检查。"
    exit 0
  }
  if ($WebHealth -eq "unhealthy") { throw "bug-paw-web 健康检查失败。" }
  Start-Sleep -Seconds 2
}

throw "等待 bug-paw-web 健康状态超时。"
