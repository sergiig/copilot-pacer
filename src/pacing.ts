import { CopilotUsage, PacingResult } from "./types";

const COST_PER_REQUEST = 0.04;

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
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
// The "lens" shows intra-day progress against the adaptive daily budget:
// remainingRequests / remainingDays at the start of the UTC day.
// 100 % = one full adaptive day's allocation consumed.
// The flanking zones compress the rest of the billing period into a fixed
// character width.
//
// @param todayUsed           Requests used since the first refresh today (from
//                            globalState daily baseline — see statusBar.ts).
// @param adaptiveDailyBudget Adaptive daily quota: remainingRequests / remainingDays,
//                            computed once per UTC day in statusBar.ts.
export function calculatePacing(usage: CopilotUsage, todayUsed: number, adaptiveDailyBudget: number): PacingResult {
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

  const dailyBudget = adaptiveDailyBudget;
  // Static budget used only for the past-zone reference: expected cumulative pace
  const staticDailyBudget = monthlyLimit / totalDays;
  // Cumulative quota expected by the start of today (= end of yesterday)
  const dayStartQuota = pastDays * staticDailyBudget;

  // Past zone: proportion of expected cumulative pace consumed through yesterday.
  const accumulatedBeforeToday = usedRequests - todayUsed;
  const pastRatio =
    dayStartQuota === 0
      ? 1
      : Math.min(1, Math.max(0, accumulatedBeforeToday / dayStartQuota));

  // Today (lens) zone: fraction of adaptive daily budget consumed so far.
  // 0 % at day start, 100 % when adaptiveDailyBudget requests have been used today.
  const lensRatio = Math.min(1, Math.max(0, todayUsed / dailyBudget));

  // Future zone: fills only when today's usage exceeds the adaptive daily budget,
  // showing how much future quota is being borrowed.
  const futureQuota = Math.max(0, monthlyLimit - accumulatedBeforeToday - dailyBudget);
  const futureRatio =
    futureQuota > 0
      ? Math.min(1, Math.max(0, (todayUsed - dailyBudget) / futureQuota))
      : 0;

  const overageRequests = Math.max(0, usedRequests - monthlyLimit);
  const overageCost = overageRequests * COST_PER_REQUEST;

  const pastStr = renderBlock(pastChars, pastRatio, "▰", "▱");
  const lensInner = overageCost > 0
    ? formatCost(overageCost)
    : renderBlock(LENS_INNER_WIDTH, lensRatio, "▮", "▯");
  const lensStr = `┃${lensInner}┃`;
  const futureStr = renderBlock(futureChars, futureRatio, "▰", "▱");

  return {
    progressBar: `${pastStr}${lensStr}${futureStr}`,
    buffer: dailyBudget - todayUsed,
    usedRequests,
    monthlyLimit,
    todayUsedRequests: todayUsed,
    dailyBudget,
    overageRequests,
    overageCost,
  };
}
