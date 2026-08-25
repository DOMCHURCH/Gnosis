/** True when this browser can show notifications at all. */
export function canNotify(): boolean;
/** Ask for permission, once, at the moment it becomes meaningful. Never throws. */
export function requestNotifyPermission(): Promise<boolean>;
/** Show a notification. Silently does nothing without permission. */
export function notify(title: string, body: string): void;
/** True when the page is not in front of the user. */
export function pageHidden(): boolean;
