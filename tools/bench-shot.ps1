# Headless screenshot of a scene in the Riposte bench (server must be running on :5720).
# Usage: & tools\bench-shot.ps1 -Scene FIE_2026_HD_LiveScore_normal -Frame 40 -Out shot.png
#        [-Set FIE_2026] [-Data '{"_priority":"L"}'] [-Play]
param(
    [Parameter(Mandatory)] [string]$Scene,
    [int]$Frame = 0,
    [Parameter(Mandatory)] [string]$Out,
    [string]$Set = 'FIE_2026',
    [string]$Data = '',
    [switch]$Play
)

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) { throw 'msedge.exe not found' }

$url = "http://localhost:5720/?set=$([uri]::EscapeDataString($Set))&scene=$([uri]::EscapeDataString($Scene))&frame=$Frame"
if ($Data) { $url += "&data=$([uri]::EscapeDataString($Data))" }
if ($Play) { $url += '&play=1' }

# virtual-time budget must outlast the bench's asset preload (see caspar-studio notes)
& $edge --headless --disable-gpu --window-size=1920,1080 --virtual-time-budget=8000 --screenshot="$Out" $url 2>$null | Out-Null
if (-not (Test-Path $Out)) { throw "screenshot not written: $Out" }
(Get-Item $Out).FullName
