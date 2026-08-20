export class DcNotFoundError extends Error {
  readonly code = "date_companion_not_found";
}

export class DcVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(readonly currentVersion: number) {
    super("Date Companion resource version is stale");
  }
}

export class DcConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DcValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DcRetryableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
