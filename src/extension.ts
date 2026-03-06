import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let statusBarItem: vscode.StatusBarItem;
let secretStorage: vscode.SecretStorage;

const DEFAULT_MONTHLY_LIMIT = 300;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** GitHub API returned 401 — the token has expired or been revoked. */
class TokenExpiredError extends Error {
  constructor() {
    super("GitHub token is invalid or has been revoked (401)");
    this.name = "TokenExpiredError";
  }
}

/** GitHub API returned 404 — the resource (e.g. user) was not found. */
class NotFoundError extends Error {
  constructor(url: string) {
    super(`GitHub resource not found: ${url}`);
    this.name = "NotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Usage data
// ---------------------------------------------------------------------------

/** Represents fetched Copilot usage regardless of which API provided it. */
interface CopilotUsage {
  usedRequests: number;
  monthlyLimit: number;
  /** Start of the current billing period (UTC midnight). */
  periodStart: Date;
  /** End of the current billing period (UTC midnight). */
  periodEnd: Date;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  console.log("Pacer for GitHub Copilot activated");

  secretStorage = context.secrets;

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  context.subscriptions.push(statusBarItem);

  // Command to securely store the GitHub PAT. The token is kept in VS Code's
  // encrypted SecretStorage and never written to settings or disk in plain text.
  context.subscriptions.push(
    vscode.commands.registerCommand("copilot-pacer.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Enter your GitHub Personal Access Token (requires copilot scope)",
        password: true,
        ignoreFocusOut: true,
      });
      if (token !== undefined) {
        await secretStorage.store("copilot-pacer.githubToken", token);
        updatePacing();
      }
    }),
  );

  // Register a command so the user can manually trigger a refresh from the command palette
  context.subscriptions.push(
    vscode.commands.registerCommand("copilot-pacer.refresh", () => {
      updatePacing();
    }),
  );

  // Clicking the status bar item triggers either setToken (if no token) or refresh.
  // The command is set dynamically inside updatePacing() on each cycle.

  updatePacing();

  // Auto-refresh every 10 minutes
  setInterval(updatePacing, 10 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GITHUB_API_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

/** Maps common HTTP error codes to typed errors. */
function throwOnHttpError(response: Response, url: string): void {
  if (response.ok) { return; }
  if (response.status === 401) { throw new TokenExpiredError(); }
  if (response.status === 404) { throw new NotFoundError(url); }
  throw new Error(`GitHub API ${response.status}: ${url}`);
}

/** Resolves the authenticated user's login name from the GitHub API. */
async function fetchUsername(token: string): Promise<string> {
  const url = "https://api.github.com/user";
  const response = await fetch(url, { headers: GITHUB_API_HEADERS(token) });
  throwOnHttpError(response, url);
  const data = (await response.json()) as any;
  return data.login as string;
}

/**
 * Fetches Copilot usage from the **internal** API (near real-time).
 * Endpoint: GET /copilot_internal/user
 *
 * This is an undocumented GitHub API that returns accurate quota snapshots
 * including `premium_interactions` with remaining/entitlement data and the
 * billing period reset date.
 */
async function fetchCopilotInternal(token: string): Promise<CopilotUsage> {
  const url = "https://api.github.com/copilot_internal/user";
  const response = await fetch(url, { headers: GITHUB_API_HEADERS(token) });
  throwOnHttpError(response, url);

  const data = (await response.json()) as any;
  const premium = data.quota_snapshots?.premium_interactions;
  if (!premium || premium.unlimited) {
    throw new Error("No premium_interactions quota in internal API response");
  }

  const entitlement = premium.entitlement as number;
  const remaining = premium.quota_remaining as number;
  const periodEnd = new Date(data.quota_reset_date_utc);
  const periodStart = new Date(periodEnd);
  periodStart.setUTCMonth(periodStart.getUTCMonth() - 1);

  return {
    usedRequests: entitlement - remaining,
    monthlyLimit: entitlement,
    periodStart,
    periodEnd,
  };
}

/**
 * Fetches Copilot usage from the **billing** API (official, may lag behind).
 * Endpoint: GET /users/{username}/settings/billing/usage/summary
 */
async function fetchCopilotBilling(
  token: string,
  username: string,
  monthlyLimit: number,
): Promise<CopilotUsage> {
  const url =
    `https://api.github.com/users/${username}/settings/billing/usage/summary`;
  const response = await fetch(url, { headers: GITHUB_API_HEADERS(token) });
  throwOnHttpError(response, url);

  const data = (await response.json()) as any;
  const copilotItem = data.usageItems?.find(
    (item: any) => item.sku === "copilot_premium_request",
  );
  const usedRequests = copilotItem ? copilotItem.grossQuantity : 0;

  // Billing API doesn't expose period dates — assume calendar month
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  return { usedRequests, monthlyLimit, periodStart, periodEnd };
}

interface PacingResult {
  progressBar: string;
  buffer: number;         // Positive = requests remaining today; negative = overspent
  usedRequests: number;
  monthlyLimit: number;
}

// Renders a single progress zone as a string of filled/empty block characters.
function renderBlock(
  width: number,
  fillRatio: number,
  fillChar: string,
  emptyChar: string,
): string {
  if (width <= 0) { return ""; }
  const filled = Math.round(Math.max(0, Math.min(width, fillRatio * width)));
  return fillChar.repeat(filled) + emptyChar.repeat(width - filled);
}

// Calculates the lens-style progress bar and daily budget buffer.
//
// Visual layout: [past ▰▱][lens ┃▮▯┃][future ▰▱]
//
// The "lens" magnifies today so you can see intra-day progress precisely while
// the flanking zones compress the rest of the billing period into a fixed
// character width.
function calculatePacing(usage: CopilotUsage): PacingResult {
  const now = new Date();
  const { usedRequests, monthlyLimit, periodStart, periodEnd } = usage;

  const totalMs = periodEnd.getTime() - periodStart.getTime();
  const elapsedMs = Math.max(0, now.getTime() - periodStart.getTime());
  const totalDays = Math.round(totalMs / (24 * 60 * 60 * 1000));
  const elapsedDays = Math.min(totalDays, elapsedMs / (24 * 60 * 60 * 1000));
  const currentDay = Math.min(totalDays, Math.floor(elapsedDays) + 1);

  const OUTSIDE_WIDTH = 12; // Total chars shared between past and future zones
  const LENS_INNER_WIDTH = 5; // Inner width of the lens zone: ┃▮▮▯▯▯┃

  const pastDays = currentDay - 1;
  const totalOutsideDays = totalDays - 1;

  // Distribute the outside character budget proportionally between past and future
  const pastChars =
    totalOutsideDays === 0
      ? 0
      : Math.round((pastDays / totalOutsideDays) * OUTSIDE_WIDTH);
  const futureChars = OUTSIDE_WIDTH - pastChars;

  // Quota boundaries expressed as absolute request counts
  const dailyBudget = monthlyLimit / totalDays;
  const startOfTodayQuota = pastDays * dailyBudget;
  const endOfTodayQuota = currentDay * dailyBudget;

  let pastRatio = 0, lensRatio = 0, futureRatio = 0;

  if (usedRequests < startOfTodayQuota) {
    // Zone 1: Usage is below today's opening quota — ahead of schedule
    pastRatio = startOfTodayQuota === 0 ? 0 : usedRequests / startOfTodayQuota;
  } else if (usedRequests <= endOfTodayQuota) {
    // Zone 2: Usage falls inside today's lens window — on track
    pastRatio = 1;
    lensRatio = (usedRequests - startOfTodayQuota) / dailyBudget;
  } else {
    // Zone 3: Usage has exceeded today's closing quota — borrowing from the future
    pastRatio = 1;
    lensRatio = 1;
    const futureQuota = monthlyLimit - endOfTodayQuota;
    futureRatio =
      futureQuota === 0 ? 1 : (usedRequests - endOfTodayQuota) / futureQuota;
  }

  const pastStr = renderBlock(pastChars, pastRatio, "▰", "▱");
  const lensStr = `┃${renderBlock(LENS_INNER_WIDTH, lensRatio, "▮", "▯")}┃`;
  const futureStr = renderBlock(futureChars, futureRatio, "▰", "▱");

  return {
    progressBar: `${pastStr}${lensStr}${futureStr}`,
    buffer: endOfTodayQuota - usedRequests,
    usedRequests,
    monthlyLimit,
  };
}

// ---------------------------------------------------------------------------
// Status-bar display helpers
// ---------------------------------------------------------------------------

function showPromptForToken(text: string, tooltip: string): void {
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
  statusBarItem.color = undefined;
  statusBarItem.command = "copilot-pacer.setToken";
}

// ---------------------------------------------------------------------------
// Main refresh cycle
// ---------------------------------------------------------------------------

/**
 * Orchestrates: fetch usage → calculate → update UI.
 *
 * Data-source strategy:
 * 1. Try the internal Copilot API first (near real-time, no username needed).
 * 2. If that fails, fall back to the official billing API (may lag behind).
 *
 * Self-healing behaviour:
 * • Invalid / missing token  → prompts user to enter one.
 * • Invalid monthlyLimit     → silently resets to 300 (billing fallback).
 * • Invalid username (404)   → clears cached value, re-resolves, retries.
 * • Token expired (401)      → clears token, prompts for a new one.
 */
async function updatePacing() {
  statusBarItem.text = `$(sync~spin) Pacer...`;
  statusBarItem.show();

  try {
    const token = await secretStorage.get("copilot-pacer.githubToken");

    if (!token) {
      showPromptForToken(
        "$(key) Pacer: No token",
        "Click to set your GitHub Personal Access Token.",
      );
      return;
    }

    // Token is present — clicking the bar triggers a refresh
    statusBarItem.command = "copilot-pacer.refresh";

    // --- Try the internal Copilot API first (near real-time) -----------------
    let usage: CopilotUsage;
    try {
      usage = await fetchCopilotInternal(token);
    } catch (internalError) {
      // Re-throw auth errors immediately — no point trying billing API
      if (internalError instanceof TokenExpiredError) { throw internalError; }

      // Internal API unavailable — fall back to the billing API
      const config = vscode.workspace.getConfiguration("copilot-pacer");

      let monthlyLimit = config.get<number>("monthlyLimit") ?? DEFAULT_MONTHLY_LIMIT;
      if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
        monthlyLimit = DEFAULT_MONTHLY_LIMIT;
        await config.update("monthlyLimit", DEFAULT_MONTHLY_LIMIT, vscode.ConfigurationTarget.Global);
      }

      let username = config.get<string>("username")?.trim();
      if (!username) {
        username = await fetchUsername(token);
        await config.update("username", username, vscode.ConfigurationTarget.Global);
      }

      try {
        usage = await fetchCopilotBilling(token, username, monthlyLimit);
      } catch (billingError) {
        if (billingError instanceof NotFoundError) {
          // Cached username is likely wrong — re-resolve from GitHub
          await config.update("username", undefined, vscode.ConfigurationTarget.Global);
          const freshUsername = await fetchUsername(token);
          await config.update("username", freshUsername, vscode.ConfigurationTarget.Global);
          usage = await fetchCopilotBilling(token, freshUsername, monthlyLimit);
        } else {
          throw billingError;
        }
      }
    }

    // --- Calculate pacing & update the status bar ----------------------------
    const { progressBar, buffer, monthlyLimit, usedRequests } =
      calculatePacing(usage);

    statusBarItem.text = progressBar;

    const detailedText = `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n`;

    if (buffer >= 0) {
      statusBarItem.tooltip =
        detailedText + `✅ On track. Remaining today: ~${Math.floor(buffer)} requests.`;
      statusBarItem.color = undefined;
    } else {
      statusBarItem.tooltip =
        detailedText + `🔥 Over budget! Debt: ~${Math.abs(Math.floor(buffer))} requests.`;
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
    }
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      await secretStorage.delete("copilot-pacer.githubToken");
      showPromptForToken(
        "$(key) Pacer: Token expired",
        "Your GitHub token is invalid or revoked. Click to set a new one.",
      );
    } else {
      console.error(error);
      statusBarItem.text = `$(error) Pacer: Error`;
      statusBarItem.command = "copilot-pacer.refresh";
    }
  }
}

export function deactivate() {}
