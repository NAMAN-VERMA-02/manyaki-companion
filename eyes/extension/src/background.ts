// Background (service worker in Chrome, event page in Firefox): only opens the panel. The agent itself
// runs in the panel page, which has a DOM and WebGPU for the vision models.

const api = chrome as typeof chrome & { sidebarAction?: { open(): Promise<void> } }

if (api.sidePanel?.setPanelBehavior) {
  void api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)
} else {
  // Firefox: the toolbar button opens the sidebar (a user gesture, as Firefox requires).
  chrome.action.onClicked.addListener(() => { void api.sidebarAction?.open() })
}
