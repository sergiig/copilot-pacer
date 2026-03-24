/** Represents fetched Copilot usage regardless of which API provided it. */
export interface CopilotUsage {
  usedRequests: number;
  monthlyLimit: number;
  /** Start of the current billing period (UTC midnight). */
  periodStart: Date;
  /** End of the current billing period (UTC midnight). */
  periodEnd: Date;
}

export interface PacingResult {
  progressBar: string;
  buffer: number;         // Positive = requests remaining today; negative = overspent
  usedRequests: number;
  monthlyLimit: number;
  overageRequests: number; // Requests exceeding monthlyLimit (0 if within limit)
  overageCost: number;     // Dollar cost for overage requests ($0.04 each)
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** GitHub API returned 401 — the token has expired or been revoked. */
export class TokenExpiredError extends Error {
  constructor() {
    super("GitHub token is invalid or has been revoked (401)");
    this.name = "TokenExpiredError";
  }
}

/** GitHub API returned 404 — the resource (e.g. user) was not found. */
export class NotFoundError extends Error {
  constructor(url: string) {
    super(`GitHub resource not found: ${url}`);
    this.name = "NotFoundError";
  }
}
