import * as assert from "assert";

import { resolveDailyBaseline } from "../statusBar";

suite("Status bar quota reset", () => {
  test("resets baseline to zero on the first day of a new billing period", () => {
    const resolved = resolveDailyBaseline(
      {
        date: "2026-03-31",
        baseline: 1480,
        lastSeen: 1493,
        periodStartKey: "2026-03-01",
      },
      13,
      "2026-04-01",
      "2026-04-01",
    );

    assert.deepStrictEqual(resolved.state, {
      date: "2026-04-01",
      baseline: 0,
      lastSeen: 13,
      periodStartKey: "2026-04-01",
    });
    assert.strictEqual(resolved.todayUsed, 13);
  });

  test("carries yesterday's last seen total into a normal day rollover", () => {
    const resolved = resolveDailyBaseline(
      {
        date: "2026-04-01",
        baseline: 0,
        lastSeen: 13,
        periodStartKey: "2026-04-01",
      },
      21,
      "2026-04-02",
      "2026-04-01",
    );

    assert.deepStrictEqual(resolved.state, {
      date: "2026-04-02",
      baseline: 13,
      lastSeen: 21,
      periodStartKey: "2026-04-01",
    });
    assert.strictEqual(resolved.todayUsed, 8);
  });
});
