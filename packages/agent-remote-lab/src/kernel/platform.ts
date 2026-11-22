/**
 * Whether the page runs on an Apple system (macOS, iPadOS or iOS), where Command takes the role Control has
 * elsewhere in keyboard shortcuts.
 */
export function applePlatform() {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}
