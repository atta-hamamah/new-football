# Spot Kick ⚽

Mobile football game with two modes:

- **Penalty Run** (solo roguelike): 8 shootouts from Sunday League to The Final. Read each keeper's habits and body language, pick upgrades after every win, beat two boss keepers. There's also a **Daily Run**, the same seed for everyone, with a shareable result.
- **6v6 Match**: arcade top-down football against the computer (Easy / Normal / Hard) or **with friends on the same Wi-Fi**. Every shot turns into a duel with the keeper: the defender swipes to dive.

Built with TypeScript + PixiJS, packaged for iPhone and Android with Capacitor.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 (use your phone on the same network: http://<computer-ip>:5173)
```

### Wi-Fi play in browsers (development)

Phones use the built-in native Wi-Fi plugin. To try multiplayer in browsers, start the local relay that stands in for it:

```bash
npm run lan-dev        # relay on port 8787
npm run dev            # then open the game in two browsers / devices on the same network
```

## Controls

**Penalty Run**

- Shooting: drag to move the aim, release to shoot. The aim wobbles more near the corners and the longer you hold.
- Keeping: watch the run-up lean, then swipe left / right / up (or tap to stay) when the ball is struck. Keys: `Q W E / A S D`.

**6v6**

- Left thumb: floating joystick. Push past the rim to sprint (you can't turn while sprinting).
- **PASS**: no direction → nearest teammate; direction → nearest that way; pushed to the edge → farthest that way. Without the ball, PASS switches player.
- **SHOOT**: the direction picks the corner; pushed to the edge shoots high. You can't shoot from your own half.
- Shot rules: outside the box the keeper must guess the side (shots down the middle are always saved). Inside the box he must guess side _and_ height. In the six-yard box it always goes in.
- Keyboard: `WASD`/arrows to move, `Shift` to sprint, `J`/`Space` to pass, `K` to shoot.

## Scripts

| Command                   | What it does                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`             | Dev server                                                                           |
| `npm run build`           | Type-check + production web build into `dist/`                                       |
| `npm test`                | Unit tests: duel rules, keepers, run, shootout, 6v6 rules, AI matches, netcode       |
| `npm run test:e2e`        | Playwright: plays a shootout, a match vs computer, and a two-phone Wi-Fi game        |
| `npm run balance`         | Simulates thousands of Penalty Runs with bot players and prints the difficulty curve |
| `npm run lan-dev`         | Wi-Fi stand-in relay for browser multiplayer                                         |
| `npm run lint` / `format` | Prettier                                                                             |

## Phone apps

```bash
npm run build && npx cap sync
npx cap open android   # Android Studio → Run
npx cap open ios       # Xcode (on a Mac) → Run
```

CI builds a debug **APK** on every push. Download it from the run's artifacts (`spot-kick-android-debug-apk`) and install it on an Android phone. iOS is compiled for the simulator in CI. Installing on an iPhone needs a Mac with Xcode, or a cloud build service, plus an Apple Developer account.

## How it's built

```
src/
  duel/      Shot vs keeper rules, keeper/shooter personalities and tells, aim wobble
  run/       Penalty Run: stages, opponents, upgrades, shootout rules, bot players
  penalty/   Penalty Run screens and game flow
  match/     6v6: simulation (60 Hz, authoritative), team AI, controls, view/snapshots
  net/       Wi-Fi: protocol, host, client, transports (native plugin, dev relay, in-memory)
  render/    PixiJS scenes: night-stadium penalty view, top-down pitch
  ui/        Menus, sound (all synthesised with Web Audio), save data
android/, ios/   Native projects; the in-app LanNet plugin lives in
                 android/app/src/main/java/.../LanNetPlugin.java and ios/App/App/LanNetPlugin.swift
```

**Wi-Fi multiplayer design.** The host phone runs the only real simulation. Other phones send their joystick and buttons (5 bytes, up to 60/s) and receive compact snapshots 30 times a second. They draw them about 75 ms behind real time, blended for smoothness. Phones find each other with Bonjour/mDNS (`_spotkick._tcp`), so nobody types IP addresses. Players who leave are handed back to the computer.
