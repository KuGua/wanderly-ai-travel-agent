export class TravelApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly error: string,
    public readonly correlationId: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TravelApiError";
  }

  get isUnauthorized(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof TravelApiError) {
    return error.isUnauthorized
      ? "This demo identity cannot access the requested data."
      : error.message;
  }

  return "Something went wrong. Please try again.";
}
