import assert from "node:assert/strict";
import test from "node:test";
import { BETS_CENTS, createDemoOutcome, evaluateResult } from "./game";

test("backend exposes fifteen higher per-line demo bets", () => {
  assert.deepEqual(BETS_CENTS, [
    20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300
  ]);
});

test("only middle-row symbols affect rewards and a zero blocks reward", () => {
  const upperAndLowerOnly = [
    [2, 2, 2, 0],
    [1, 0, 1, 0],
    [5, 5, 5, 0]
  ];
  const matchInMiddle = [
    [0, 0, 0, 0],
    [2, 2, 2, 6],
    [0, 4, 0, 11]
  ];
  const blankInMiddle = [
    [2, 2, 2, 0],
    [2, 0, 2, 11],
    [3, 3, 3, 0]
  ];

  assert.equal(evaluateResult(20, upperAndLowerOnly).hasReward, false);
  assert.equal(evaluateResult(20, matchInMiddle).payoutCents, 400);
  assert.equal(evaluateResult(20, blankInMiddle).hasReward, false);
  assert.equal(evaluateResult(20, blankInMiddle).freeSpinAward, 0);
});

test("mixed non-zero trios receive a base reward and their power/dollar bonus applies", () => {
  const mixedTrio = (bonus: number) => [
    [0, 0, 0, 0],
    [1, 2, 3, bonus],
    [0, 0, 0, 0]
  ];
  assert.equal(evaluateResult(20, mixedTrio(0)).payoutCents, 5);
  assert.equal(evaluateResult(20, mixedTrio(6)).payoutCents, 50);
  assert.equal(evaluateResult(20, mixedTrio(7)).payoutCents, 25);
  assert.equal(evaluateResult(20, mixedTrio(8)).payoutCents, 10);
  assert.equal(evaluateResult(20, mixedTrio(9)).payoutCents, 45);
  assert.equal(evaluateResult(20, mixedTrio(10)).payoutCents, 25);
  assert.equal(evaluateResult(20, mixedTrio(11)).freeSpinAward, 0);
});

test("matching triple powers and dollar symbols use their documented values", () => {
  const makeResult = (bonus: number) => [
    [1, 1, 1, 0],
    [2, 2, 2, bonus],
    [3, 3, 3, 0]
  ];

  assert.equal(evaluateResult(20, makeResult(6)).payoutCents, 400);
  assert.equal(evaluateResult(20, makeResult(7)).payoutCents, 200);
  assert.equal(evaluateResult(20, makeResult(8)).payoutCents, 80);
  assert.equal(evaluateResult(20, makeResult(9)).payoutCents, 80);
  assert.equal(evaluateResult(20, makeResult(10)).payoutCents, 60);
});

test("RESPIN grants matching-symbol free spins, but zeros block the award", () => {
  const makeResult = (first: number, second: number, third: number) => [
    [0, 0, 0, 0],
    [first, second, third, 11],
    [0, 0, 0, 0]
  ];

  assert.equal(evaluateResult(20, makeResult(2, 2, 2)).freeSpinAward, 10);
  assert.equal(evaluateResult(20, makeResult(1, 1, 1)).freeSpinAward, 15);
  assert.equal(evaluateResult(20, makeResult(3, 3, 3)).freeSpinAward, 5);
  assert.equal(evaluateResult(20, makeResult(4, 4, 4)).freeSpinAward, 3);
  assert.equal(evaluateResult(20, makeResult(5, 5, 5)).freeSpinAward, 1);
  assert.equal(evaluateResult(20, makeResult(2, 0, 2)).freeSpinAward, 0);
  assert.equal(evaluateResult(20, makeResult(2, 2, 1)).freeSpinAward, 0);
});

test("every random outcome uses the 3 by 4 result matrix and win frequency is controlled", () => {
  let wins = 0;
  for (let roll = 0; roll < 10; roll += 1) {
    const outcome = createDemoOutcome(100, roll);
    wins += outcome.isMatch ? 1 : 0;
    assert.equal(outcome.resultSymbols.length, 3);
    assert.ok(outcome.resultSymbols.every((row) => row.length === 4));
    assert.equal(outcome.isMatch, roll < 3);
  }
  assert.equal(wins, 3);
});
