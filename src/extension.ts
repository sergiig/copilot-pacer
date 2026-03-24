import * as vscode from "vscode";
import * as config from "./config";
import { initStatusBar, updatePacing } from "./statusBar";

export function activate(context: vscode.ExtensionContext) {
  console.log("Pacer for GitHub Copilot activated");

  config.initSecretStorage(context.secrets);
  initStatusBar(context);

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
        await config.setToken(token);
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

export function deactivate() {}
