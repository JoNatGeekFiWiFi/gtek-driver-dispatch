# Driver App — Native Builds (Capacitor)

The driver app ships two ways from one codebase:

- **PWA** (already live): drivers open the site, "Add to Home Screen". GPS
  works while the app is open.
- **Native iOS/Android** (this guide): real installed app with **background
  GPS** — tracking continues with the screen off or the app backgrounded,
  which is what you want for a working fleet.

The native projects live in `web/android/` and `web/ios/` and load the same
built web app. Location access goes through `web/src/geo.js`, which picks the
native background-geolocation plugin inside the app and browser geolocation
everywhere else — no other code differs between the PWA and the native app.

## Prerequisites

- **Deployed server over HTTPS.** The native app bundles the UI but talks to
  your live API. Deploy the platform somewhere first (any Node host works:
  `npm run build && npm start`).
- Android: Android Studio (bundles the SDK).
- iOS: a Mac with Xcode + CocoaPods (`sudo gem install cocoapods`), and an
  Apple Developer account to run on real devices.

## Build

All commands run from `web/`:

```bash
# 1. Build the web bundle pointed at your live server
VITE_API_BASE=https://your-server.example.com npm run build

# 2. Copy it into the native projects
npx cap sync

# 3. Open the native IDE to run on a device
npx cap open android   # Android Studio → Run
npx cap open ios       # Xcode → set your signing team → Run
```

Repeat 1–2 whenever the web app changes; the native shells rarely need touching.

## What's already configured

- `capacitor.config.json` — app id `com.dispatchroutebuilder.driver`, name
  "Dispatch Driver".
- **Android** (`android/app/src/main/AndroidManifest.xml`): fine/coarse/
  background location, foreground-service, and notification permissions.
  While tracking, Android shows a persistent notification ("On route —
  location sharing active") — that's an OS requirement for background GPS,
  and honestly a feature: drivers always know when they're visible.
- **iOS** (`ios/App/App/Info.plist`): location usage descriptions and the
  `location` background mode. iOS will prompt the driver to allow "Always"
  access; "While Using" still works but stops updating when the app is
  backgrounded for a while.

## Local testing against the dev server (verified working)

Both platforms were tested end-to-end against the local dev server, full chain:
login → assigned route on the map → native background tracking → GPS delivered
to the dispatch server with on/off-route detection → live marker on the
dispatcher dashboard.

- **Android**: Pixel 7 profile, Android 35 google_apis emulator image.
- **iOS**: iPhone 17 simulator, iOS 26.5. Built via SPM with
  `xcodebuild ... -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO` (simulator
  builds need no signing team). The custom Info.plist permission string shows
  correctly in the iOS location prompt. GPS fed via
  `xcrun simctl location <udid> set <lat>,<lng>`. Note: the driver map
  recenters only on the FIRST fix, and the simulator's default location may
  arrive before yours — on a real device the first fix is the true location,
  so this is simulator-only.

Notes from the Android setup:

- `capacitor.config.json` currently sets `server.androidScheme: "http"` so the
  app (served from `http://localhost`) may call a plain-HTTP dev API without a
  mixed-content block. Fine to keep — production APIs are HTTPS and unaffected.
  A debug-only manifest overlay (`android/app/src/debug/AndroidManifest.xml`)
  allows cleartext; release builds remain HTTPS-only.
- Emulators reach your machine at `http://10.0.2.2:<port>`; build with
  `VITE_API_BASE=http://10.0.2.2:4000` for emulator testing. Physical phones
  on your Wi-Fi use your Mac's LAN IP instead.
- The location plugin requires **Google Play services** — use a "Google APIs"
  emulator image, not AOSP.
- Set the emulator GPS via Extended Controls → Location (or `adb emu geo fix
  <lng> <lat>`); fixes can lag a few seconds behind.

## Behavior notes

- The driver taps **Share location** (or **Start route**, which turns it on) —
  tracking never starts silently.
- Stopping the route or tapping **Stop sharing** removes the watcher and the
  Android notification.
- The banner in the app says "keeps tracking with screen off" only when
  running natively, so drivers on the PWA aren't misled.

## Store submission (when you're ready)

- Both stores scrutinize background location. Approval hinges on: an obvious
  in-app reason (fleet dispatch tracking qualifies), the permission prompts
  explaining it (already written), and a privacy policy URL describing what
  location data is collected and who sees it.
- Google Play additionally requires a short declaration video showing the
  feature in use.
