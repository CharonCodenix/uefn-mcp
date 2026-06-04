import { execFile } from "node:child_process";

export async function focusUefnEditor(enabled = true) {
  if (!enabled) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (process.platform !== "win32") {
    return { ok: false, skipped: true, reason: `unsupported_platform:${process.platform}` };
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UefnMcpWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$process = Get-Process -Name UnrealEditorFortnite-Win64-Shipping -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $process) { throw "UEFN process with a main window was not found." }
[UefnMcpWin32]::ShowWindowAsync($process.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 150
$focused = [UefnMcpWin32]::SetForegroundWindow($process.MainWindowHandle)
[pscustomobject]@{ ok = [bool]$focused; processId = $process.Id; windowTitle = $process.MainWindowTitle } | ConvertTo-Json -Compress
`;

  return await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: error.message,
            stderr: stderr.trim() || null
          });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ ok: false, error: "Could not parse focus helper output.", stdout: stdout.trim() });
        }
      }
    );
  });
}
