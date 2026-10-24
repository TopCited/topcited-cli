# TopCited CLI installer for Windows.
#
#   irm https://topcited.ai/install.ps1 | iex
#
# Downloads the release binary from GitHub Releases, verifies its SHA-256
# against the release's SHA256SUMS, installs it to %LOCALAPPDATA%\topcited\bin
# and adds that folder to the user's PATH.
#
# Environment:
#   TOPCITED_VERSION        release tag to install (default: latest), e.g. v0.1.0
#   TOPCITED_INSTALL_DIR    install directory (default: %LOCALAPPDATA%\topcited\bin)
#   TOPCITED_DOWNLOAD_BASE  override the download base URL (mirrors, tests)
#
# Runs under `iex`, so it never calls `exit` (that would close the caller's
# shell): failures throw instead.

$ErrorActionPreference = 'Stop'
# Older Windows PowerShell defaults to TLS 1.0, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Install-Topcited {
    $repo = 'TopCited/topcited-cli'
    $onWindows = $env:OS -eq 'Windows_NT'

    # ARM64 Windows runs the x64 build through emulation; there is no native arm64 build yet.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($onWindows -and $arch -notin @('AMD64', 'ARM64')) {
        throw "topcited: unsupported architecture '$arch' (needs 64-bit Windows)"
    }
    if ($arch -eq 'ARM64') { Write-Host 'Note: installing the x64 build; it runs under emulation on ARM64.' }
    $asset = 'topcited-windows-x64.exe'

    $base = if ($env:TOPCITED_DOWNLOAD_BASE) { $env:TOPCITED_DOWNLOAD_BASE.TrimEnd('/') }
            elseif ($env:TOPCITED_VERSION) { "https://github.com/$repo/releases/download/$($env:TOPCITED_VERSION)" }
            else { "https://github.com/$repo/releases/latest/download" }

    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/share' }
    $installDir = if ($env:TOPCITED_INSTALL_DIR) { $env:TOPCITED_INSTALL_DIR } else { Join-Path $localAppData 'topcited\bin' }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("topcited-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Write-Host "Downloading $asset ..."
        $exe = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'SHA256SUMS'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $exe
            Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
        } catch {
            throw "topcited: download failed from $base ($($_.Exception.Message))"
        }

        $expected = $null
        foreach ($line in Get-Content $sums) {
            $parts = $line.Trim() -split '\s+'
            if ($parts.Count -eq 2 -and $parts[1] -eq $asset) { $expected = $parts[0].ToLowerInvariant() }
        }
        if (-not $expected) { throw "topcited: no checksum for $asset in SHA256SUMS" }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "topcited: checksum mismatch for $asset (expected $expected, got $actual)" }

        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        $target = Join-Path $installDir 'topcited.exe'
        # A running topcited.exe can't be overwritten, but it can be renamed aside.
        if (Test-Path $target) { Move-Item -Force $target "$target.old" }
        Move-Item -Force $exe $target
        Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue
        Write-Host "Installed topcited to $target"
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    if ($onWindows) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $entries = if ($userPath) { $userPath -split ';' } else { @() }
        if ($entries -notcontains $installDir) {
            $newPath = (@($entries | Where-Object { $_ }) + $installDir) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Write-Host "Added $installDir to your user PATH (open a new terminal to pick it up)."
        }
        if (($env:Path -split ';') -notcontains $installDir) { $env:Path = "$env:Path;$installDir" }
    }
    Write-Host ''
    Write-Host 'Next: topcited auth login'
}

Install-Topcited
