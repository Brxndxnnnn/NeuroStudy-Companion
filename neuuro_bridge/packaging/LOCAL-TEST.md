# Local install → activate → auto-update test (no server needed)

The full clinic experience on a dev machine, ~5 minutes. Everything below was
already verified headlessly except the GUI steps (install, dialog, update prompt),
which need human clicks.

One-time: `dotnet tool install -g vpk`

```powershell
# 1. Feed folder + mock activation backend
mkdir C:\bridge-feed
python neuuro_bridge\tools\mock_activation_server.py   # leave running; valid code TEST-CODE-0001

# 2. In a second terminal: point the (installed) app at the mock + local feed.
#    setx = persistent user env vars; new processes pick them up.
setx ACTIVATION_URL http://localhost:8765/bridge/activate
setx UPDATE_FEED_URL C:\bridge-feed

# 3. Pack + install v1.0.0
powershell -ExecutionPolicy Bypass -File neuuro_bridge\packaging\pack.ps1 -OutputDir C:\bridge-feed
& C:\bridge-feed\NeuuroBridge-win-Setup.exe
#    SmartScreen: "More info" → "Run anyway" (unsigned for now).
#    → activation dialog appears → enter TEST-CODE-0001 → MainWindow opens.
#    Config lands in %ProgramData%\NeuuroBridge\bridge.env (password/license DPAPI-encrypted).

# 4. Pack v1.0.1 into the same feed, relaunch the installed app (Start menu → NeuuroBridge)
powershell -ExecutionPolicy Bypass -File neuuro_bridge\packaging\pack.ps1 -Version 1.0.1 -OutputDir C:\bridge-feed
#    → update prompt "1.0.1 available" → Yes → app restarts on 1.0.1.
#    Activation is NOT asked again (config store survived the folder swap).
```

Cleanup: uninstall "NeuuroBridge" in Windows Apps settings, delete
`%ProgramData%\NeuuroBridge` + `C:\bridge-feed`, and
`reg delete HKCU\Environment /v ACTIVATION_URL /f` (same for UPDATE_FEED_URL),
then log out/in or reboot so the removed env vars stop applying.

Dev note: running from `bin\` (not installed) skips the update check automatically;
add `ACTIVATION_OPTIONAL=true` to your repo `.env` to also skip the activation
dialog and keep the old .env-based dev flow.
