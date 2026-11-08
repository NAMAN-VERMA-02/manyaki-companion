// Defence in depth for private mode. The UI already closes the Gemini connection when private mode is on;
// this makes the main process refuse it too, so a bug in the UI cannot send audio or text to the cloud.
// Hosts that only serve downloads (model files) carry no user data and stay allowed; src/index.html's CSP
// limits where the page can connect at all, and tests/netguard.test.ts pins that list.
const USER_DATA_HOSTS = ['generativelanguage.googleapis.com']

/** True when a request must be cancelled because private mode is on and it would reach a cloud AI service. */
export function blockedInPrivateMode(privateMode: boolean, url: string): boolean {
  if (!privateMode) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return USER_DATA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}
