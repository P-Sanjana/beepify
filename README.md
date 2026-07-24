# Beepify 🎵

> Your editor drops a beat every time your tests run.

**Beepify** is a VS Code extension that dynamically switches your editor theme and plays a sound based on your test results — errors, warnings and clean passes each have their own distinct beat.

## How It Works

Run any test command in the integrated terminal. Beepify listens for the result and reacts instantly:

| Result | Theme | Sound |
|--------|-------|-------|
| 😌 **Clean** | Calm green — startup default / all tests passed | Clean sound |
| ⚠️ **Warning** | Amber/orange — warnings detected | Warning sound |
| 😡 **Error** | Deep red — tests failed | Error sound |

## Supported Test Runners

Works with **any** test runner across **12+ languages** — Jest, pytest, cargo test, go test, dotnet test, RSpec, PHPUnit, mix test and more. No configuration needed.

## Usage

The extension activates automatically. Look for the 🎵 indicator in the status bar.

- **Click the status bar** to toggle mute
- **`Ctrl/Cmd+Alt+M`** to toggle mute

### Commands

| Command | Description |
|---------|-------------|
| `Beepify: Toggle Auto Theme On/Off` | Enable/disable automatic switching |
| `Beepify: Show Status` | See current mood + diagnostic counts |
| `Beepify: Toggle Mute` | Mute/unmute sounds |
| `Beepify: Customise Mood Colors` | Set custom background & accent per mood |
| `Beepify: Reset Custom Colors` | Restore default mood colors |

## Configuration

```json
{
  "beepify.enabled": true,
  "beepify.errorThreshold": 1,
  "beepify.warningThreshold": 5,
  "beepify.soundEnabled": true,
  "beepify.soundVolume": 80
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `beepify.enabled` | `true` | Enable/disable auto theme switching |
| `beepify.errorThreshold` | `1` | Errors before switching to Error mood |
| `beepify.warningThreshold` | `5` | Warnings before switching to Warning mood |
| `beepify.soundEnabled` | `true` | Play sounds on mood change |
| `beepify.soundVolume` | `80` | Volume 0–100 (macOS/Linux only) |

## Tips

- Set `beepify.errorThreshold` to `3` if you only want the red theme on significant errors
- `Ctrl/Cmd+Alt+M` is the fastest way to mute during a meeting
