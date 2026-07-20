// One location API for both worlds:
// - Browser/PWA: navigator.geolocation (works while the page is open)
// - Native app (Capacitor): background geolocation plugin — keeps tracking
//   with the screen off or the app in the background, with the OS-required
//   persistent notification on Android.
import { Capacitor, registerPlugin } from '@capacitor/core';

export const isNativeApp = () => Capacitor.isNativePlatform();

// Starts a position watcher; returns { stop() }. onFix receives
// { lat, lng, speed, heading, accuracy }.
export async function watchPosition(onFix, onError) {
  if (isNativeApp()) {
    const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
    const id = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'On route — location sharing active',
        backgroundMessage: 'Dispatch can see your position for safety.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10,
      },
      (loc, err) => {
        if (err) {
          if (err.code === 'NOT_AUTHORIZED') {
            onError?.('Location permission denied — enable it in phone settings to share your position.');
          } else {
            onError?.(err.message || 'Location error');
          }
          return;
        }
        if (loc) {
          onFix({
            lat: loc.latitude,
            lng: loc.longitude,
            speed: loc.speed ?? null,
            heading: loc.bearing ?? null,
            accuracy: loc.accuracy ?? null,
          });
        }
      }
    );
    return { stop: () => BackgroundGeolocation.removeWatcher({ id }) };
  }

  if (!('geolocation' in navigator)) {
    throw new Error('This device does not support GPS location');
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onFix({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        speed: pos.coords.speed,
        heading: pos.coords.heading,
        accuracy: pos.coords.accuracy,
      }),
    (err) => onError?.(err.message || 'Could not get GPS fix — check location permissions'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
  return { stop: () => navigator.geolocation.clearWatch(id) };
}
