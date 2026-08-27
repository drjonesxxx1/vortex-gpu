# =====================================================================
#  VORTEX_GPU — Windows Host Node Agent (v2 — provisioning-capable)
#  Author: drjones | Target: Windows 11 (RTX 4070/4080/4080S)
#
#  Responsibilities:
#   - Register this GPU box + stream nvidia-smi telemetry every N sec.
#   - Poll the gateway for jobs:
#       * shell             : run an arbitrary cmd, return stdout
#       * provision_comfyui : clone/launch an ISOLATED ComfyUI instance on a
#                             dedicated port + dedicated user/output/input dir.
#                             Tenant sees a clean private machine — the physical
#                             GPU is shared and hidden.
#       * destroy_instance  : kill the ComfyUI process for an instance.
#
#  Isolation model: one shared ComfyUI codebase, N isolated data dirs.
#   Each instance gets its own --user-directory / --output-directory /
#   --input-directory and its own port, so settings, models, and outputs
#   never cross tenant boundaries.
#
#  USAGE:  powershell -ExecutionPolicy Bypass -File vortex-node-agent.ps1
# =====================================================================

param(
    [string]$GatewayUrl = "http://10.30.20.127:3000",
    [string]$NodeSecret = $env:VORTEX_NODE_SECRET,
    [int]$IntervalSeconds = 5,
    [string]$PythonExe = "python"
)

$ErrorActionPreference = "SilentlyContinue"
$HostName = $env:COMPUTERNAME
$VORTEX_ROOT = "C:\vortex"
$COMFY_BASE  = Join-Path $VORTEX_ROOT "comfyui-base"
$INST_DIR    = Join-Path $VORTEX_ROOT "instances"

# Instance PID tracking: instanceId -> PID (also written to a pid file per instance)
$script:InstancePids = @{}

function Get-GpuInfo {
    $csv = & nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null
    if (-not $csv) { return $null }
    $parts = ($csv -join ",") -split ",\s*"
    return @{
        gpuModel      = $parts[0].Trim()
        driverVersion = $parts[1].Trim()
        memTotalMb    = [int]$parts[2]
        memUsedMb     = [int]$parts[3]
        gpuUtilPct    = [int]$parts[4]
        tempC         = [int]$parts[5]
    }
}

function Get-CpuUtil {
    $cpu = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average
    return [int]($cpu.Average)
}

function Get-RamInfo {
    $os = Get-CimInstance Win32_OperatingSystem
    $totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $freeGb  = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    return @{ totalGb = $totalGb; usedGb = [math]::Round($totalGb - $freeGb, 1) }
}

function Invoke-Gateway {
    param($Method, $Path, $Body)
    $headers = @{ "X-Node-Secret" = $NodeSecret }
    $params = @{ Uri = "$GatewayUrl$Path"; Method = $Method; Headers = $headers; TimeoutSec = 60 }
    if ($Body) {
        $params.ContentType = "application/json"
        $params.Body = ($Body | ConvertTo-Json -Compress -Depth 10)
    }
    return Invoke-RestMethod @params
}

# ---------------------------------------------------------------------
# COMFYUI PROVISIONING
# ---------------------------------------------------------------------
function Ensure-ComfyBase {
    # One-time: clone ComfyUI (STABLE tag) + install torch (CUDA) into the shared base.
    # Pin to a stable release — `main` tracks bleeding-edge comfy_kitchen which
    # requires torch>=2.7. v0.9.x + torch 2.7.1+cu124 is the known-good combo.
    if (Test-Path (Join-Path $COMFY_BASE "ComfyUI\main.py")) {
        return $true
    }
    Write-Host "[VortexGPU] Bootstrapping ComfyUI base (one-time)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $VORTEX_ROOT | Out-Null
    if (-not (Test-Path (Join-Path $COMFY_BASE "ComfyUI"))) {
        git clone --depth 1 --branch v0.9.2 https://github.com/comfyanonymous/ComfyUI.git (Join-Path $COMFY_BASE "ComfyUI") 2>&1 | Out-Null
    }
    $comfyDir = Join-Path $COMFY_BASE "ComfyUI"
    if (-not (Test-Path (Join-Path $comfyDir "main.py"))) {
        return $false
    }
    # venv + torch (CUDA 12.4) — heavy, one-time. torch 2.6.0 is the latest on
    # the cu124 index; v0.9.x works with it. Do NOT install comfy_kitchen (main-only).
    $venvPy = Join-Path $COMFY_BASE "venv\Scripts\python.exe"
    if (-not (Test-Path $venvPy)) {
        & $PythonExe -m venv (Join-Path $COMFY_BASE "venv") 2>&1 | Out-Null
        & $venvPy -m pip install --upgrade pip 2>&1 | Out-Null
        & $venvPy -m pip install torch==2.6.0 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 2>&1 | Out-Null
        & $venvPy -m pip install -r (Join-Path $comfyDir "requirements.txt") 2>&1 | Out-Null
    }
    return (Test-Path $venvPy)
}

function Start-ComfyInstance {
    param($instanceId, $port, $userDir)
    New-Item -ItemType Directory -Force -Path $userDir | Out-Null
    foreach ($sub in @("user", "output", "input", "models", "custom_nodes")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $userDir $sub) | Out-Null
    }
    $comfyDir = Join-Path $COMFY_BASE "ComfyUI"
    $venvPy   = Join-Path $COMFY_BASE "venv\Scripts\python.exe"

    # Per-instance: dedicated user/output/input dirs, shared read-only base models.
    $args = @(
        (Join-Path $comfyDir "main.py"),
        "--listen", "0.0.0.0",
        "--port", $port,
        "--user-directory", (Join-Path $userDir "user"),
        "--output-directory", (Join-Path $userDir "output"),
        "--input-directory", (Join-Path $userDir "input")
    )
    $proc = Start-Process -FilePath $venvPy -ArgumentList $args -PassThru -WindowStyle Hidden
    if ($proc) {
        $script:InstancePids[$instanceId] = $proc.Id
        Set-Content -Path (Join-Path $userDir "instance.pid") -Value $proc.Id
        return "launched pid=$($proc.Id) port=$port"
    }
    return "failed to launch"
}

function Stop-ComfyInstance {
    param($instanceId)
    $pidFile = Join-Path $INST_DIR $instanceId "instance.pid"
    $pid = $script:InstancePids[$instanceId]
    if (-not $pid -and (Test-Path $pidFile)) { $pid = [int](Get-Content $pidFile) }
    if ($pid) {
        Stop-Process -Id $pid -Force 2>$null
        $script:InstancePids.Remove($instanceId)
        return "killed pid=$pid"
    }
    return "no pid found"
}

function Handle-Job {
    param($job)
    Write-Host "[VortexGPU] Job $($job.id) kind=$($job.kind)" -ForegroundColor Cyan
    $ok = $false
    $result = ""
    switch ($job.kind) {
        "shell" {
            $result = cmd /c $job.command 2>&1 | Out-String
            $ok = ($LASTEXITCODE -eq 0) -or ($LASTEXITCODE -eq $null)
        }
        "hashcat" {
            # hashcat job: $job.payload has target + hash; run against local GPU
            $result = cmd /c $job.command 2>&1 | Out-String
            $ok = ($LASTEXITCODE -eq 0) -or ($LASTEXITCODE -eq $null)
        }
        "comfyui" {
            $result = cmd /c $job.command 2>&1 | Out-String
            $ok = ($LASTEXITCODE -eq 0) -or ($LASTEXITCODE -eq $null)
        }
        "provision_comfyui" {
            $ok = Ensure-ComfyBase
            if ($ok) {
                $result = Start-ComfyInstance -instanceId $job.payload.instanceId -port $job.payload.port -userDir $job.payload.userDir
                $ok = $result -like "launched*"
            } else {
                $result = "ComfyUI base bootstrap failed (check git/python/torch install)"
            }
        }
        "destroy_instance" {
            $result = Stop-ComfyInstance -instanceId $job.payload.instanceId
            $ok = $true
        }
        default {
            $result = "unknown job kind"
        }
    }
    try {
        Invoke-Gateway "POST" "/api/node/jobs/$($job.id)/result" @{ ok = $ok; result = $result } | Out-Null
    } catch {
        Write-Host "[VortexGPU] result post failed: $_" -ForegroundColor DarkYellow
    }
}

# ---------------------------------------------------------------------
# REGISTER
# ---------------------------------------------------------------------
Write-Host "[VortexGPU] Registering node '$HostName' with $GatewayUrl ..." -ForegroundColor Cyan
$gpu = Get-GpuInfo
$ram = Get-RamInfo
try {
    Invoke-Gateway "POST" "/api/node/register" @{
        hostname = $HostName; gpuModel = $gpu.gpuModel; driverVersion = $gpu.driverVersion
        memTotalMb = $gpu.memTotalMb; ramTotalGb = $ram.totalGb
    } | Out-Null
    Write-Host "[VortexGPU] Registered. GPU: $($gpu.gpuModel)" -ForegroundColor Green
} catch {
    Write-Host "[VortexGPU] register failed: $_" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------
# MAIN LOOP
# ---------------------------------------------------------------------
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Write-Host "[VortexGPU] Agent active." -ForegroundColor Green

while ($true) {
    # telemetry
    $gpu = Get-GpuInfo
    $ram = Get-RamInfo
    $cpu = Get-CpuUtil
    $uptime = [int]((Get-Date) - $boot).TotalSeconds
    try {
        Invoke-Gateway "POST" "/api/node/report" @{
            hostname = $HostName; gpuModel = $gpu.gpuModel; driverVersion = $gpu.driverVersion
            memTotalMb = $gpu.memTotalMb; memUsedMb = $gpu.memUsedMb; gpuUtilPct = $gpu.gpuUtilPct
            tempC = $gpu.tempC; cpuUtilPct = $cpu; ramTotalGb = $ram.totalGb
            ramUsedGb = $ram.usedGb; uptimeSec = $uptime
        } | Out-Null
    } catch {
        Write-Host "[VortexGPU] heartbeat dropped: $_" -ForegroundColor DarkYellow
    }

    # jobs
    try {
        $resp = Invoke-Gateway "GET" "/api/node/jobs?hostname=$HostName" $null
        foreach ($job in $resp.jobs) {
            Handle-Job -job $job
        }
    } catch {}

    Start-Sleep -Seconds $IntervalSeconds
}

# schtasks install:
# schtasks /Create /TN "VortexGPU Node Agent" /TR "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\vortex\vortex-node-agent.ps1" /SC ONLOGON /RL HIGHEST /F
