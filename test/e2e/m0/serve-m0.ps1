# Clean-VM smoke-test helper (no admin rights needed): serves the folder this
# script sits in at http://127.0.0.1:18080/ so that
#   - the 0.0.1 client's updater finds latest.json and the 0.0.2 installer;
#   - Chrome and Firefox can open the spike page at /web/index.html.
# HttpListener would need a URL reservation for this prefix, so a plain TcpListener is used.
param([int]$Port = 18080)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$types = @{ ".json" = "application/json"; ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript";
            ".css" = "text/css"; ".exe" = "application/octet-stream"; ".sig" = "text/plain" }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "serving $root at http://127.0.0.1:$Port/  (Ctrl+C to stop)"
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
      $requestLine = $reader.ReadLine()
      while (($line = $reader.ReadLine()) -ne $null -and $line -ne "") { }
      $path = ($requestLine -split " ")[1]
      if ($null -eq $path) { continue }
      $relative = [System.Uri]::UnescapeDataString(($path -split "\?")[0]).TrimStart("/")
      $file = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $relative))
      if (-not $file.StartsWith($root) -or -not [System.IO.File]::Exists($file)) {
        $body = [System.Text.Encoding]::ASCII.GetBytes("not found")
        $head = "HTTP/1.1 404 Not Found`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($head); $stream.Write($bytes, 0, $bytes.Length); $stream.Write($body, 0, $body.Length)
        Write-Host "404 $path"
        continue
      }
      $type = $types[[System.IO.Path]::GetExtension($file)]; if ($null -eq $type) { $type = "application/octet-stream" }
      $size = (Get-Item -LiteralPath $file).Length
      $head = "HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $size`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      $bytes = [System.Text.Encoding]::ASCII.GetBytes($head); $stream.Write($bytes, 0, $bytes.Length)
      $fs = [System.IO.File]::OpenRead($file); try { $fs.CopyTo($stream) } finally { $fs.Dispose() }
      Write-Host "200 $path ($size bytes)"
    } catch {
      Write-Host "error: $($_.Exception.Message)"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
