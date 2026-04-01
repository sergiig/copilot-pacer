# Pacer for GitHub Copilot

A lightweight VSCode extension that lets you easily track your GitHub Copilot premium requests. It adds a convenient, distraction-free indicator directly to your status bar, so you can monitor your monthly quota and daily usage at a glance without interrupting your workflow.

![Pacer UI](images/screenshot.png)

## Why this exists?

Standard percentage metrics (e.g., "Used 37%") lack daily context. They do not tell you whether you are burning through your budget too fast *today* or whether you have saved up a comfortable buffer.

Pacer solves this with a three-zone visual that shows both **where you stand this month** and **how much you have used today specifically**.

The **today's lens** (`┃…┃`) tracks intra-day consumption: it resets at UTC midnight and fills as you send requests during the day. The denominator is an **adaptive daily budget** (`remainingRequests / remainingDays` at the start of each UTC day) so the 100 % reference automatically adjusts for requests borrowed or saved in previous days. Once you have used that many requests today, the lens is full and the future zone begins to fill.

## Features

* **Visual Pacing Bar:** The status bar indicator (e.g., `▰▰┃▮▮▯▯▯┃▱▱▱`) is dynamically split into three clear zones:

  * **Past (`▰▰`):** Requests you have already spent.
  * **Today's Lens (`┃▮▮▯▯▯┃`):** Intra-day consumption since UTC midnight, as a fraction of the **adaptive daily budget (v4.x)** (`remainingRequests / remainingDays` at day start, adjusts for over/under-spending in previous days). Resets automatically at each UTC midnight. The count reflects your entire account: requests made on any machine using the same GitHub token are included. Both the baseline and the adaptive quota are shared across machines via VS Code Settings Sync.
  * **Future (`▱▱▱`):** The remaining quota for the rest of the month.
* **Paid Premium Tracking: (v3.x)** Once you exceed your included quota, GitHub charges $0.04 per additional premium request. The lens automatically switches to show your real-time spending (e.g., `▰▰▰▰┃$5.14┃▰▰▰▰`), so you always know exactly how much you have spent this month.

  ![Paid Premium Requests](images/screenshot-paid.png)

* **Smart Tooltip:** Hover over the status bar to see the exact numbers: total monthly usage (`X / 1500`), today's intra-day count vs adaptive daily budget (`Today: X / 131`), and remaining requests for today.
* **Zero Setup:** Works automatically with your GitHub account, no tokens or configuration needed.
* **Set and Forget:** The indicator automatically refreshes in the background. Click on the status bar to refresh it manually anytime.

## Commands

| Command | Description |
| ---- | ---- |
| `Pacer: Refresh` | Force an immediate usage refresh |

## Cross-machine sync

The today's lens needs two pieces of local state that the GitHub API cannot provide directly.  Both are stored in VS Code's `globalState` and registered for **VS Code Settings Sync**, so they are automatically shared across all your machines when Settings Sync is active.

| Setting key | Shape | Purpose |
| ---- | ---- | ---- |
| `copilot-pacer.dailyBaseline` | `{ date, baseline, lastSeen }` | Tracks where the cumulative counter stood at the start of the UTC day (`baseline`) and the most recent observed value (`lastSeen`). `todayUsed = currentUsed − baseline`. On day rollover `baseline` is set from `lastSeen`, so requests made before VS Code opens are still counted for that day. |
| `copilot-pacer.adaptiveQuota` | `{ date, quota }` | The adaptive daily budget (`remainingRequests / remainingDays`) computed **once at the start of each UTC day** and frozen for the rest of it, so the denominator of the lens does not shrink as you use it during the day. |

Together these two settings hold exactly the same information as a single `(date, baseline, lastSeen, quota)` tuple: they are split only for code clarity.

### First-ever run

On first activation (no settings exist yet), the extension bootstraps both settings from the current API reading: `todayUsed = 0` and the adaptive quota is computed as `(monthlyLimit − currentUsed) / remainingDays`. Requests sent today *before* the extension was first activated are not counted in `todayUsed` for that day: this is a one-time limitation that self-corrects at the next UTC midnight rollover.

### Why sync matters

Both settings reflect your **entire account's** cumulative request count (the GitHub API reports all machines combined). When Settings Sync propagates these values, every VS Code instance on every machine uses the same `baseline` and the same `quota`, so the today lens shows the same `Today: X / Y` reading everywhere.

Without Settings Sync each machine maintains its own `baseline` and recomputes its own `quota` at UTC midnight independently. The lens still works locally but may differ across machines until the next sync cycle.

To enable Settings Sync: `Ctrl+Shift+P` → **Settings Sync: Turn On** → sign in with the same GitHub (or Microsoft) account you use for Copilot.

## License

[MIT](LICENSE)
