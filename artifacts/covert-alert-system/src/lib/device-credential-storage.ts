/**
 * This browser's enrolled device credential: where it lives and how the
 * console asks for it.
 *
 * Each console browser exchanges the shared enrollment credential (the
 * server's CAS_ALERT_TOKEN secret) for its own revocable device credential.
 * The enrollment credential itself is never stored anywhere; only the issued
 * device token is kept, and where it is kept is the operator's explicit
 * choice at enrollment time:
 *
 *   - default (unchecked): sessionStorage — the credential dies with the
 *     tab/browser session, exactly the historical behavior;
 *   - "keep this browser signed in" (opt-in): localStorage — the credential
 *     survives tab closes and browser restarts until the operator signs out
 *     or the credential is revoked server-side from the device-credentials
 *     management panel.
 *
 * The same key is used in both storages and a write always clears the other
 * side, so a browser holds at most one copy. A revoked/lost credential is
 * cleared from both.
 */

export const DEVICE_TOKEN_KEY = 'cas-device-token';

function sessionStore(): Storage | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

function localStore(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/**
 * The stored device token, or null when this browser has not enrolled (or
 * was signed out / revoked). The session copy wins when both exist: a token
 * stored this session is the more recent enrollment decision. Read-only —
 * unlike the enrollment flow this never asks the operator, so polling
 * surfaces can wait for the credential instead of opening the dialog.
 */
export function readStoredDeviceToken(): string | null {
  return sessionStore()?.getItem(DEVICE_TOKEN_KEY) ?? localStore()?.getItem(DEVICE_TOKEN_KEY) ?? null;
}

/**
 * Stores a freshly issued device token. keepSignedIn=true pins it to this
 * browser (localStorage); false keeps it for this session only. The other
 * storage is always cleared so the two never drift apart.
 */
export function storeDeviceToken(token: string, keepSignedIn: boolean): void {
  if (keepSignedIn) {
    localStore()?.setItem(DEVICE_TOKEN_KEY, token);
    sessionStore()?.removeItem(DEVICE_TOKEN_KEY);
  } else {
    sessionStore()?.setItem(DEVICE_TOKEN_KEY, token);
    localStore()?.removeItem(DEVICE_TOKEN_KEY);
  }
}

/**
 * Drops the device token from both storages: sign-out, and the 401 path
 * when the server reports the credential revoked or unknown.
 */
export function clearStoredDeviceToken(): void {
  sessionStore()?.removeItem(DEVICE_TOKEN_KEY);
  localStore()?.removeItem(DEVICE_TOKEN_KEY);
}

/**
 * What the operator submitted through the in-app enrollment dialog.
 * `keepSignedIn` is the explicit, unchecked-by-default opt-in.
 */
export type DeviceEnrollmentSubmission = {
  credential: string;
  keepSignedIn: boolean;
};

/**
 * Performs the enrollment exchange for one dialog submission. Returns null
 * when a device token was issued and stored, or the human-readable rejection
 * to show inline (the dialog stays open so the operator can retry). The
 * dialog never closes on its own between submit and exchange outcome, so a
 * signed-out console is never re-exposed while authentication is in flight.
 */
export type DeviceEnrollmentExchange = (submission: DeviceEnrollmentSubmission) => Promise<string | null>;

/**
 * Opens the enrollment dialog and resolves true when a credential was
 * enrolled, false when the operator cancelled (which locks the console,
 * never falls back to demo data).
 */
export type DeviceEnrollmentPrompt = (exchange: DeviceEnrollmentExchange) => Promise<boolean>;

let activePrompt: DeviceEnrollmentPrompt | null = null;

/**
 * Mounted once by the enrollment dialog. Returns the unregister function.
 * While nothing is registered (unit tests, non-UI callers) the enrollment
 * flow refuses to proceed — there is no silent fallback to native prompts
 * or automatic re-enrollment.
 */
export function registerDeviceEnrollmentPrompt(prompt: DeviceEnrollmentPrompt): () => void {
  activePrompt = prompt;
  return () => {
    if (activePrompt === prompt) activePrompt = null;
  };
}

/** Null when no enrollment dialog is mounted in this runtime. */
export function requestDeviceEnrollment(exchange: DeviceEnrollmentExchange): Promise<boolean> | null {
  return activePrompt ? activePrompt(exchange) : null;
}
