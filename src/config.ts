import * as vscode from "vscode";

export const DEFAULT_MONTHLY_LIMIT = 300;

const TOKEN_KEY = "copilot-pacer.githubToken";
const CONFIG_SECTION = "copilot-pacer";

let secretStorage: vscode.SecretStorage;

export function initSecretStorage(secrets: vscode.SecretStorage): void {
  secretStorage = secrets;
}

// ---------------------------------------------------------------------------
// Token management (via VS Code SecretStorage)
// ---------------------------------------------------------------------------

export function getToken(): Thenable<string | undefined> {
  return secretStorage.get(TOKEN_KEY);
}

export function setToken(token: string): Thenable<void> {
  return secretStorage.store(TOKEN_KEY, token);
}

export function deleteToken(): Thenable<void> {
  return secretStorage.delete(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Workspace configuration helpers
// ---------------------------------------------------------------------------

export async function getMonthlyLimit(): Promise<number> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  let limit = config.get<number>("monthlyLimit") ?? DEFAULT_MONTHLY_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    limit = DEFAULT_MONTHLY_LIMIT;
    await config.update("monthlyLimit", DEFAULT_MONTHLY_LIMIT, vscode.ConfigurationTarget.Global);
  }
  return limit;
}

export function getUsername(): string | undefined {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return config.get<string>("username")?.trim() || undefined;
}

export async function setUsername(username: string | undefined): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update("username", username, vscode.ConfigurationTarget.Global);
}
