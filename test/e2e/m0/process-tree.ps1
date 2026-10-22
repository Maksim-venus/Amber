# Clean-VM orphan check: lists the sidecar's process tree by walking
# ParentProcessId from the sidecar root PID. Matching by process name is deliberately
# avoided so the user's own node / ffmpeg processes are never counted or touched.
# A child keeps its ParentProcessId after the parent dies, so orphans still show up here.
param([Parameter(Mandatory = $true)][int]$RootPid)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate
$tree = [System.Collections.Generic.List[object]]::new()
$root = $all | Where-Object { $_.ProcessId -eq $RootPid }
if ($root) { $tree.Add($root) }
$frontier = @($RootPid)
while ($frontier.Count -gt 0) {
  $children = @($all | Where-Object { $frontier -contains $_.ParentProcessId -and $_.ProcessId -ne $_.ParentProcessId })
  foreach ($child in $children) { $tree.Add($child) }
  $frontier = @($children | ForEach-Object { $_.ProcessId })
}
Write-Host ("sidecar root PID {0}: {1} live process(es) in its tree" -f $RootPid, $tree.Count)
$tree | Format-Table ProcessId, ParentProcessId, Name, CreationDate -AutoSize | Out-String | Write-Host
