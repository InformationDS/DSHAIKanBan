# AIKanBan host-integration probe runner (task-3).
#
#   pwsh -File packages\plugin\src\probe\harness\run-probe.ps1
#
# Boots a SECOND, fully isolated DSH host to collect real host-integration
# evidence. The user's live GUI is never touched:
#
#   * DSH_HOME is <workspace>\.probe-home, so profiles/, sessions/, storages/
#     and the credential store all resolve there and ~/.dsh is not involved;
#   * --profile web --port 0 binds an OS-assigned ephemeral port (never 19387);
#   * --no-open never launches a browser;
#   * the probe plugin calls ctx.appExit(0) when it is done, so the host exits
#     by itself with no orphan process. There is no auto-start.
#
# Stop early: Stop-Process -Id <pid> (the pid is in the report's `host.pid`), or
# Ctrl+C. Deleting .probe-home is always safe — this script rebuilds it.
#
# Launcher flags MUST come before the app's own flags: the dsh launcher hands
# the first token it does not recognize to the booted app, so `--patch` after
# `--port` would be parsed by the Web app and rejected as an unknown option.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Resolve-Path (Join-Path $here '..\..\..\..\..')
$home_ = Join-Path $workspace '.probe-home'
$node = if ($env:DSH_NODE) { $env:DSH_NODE } else { 'C:\Users\InformationDS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' }
$cli = if ($env:DSH_CLI) { $env:DSH_CLI } else { Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js' }

if (-not (Test-Path $node)) { throw "node not found at $node (set DSH_NODE)" }
if (-not (Test-Path $cli)) { throw "dsh CLI not found at $cli (set DSH_CLI)" }

Write-Output "run-probe: workspace $workspace"
Write-Output "run-probe: node      $node"
Write-Output "run-probe: cli       $cli"

& $node (Join-Path $here 'prepare.mjs') $home_
if ($LASTEXITCODE -ne 0) { throw "prepare.mjs failed with exit $LASTEXITCODE" }

$patch = Join-Path $home_ 'probe.patch.yml'
$env:DSH_HOME = $home_
$env:DSH_TELEMETRY_DISABLED = '1'
$env:DSH_TELEMETRY_MODE = 'DISABLED'

Write-Output 'run-probe: booting isolated host (profile web, ephemeral port, no browser)'
& $node $cli --profile web --patch $patch --port 0 --no-open
$code = $LASTEXITCODE
Write-Output "run-probe: exit=$code"
Write-Output "run-probe: report=$(Join-Path $workspace 'packages\plugin\src\probe\evidence\probe-report.json')"
exit $code
