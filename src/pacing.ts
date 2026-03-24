import { CopilotUsage, PacingResult } from "./types";

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
export function calculatePacing(usage: CopilotUsage): PacingResult {
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
