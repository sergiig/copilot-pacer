import * as vscode from "vscode";
import { CopilotUsage, TokenExpiredError, NotFoundError } from "./types";
import { fetchCopilotInternal, fetchCopilotBilling, fetchUsername } from "./api";
import { calculatePacing } from "./pacing";
import * as config from "./config";

let statusBarItem: vscode.StatusBarItem;

export function initStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "copilot-pacer.refresh";
  context.subscriptions.push(statusBarItem);
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
 * Self-healing behaviour:
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
    } catch (internalError) {
      // Re-throw auth errors immediately — no point trying billing API
      if (internalError instanceof TokenExpiredError) { throw internalError; }

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
    }

    // --- Calculate pacing & update the status bar ----------------------------
    const { progressBar, buffer, monthlyLimit, usedRequests, overageRequests, overageCost } =
      calculatePacing(usage);

    statusBarItem.text = progressBar;

    if (overageCost > 0) {
      statusBarItem.tooltip =
        `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n` +
        `💰 Paid premium: ${Math.round(overageRequests)} requests ($${overageCost.toFixed(2)})`;
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
    } else if (buffer >= 0) {
      statusBarItem.tooltip =
        `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n` +
        `✅ On track. Remaining today: ~${Math.floor(buffer)} requests.`;
      statusBarItem.color = undefined;
    } else {
      statusBarItem.tooltip =
        `Requests: ${Math.round(usedRequests)} / ${monthlyLimit}\n` +
        `🔥 Over budget! Debt: ~${Math.abs(Math.floor(buffer))} requests.`;
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
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
