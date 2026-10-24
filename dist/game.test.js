"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const game_1 = require("./game");
(0, node_test_1.default)("backend exposes fifteen higher per-line demo bets", () => {
    strict_1.default.deepEqual(game_1.BETS_CENTS, [
        20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300
    ]);
});
(0, node_test_1.default)("only middle-row symbols affect rewards and a zero blocks reward", () => {
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
    strict_1.default.equal((0, game_1.evaluateResult)(20, upperAndLowerOnly).hasReward, false);
    strict_1.default.equal((0, game_1.evaluateResult)(20, matchInMiddle).payoutCents, 400);
    strict_1.default.equal((0, game_1.evaluateResult)(20, blankInMiddle).hasReward, false);
    strict_1.default.equal((0, game_1.evaluateResult)(20, blankInMiddle).freeSpinAward, 0);
});
(0, node_test_1.default)("mixed non-zero trios receive a base reward and their power/dollar bonus applies", () => {
    const mixedTrio = (bonus) => [
        [0, 0, 0, 0],
        [1, 2, 3, bonus],
        [0, 0, 0, 0]
    ];
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(0)).payoutCents, 5);
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(6)).payoutCents, 50);
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(7)).payoutCents, 25);
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(8)).payoutCents, 10);
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(9)).payoutCents, 45);
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(10)).payoutCents, 25);
    strict_1.default.equal((0, game_1.evaluateResult)(20, mixedTrio(11)).freeSpinAward, 0);
});
(0, node_test_1.default)("matching triple powers and dollar symbols use their documented values", () => {
    const makeResult = (bonus) => [
        [1, 1, 1, 0],
        [2, 2, 2, bonus],
        [3, 3, 3, 0]
    ];
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(6)).payoutCents, 400);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(7)).payoutCents, 200);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(8)).payoutCents, 80);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(9)).payoutCents, 80);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(10)).payoutCents, 60);
});
(0, node_test_1.default)("RESPIN grants matching-symbol free spins, but zeros block the award", () => {
    const makeResult = (first, second, third) => [
        [0, 0, 0, 0],
        [first, second, third, 11],
        [0, 0, 0, 0]
    ];
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(2, 2, 2)).freeSpinAward, 10);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(1, 1, 1)).freeSpinAward, 15);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(3, 3, 3)).freeSpinAward, 5);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(4, 4, 4)).freeSpinAward, 3);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(5, 5, 5)).freeSpinAward, 1);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(2, 0, 2)).freeSpinAward, 0);
    strict_1.default.equal((0, game_1.evaluateResult)(20, makeResult(2, 2, 1)).freeSpinAward, 0);
});
(0, node_test_1.default)("every random outcome uses the 3 by 4 result matrix and win frequency is controlled", () => {
    let wins = 0;
    for (let roll = 0; roll < 10; roll += 1) {
        const outcome = (0, game_1.createDemoOutcome)(100, roll);
        wins += outcome.isMatch ? 1 : 0;
        strict_1.default.equal(outcome.resultSymbols.length, 3);
        strict_1.default.ok(outcome.resultSymbols.every((row) => row.length === 4));
        strict_1.default.equal(outcome.isMatch, roll < 3);
    }
    strict_1.default.equal(wins, 3);
});
