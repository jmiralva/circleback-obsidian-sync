/**
 * What went wrong with a Circleback request, in terms the sync code acts on:
 * - `auth`: the key is wrong or revoked.
 * - `forbidden`: the key is fine but may not view this item.
 * - `rate-limited`: still over the rate limit after waiting and retrying.
 * - `timeout`: no response in time.
 * - `network`: the request could not be made (offline, DNS, TLS).
 * - `server`: Circleback failed (5xx).
 * - `invalid-response`: the response was not what the API promises (bad JSON, an
 *   unexpected status, or data that fails validation).
 */
export type CirclebackErrorKind =
  | "auth"
  | "forbidden"
  | "rate-limited"
  | "timeout"
  | "network"
  | "server"
  | "invalid-response";

/** The message is safe to show to the user and never contains the API key. */
export class CirclebackError extends Error {
  readonly kind: CirclebackErrorKind;
  readonly status?: number;

  constructor(kind: CirclebackErrorKind, message: string, status?: number) {
    super(message);
    this.name = "CirclebackError";
    this.kind = kind;
    this.status = status;
  }
}
