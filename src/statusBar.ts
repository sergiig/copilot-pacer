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
  context.subscriptions.push(statusBarItem);
}

function showPromptForToken(text: string, tooltip: string): void {
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
  statusBarItem.color = undefined;
  statusBarItem.command = "copilot-pacer.setToken";
}

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
export async function updatePacing() {
  statusBarItem.text = `$(sync~spin) Pacer...`;
  statusBarItem.show();

  try {
    const token = await config.getToken();

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
      await config.deleteToken();
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
