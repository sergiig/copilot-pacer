import * as vscode from "vscode";
import { CopilotUsage, TokenExpiredError, NotFoundError } from "./types";
import { fetchCopilotInternal, fetchCopilotBilling, fetchUsername } from "./api";
import { calculatePacing } from "./pacing";
import * as config from "./config";
import * as ext from "./extension";

let statusBarItem: vscode.StatusBarItem;
let globalState: vscode.Memento & { setKeysForSync(keys: readonly string[]): void };

export function initStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "copilot-pacer.refresh";
  context.subscriptions.push(statusBarItem);
  globalState = context.globalState;
  globalState.setKeysForSync(["copilot-pacer.dailyBaseline", "copilot-pacer.adaptiveQuota"]);
}

/**
 * Returns the number of requests used since UTC midnight (best effort).
 *
 * Stores { date, baseline, lastSeen } in globalState:
 * - `baseline`  — cumulative value at the start of the current UTC day
 *                 (set from the previous day's `lastSeen` when the day rolls
 *                 over, so requests made before VS Code opens are included).
 * - `lastSeen`  — most recent cumulative value; updated on every refresh so
 *                 it serves as the next day's baseline.
 *
 * Limitation: the very first time the extension runs ever, `baseline` is set
 * to `currentUsed` and `todayUsed` starts at 0 for that session.
 */
function getTodayUsed(currentUsed: number): number {
  const todayKey = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC
  const stored = globalState.get<{ date: string; baseline: number; lastSeen: number }>(
    "copilot-pacer.dailyBaseline"
  );

  if (!stored || stored.date !== todayKey) {
    // Day rolled over (or first-ever run).
    // Use yesterday's lastSeen as today's baseline so that requests made
    // after VS Code was last closed yesterday are still counted today.
    const baseline = stored ? stored.lastSeen : currentUsed;
    globalState.update("copilot-pacer.dailyBaseline", {
      date: todayKey,
      baseline,
      lastSeen: currentUsed,
    });
    return Math.max(0, currentUsed - baseline);
  }

  // Same day: update lastSeen for future day-rollover, return intra-day delta.
  globalState.update("copilot-pacer.dailyBaseline", {
    ...stored,
    lastSeen: currentUsed,
  });
  return Math.max(0, currentUsed - stored.baseline);
}

/** Returns the number of UTC days remaining in the billing period, including today. */
function daysUntilPeriodEnd(periodEnd: Date): number {
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endMs = Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate());
  return Math.max(1, Math.ceil((endMs - todayMs) / (24 * 60 * 60 * 1000)));
}

/**
 * Returns the adaptive daily budget for today: remainingRequests / remainingDays.
 *
 * Computed exactly once per UTC day and stored in globalState under
 * `copilot-pacer.adaptiveQuota` as { date, quota }.  The cached value is
 * returned unchanged for the rest of the day so the denominator does not
 * shift as requests are consumed during the day.
 *
 * Must be called AFTER getTodayUsed() so that the dailyBaseline entry has
 * already been written with the correct `baseline` for today.
 */
function getAdaptiveDailyBudget(usage: CopilotUsage): number {
  const todayKey = new Date().toISOString().slice(0, 10);
  const storedQuota = globalState.get<{ date: string; quota: number }>(
    "copilot-pacer.adaptiveQuota"
  );
  if (storedQuota && storedQuota.date === todayKey) {
    return storedQuota.quota;
  }

  // Recompute: start from today's opening baseline (set by getTodayUsed on rollover).
  const storedBaseline = globalState.get<{ date: string; baseline: number; lastSeen: number }>(
    "copilot-pacer.dailyBaseline"
  );
  const todayStartUsed = storedBaseline?.baseline ?? usage.usedRequests;
  const remainingRequests = Math.max(0, usage.monthlyLimit - todayStartUsed);
  const remainingDays = daysUntilPeriodEnd(usage.periodEnd);
  const quota = Math.max(1, remainingRequests / remainingDays);

  globalState.update("copilot-pacer.adaptiveQuota", { date: todayKey, quota });
  ext.outputChannel.appendLine(
    `[adaptive quota] remaining=${Math.round(remainingRequests)} / ${remainingDays} days → ${Math.round(quota)}/day`
  );
  return quota;
}

function showPromptForToken(text: string, tooltip: string): void {
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
  statusBarItem.color = undefined;
  statusBarItem.command = "copilot-pacer.setToken";
}

/**
 * Resolves a GitHub token for API access.
 *
 * Strategy:
 * 1. Try VS Code's built-in GitHub authentication (no manual PAT needed).
 *    - `createIfNone: true` only when the user explicitly clicked refresh
 *      so background timer refreshes never pop up a sign-in dialog.
 * 2. Fall back to the manually stored PAT (SecretStorage) if available.
 */
async function resolveToken(showProgress: boolean): Promise<string | undefined> {
  try {
    // Always try the silent path first — reuses an existing session without UI
    let session = await vscode.authentication.getSession(
      "github", ["user:email"], { silent: true },
    );
    // No cached session and user explicitly clicked → prompt for sign-in
    if (!session && showProgress) {
      session = await vscode.authentication.getSession(
        "github", ["user:email"], { createIfNone: true },
      );
    }
    if (session) { return session.accessToken; }
  } catch {
    // VS Code auth unavailable or user cancelled — fall through to PAT
  }

  return config.getToken();
}

/**
 * Orchestrates: fetch usage → calculate → update UI.
 *
 * @param showProgress When `true` (manual click), shows a spinner and may
 *   prompt for GitHub sign-in. When `false` (background timer), fetches
 *   silently without any visual changes until the result is ready.
 *
 * Data-source strategy:
 * 1. Try the internal Copilot API first (near real-time, no username needed).
 * 2. If that fails, fall back to the official billing API (may lag behind).
 *
 * Self-healing behavior:
 * • No GitHub session         → prompts to sign in on manual refresh.
 * • Invalid monthlyLimit      → silently resets to 300 (billing fallback).
 * • Invalid username (404)    → clears cached value, re-resolves, retries.
 * • Token expired (401)       → clears token, prompts for a new one.
 */
export async function updatePacing(showProgress: boolean = false) {
  statusBarItem.command = "copilot-pacer.refresh";
  if (showProgress) {
    statusBarItem.text = `$(sync~spin) Pacer...`;
  }
  statusBarItem.show();

  try {
    const token = await resolveToken(showProgress);

    if (!token) {
      statusBarItem.text = "$(key) Pacer: Sign in";
      statusBarItem.tooltip = "Click to sign in with GitHub.";
      statusBarItem.color = undefined;
      return;
    }

    // --- Try the internal Copilot API first (near real-time) -----------------
    let usage: CopilotUsage;
    try {
      usage = await fetchCopilotInternal(token);
      ext.outputChannel.appendLine(
        `[internal API] used=${Math.round(usage.usedRequests)} / ${usage.monthlyLimit}` +
        ` | period ${usage.periodStart.toISOString().slice(0,10)} → ${usage.periodEnd.toISOString().slice(0,10)}`
      );
    } catch (internalError) {
      // Re-throw auth errors immediately — no point trying billing API
      if (internalError instanceof TokenExpiredError) { throw internalError; }
      ext.outputChannel.appendLine(`[internal API] failed: ${internalError}`);

      // Internal API unavailable — fall back to the billing API
      const monthlyLimit = await config.getMonthlyLimit();

      let username = config.getUsername();
      if (!username) {
        username = await fetchUsername(token);
        await config.setUsername(username);
      }

      try {
        usage = await fetchCopilotBilling(token, username, monthlyLimit);
      } catch (billingError) {
        if (billingError instanceof NotFoundError) {
          // Cached username is likely wrong — re-resolve from GitHub
          await config.setUsername(undefined);
          const freshUsername = await fetchUsername(token);
          await config.setUsername(freshUsername);
          usage = await fetchCopilotBilling(token, freshUsername, monthlyLimit);
        } else {
          throw billingError;
        }
      }
      ext.outputChannel.appendLine(
        `[billing API] used=${Math.round(usage.usedRequests)} / ${usage.monthlyLimit}` +
        ` | period ${usage.periodStart.toISOString().slice(0,10)} → ${usage.periodEnd.toISOString().slice(0,10)}`
      );
    }

    // Compute intra-day usage from the daily baseline stored in globalState.
    // The baseline resets at UTC midnight so todayUsed always reflects the
    // current UTC day only.
    const todayUsed = getTodayUsed(usage.usedRequests);
    const adaptiveDailyBudget = getAdaptiveDailyBudget(usage);

    // --- Calculate pacing & update the status bar ----------------------------
    const result = calculatePacing(usage, todayUsed, adaptiveDailyBudget);
    ext.outputChannel.appendLine(
      `[today] used=${Math.round(result.todayUsedRequests)} / ${Math.round(result.dailyBudget)} (adaptive)`
    );
    const { progressBar, buffer, monthlyLimit, usedRequests, overageRequests, overageCost, todayUsedRequests, dailyBudget } = result;

    statusBarItem.text = progressBar;

    if (overageCost > 0) {
      statusBarItem.tooltip =
        `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n` +
        `Today: ${Math.round(todayUsedRequests)} / ${Math.round(dailyBudget)}\n` +
        `💰 Paid premium: ${Math.round(overageRequests)} requests ($${overageCost.toFixed(2)})`;
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
    } else if (buffer < 0) {
      statusBarItem.tooltip =
        `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n` +
        `Today: ${Math.round(todayUsedRequests)} / ${Math.round(dailyBudget)}\n` +
        `🔥 Over daily budget! Debt: ~${Math.abs(Math.floor(buffer))} requests.`;
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
    } else {
      statusBarItem.tooltip =
        `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n` +
        `Today: ${Math.round(todayUsedRequests)} / ${Math.round(dailyBudget)}\n` +
        `✅ Remaining today: ~${Math.floor(buffer)} requests.`;
      statusBarItem.color = undefined;
    }
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      await config.deleteToken();
      showPromptForToken(
        "$(key) Pacer: Token expired",
        "Your GitHub token is invalid or revoked. Click to set a new one.",
      );
    } else {
      console.error(error);
      statusBarItem.text = `$(error) Pacer: Error`;
    }
  }
}
