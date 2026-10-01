/**
 * Maps raw API/probe/server error strings to a calm, plain-language summary
 * plus a concrete next step. The raw string is always kept as `detail` so the
 * person running the server can expand it when the friendly text is not
 * enough. Client-side only: the server contract is unchanged.
 */
export type FriendlyError = {
  headline: string;
  next: string;
  /** The original technical message, shown behind a "details" affordance. */
  detail: string;
};

export function friendlyError(raw: string): FriendlyError {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (/credential|unauthorized|\(401\)/.test(lower)) {
    return {
      headline: "This console's access credential was not accepted.",
      next: 'Unlock the console again with the enrollment credential — the one chosen when the server was set up (kept in the server\u2019s secrets).',
      detail: text,
    };
  }
  if (/failed to fetch|network ?error|unreachable|unable to (load|reach|connect)|econnrefused|timed? ?out/.test(lower)) {
    return {
      headline: 'The console cannot reach the server right now.',
      next: 'Check that the server is running and this device is online, then try again.',
      detail: text,
    };
  }
  if (/not found|\(404\)/.test(lower)) {
    return {
      headline: 'That record could not be found on the server.',
      next: 'It may already have been removed — refresh the page and try again.',
      detail: text,
    };
  }
  if (/conflict|\(409\)/.test(lower)) {
    return {
      headline: 'That change no longer fits the current state of the alert.',
      next: 'Reload the page to see the latest state, then try again.',
      detail: text,
    };
  }
  if (/\(5\d\d\)|internal server/.test(lower)) {
    return {
      headline: 'The server hit an unexpected problem.',
      next: 'Wait a moment and try again. If it keeps happening, share the technical detail with whoever runs the server.',
      detail: text,
    };
  }
  return {
    headline: 'That did not work.',
    next: 'Try again — if it keeps failing, the technical detail below will help whoever runs the server.',
    detail: text,
  };
}

/**
 * Friendly wording for an email connection-test failure classification, so
 * the page can lead with what it means instead of the raw probe error.
 */
export function friendlyEmailTestFailure(classification: string): string {
  switch (classification) {
    case 'authentication':
      return 'The mailbox refused the app password.';
    case 'not-configured':
      return 'No mailbox is configured for this slot yet.';
    case 'rejected':
      return 'The mail provider rejected the login.';
    case 'tls':
      return 'The secure connection to the mail server could not be established.';
    case 'dns':
      return 'The mail server address could not be found.';
    case 'socket-timeout':
      return 'The mail server did not answer in time.';
    default:
      return 'The connection to the mailbox did not succeed.';
  }
}
