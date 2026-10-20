$ErrorActionPreference = 'Stop'
function Get-ContentDigest([string]$filePath) {
    $stream = [System.IO.File]::OpenRead($filePath)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$vendorRoot = Join-Path ${env:ProgramFiles(x86)} 'Rockwell Software\RSView Enterprise'
$registryPaths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$products = @(Get-ItemProperty $registryPaths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'FactoryTalk View (Studio|Machine|ME|Site|SE)' } | ForEach-Object { @{ name=$_.DisplayName; version=$_.DisplayVersion; install_location=$_.InstallLocation } })
$utilities = @{}
foreach ($utility in @('VStudio.exe','ApplicationManager.exe','SEAddComponent.exe','MEExport.exe','MERuntime.exe')) {
    $utilityPath = Join-Path $vendorRoot $utility
    if (Test-Path -LiteralPath $utilityPath -PathType Leaf) {
        $file = Get-Item -LiteralPath $utilityPath
        $utilities[$utility] = @{ path=$file.FullName; file_version=$file.VersionInfo.FileVersion; sha256=(Get-ContentDigest $utilityPath) }
    }
}
$schemaPath = Join-Path $vendorRoot 'Schemas'
$schemas = @(Get-ChildItem -LiteralPath $schemaPath -Filter 'Gfx-ME*.xsd' -ErrorAction SilentlyContinue | ForEach-Object { @{name=$_.Name; path=$_.FullName; sha256=(Get-ContentDigest $_.FullName)} })
$processes = @(Get-Process VStudio -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id; title=$_.MainWindowTitle; active_project_path=$null; identity_verified=$false} })
$helpRoot = Join-Path ${env:ProgramFiles(x86)} 'Common Files\Rockwell\Help'
$help = @(Get-ChildItem -LiteralPath $helpRoot -File -ErrorAction SilentlyContinue | Where-Object {$_.Name -match '^(viewme|viewse|me.*\.chm|se.*\.chm|FTLinx)'} | ForEach-Object {$_.FullName})
@{ platform='win32'; products=$products; utilities=$utilities; schema_dir=$schemaPath; schemas=$schemas; studio_instances=$processes; installed_help=$help; license_status='Inspect Studio/Activation Manager; process title alone is not an activation check'; active_application_coverage='Window caption only; exact saved path requires staged project identity'; native_import='Documented for ME 15+, require matching installed help/registry and local validation receipt'; } | ConvertTo-Json -Depth 8 -Compress
