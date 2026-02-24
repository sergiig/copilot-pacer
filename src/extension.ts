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
// Validated settings
// ---------------------------------------------------------------------------

interface ValidatedSettings {
  token: string;
  username: string;
  monthlyLimit: number;
}

/**
 * Reads, validates and — where possible — auto-corrects every setting the
 * extension needs. Returns `null` when no token is available (the caller
 * should prompt the user to enter one).
 *
 * Validation rules:
 * • **token** — must be present in SecretStorage; otherwise returns `null`.
 * • **monthlyLimit** — must be a finite number > 0; invalid values are
 *   silently reset to the default (300).
 * • **username** — must be non-empty; when missing it is resolved
 *   automatically from the GitHub API using the stored token.
 *
 * Throws `TokenExpiredError` if the token turns out to be invalid while
 * resolving the username.
 */
async function resolveSettings(): Promise<ValidatedSettings | null> {
  const token = await secretStorage.get("copilot-pacer.githubToken");
  if (!token) { return null; }

  const config = vscode.workspace.getConfiguration("copilot-pacer");

  // --- monthly limit ---------------------------------------------------------
  let monthlyLimit = config.get<number>("monthlyLimit") ?? DEFAULT_MONTHLY_LIMIT;
  if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
    monthlyLimit = DEFAULT_MONTHLY_LIMIT;
    await config.update("monthlyLimit", DEFAULT_MONTHLY_LIMIT, vscode.ConfigurationTarget.Global);
  }

  // --- username --------------------------------------------------------------
  let username = config.get<string>("username")?.trim();
  if (!username) {
    username = await fetchUsername(token); // may throw TokenExpiredError
    await config.update("username", username, vscode.ConfigurationTarget.Global);
  }

  return { token, username, monthlyLimit };
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
        prompt: "Enter your GitHub Personal Access Token (requires read:billing scope)",
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
 * Fetches the current Copilot premium-request usage from the GitHub Billing API.
 * Returns the number of used requests, or throws on network / API errors.
 */
async function fetchUsedRequests(token: string, username: string): Promise<number> {
  const url =
    `https://api.github.com/users/${username}/settings/billing/usage/summary`;
  const response = await fetch(url, { headers: GITHUB_API_HEADERS(token) });
  throwOnHttpError(response, url);

  const data = (await response.json()) as any;
  const copilotItem = data.usageItems?.find(
    (item: any) => item.sku === "copilot_premium_request",
  );
  return copilotItem ? copilotItem.grossQuantity : 0;
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
// the flanking zones compress the rest of the month into a fixed character width.
function calculatePacing(usedRequests: number, monthlyLimit: number): PacingResult {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentDay = now.getDate();

  const OUTSIDE_WIDTH = 12; // Total chars shared between past and future zones
  const LENS_INNER_WIDTH = 5; // Inner width of the lens zone: ┃▮▮▯▯▯┃

  const pastDays = currentDay - 1;
  const totalOutsideDays = daysInMonth - 1;

  // Distribute the outside character budget proportionally between past and future
  const pastChars =
    totalOutsideDays === 0
      ? 0
      : Math.round((pastDays / totalOutsideDays) * OUTSIDE_WIDTH);
  const futureChars = OUTSIDE_WIDTH - pastChars;

  // Quota boundaries expressed as absolute request counts
  const dailyBudget = monthlyLimit / daysInMonth;
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
 * Orchestrates: resolve settings → fetch usage → calculate → update UI.
 *
 * Self-healing behaviour:
 * • Invalid / missing token → prompts user to enter one.
 * • Invalid monthlyLimit   → silently resets to 300.
 * • Invalid username (404) → clears the cached value, re-resolves from
 *   the GitHub API, and retries the request once.
 */
async function updatePacing() {
  statusBarItem.text = `$(sync~spin) Pacer...`;
  statusBarItem.show();

  try {
    // 1. Validate & resolve every setting we need
    const settings = await resolveSettings();

    if (!settings) {
      showPromptForToken(
        "$(key) Pacer: No token",
        "Click to set your GitHub Personal Access Token.",
      );
      return;
    }

    // Token is present — clicking the bar triggers a refresh
    statusBarItem.command = "copilot-pacer.refresh";

    // 2. Fetch usage — auto-heal a stale/invalid username on 404
    let usedRequests: number;
    try {
      usedRequests = await fetchUsedRequests(settings.token, settings.username);
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Cached username is likely wrong — re-resolve from GitHub
        const config = vscode.workspace.getConfiguration("copilot-pacer");
        await config.update("username", undefined, vscode.ConfigurationTarget.Global);

        const freshUsername = await fetchUsername(settings.token);
        await config.update("username", freshUsername, vscode.ConfigurationTarget.Global);

        usedRequests = await fetchUsedRequests(settings.token, freshUsername);
      } else {
        throw error; // TokenExpiredError or other — handled below
      }
    }

    // 3. Calculate pacing & update the status bar
    const { progressBar, buffer, monthlyLimit } =
      calculatePacing(usedRequests, settings.monthlyLimit);

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
