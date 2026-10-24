import { randomInt } from "node:crypto";

export const BETS_CENTS = Array.from({ length: 15 }, (_, index) => (index + 1) * 20);
export const LINE_COUNT = 3;
export const FREE_SPINS_BY_SYMBOL: Record<number, number> = {
  1: 15,
  2: 10,
  3: 5,
  4: 3,
  5: 1
};
const PAYOUT_MULTIPLIER: Record<number, number> = { 1: 3, 2: 2, 3: 1, 4: 1, 5: 1 };
const POWER_MULTIPLIER: Record<number, number> = { 6: 10, 7: 5, 8: 2 };
const MIXED_TRIPLE_PAYOUT_BET_FRACTION = 0.25;

export interface DemoOutcome {
  isMatch: boolean;
  hasReward: boolean;
  resultSymbols: number[][];
  payoutCents: number;
  freeSpinAward: number;
}

function randomMainSymbol(): number {
  return randomInt(10) < 3 ? 0 : randomInt(1, 6);
}

function randomPowerSymbol(): number {
  return randomInt(100) < 90 ? 0 : randomInt(6, 12);
}

export function evaluateResult(betPerLineCents: number, resultSymbols: number[][]): DemoOutcome {
  const middle = resultSymbols[1];
  const winningSymbol = middle[0];
  const hasNonZeroTriple = middle[0] > 0 && middle[1] > 0 && middle[2] > 0;
  const isMatch = winningSymbol > 0 &&
    winningSymbol <= 5 &&
    middle[1] === winningSymbol &&
    middle[2] === winningSymbol;
  const specialSymbol = middle[3];
  let payoutCents = 0;
  let freeSpinAward = 0;

  if (hasNonZeroTriple) {
    payoutCents = isMatch
      ? betPerLineCents * PAYOUT_MULTIPLIER[winningSymbol]
      : betPerLineCents * MIXED_TRIPLE_PAYOUT_BET_FRACTION;
    if (POWER_MULTIPLIER[specialSymbol]) {
      payoutCents *= POWER_MULTIPLIER[specialSymbol];
    } else if (specialSymbol === 9) {
      payoutCents += betPerLineCents * 2;
    } else if (specialSymbol === 10) {
      payoutCents += betPerLineCents;
    } else if (specialSymbol === 11 && isMatch) {
      freeSpinAward = FREE_SPINS_BY_SYMBOL[winningSymbol];
    }
  }

  return { isMatch, hasReward: hasNonZeroTriple, resultSymbols, payoutCents, freeSpinAward };
}

export function createDemoOutcome(betPerLineCents: number, roll = randomInt(10)): DemoOutcome {
  const middleMain = roll < 3
    ? (() => {
      const symbol = randomInt(1, 6);
      return [symbol, symbol, symbol];
    })()
    : (() => {
      const symbols = [randomMainSymbol(), randomMainSymbol(), randomMainSymbol()];
      if (symbols[0] !== 0 && symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
        symbols[2] = symbols[2] === 5 ? 1 : symbols[2] + 1;
      }
      return symbols;
    })();
  const resultSymbols = [
    Array.from({ length: 3 }, randomMainSymbol).concat(randomPowerSymbol()),
    middleMain.concat(randomPowerSymbol()),
    Array.from({ length: 3 }, randomMainSymbol).concat(randomPowerSymbol())
  ];

  return evaluateResult(betPerLineCents, resultSymbols);
}

export function credits(cents: number): number {
  return cents / 100;
}

export const SYMBOLS = [
  { ID: 1, Name: "777", payout: 3, mixedPayout: 0.25, description: "Three middle-row 777 symbols return 3 times the per-line bet; any mixed non-zero trio returns 0.25 times the per-line bet." },
  { ID: 2, Name: "77", payout: 2, mixedPayout: 0.25, description: "Three middle-row 77 symbols return 2 times the per-line bet; any mixed non-zero trio returns 0.25 times the per-line bet." },
  { ID: 3, Name: "7", payout: 1, mixedPayout: 0.25, description: "Three middle-row 7 symbols return 1 times the per-line bet; any mixed non-zero trio returns 0.25 times the per-line bet." },
  { ID: 4, Name: "BAR/BAR", payout: 1, mixedPayout: 0.25, description: "Three middle-row BAR/BAR symbols return 1 times the per-line bet; any mixed non-zero trio returns 0.25 times the per-line bet." },
  { ID: 5, Name: "BAR", payout: 1, mixedPayout: 0.25, description: "Three middle-row BAR symbols return 1 times the per-line bet; any mixed non-zero trio returns 0.25 times the per-line bet." },
  { ID: 6, Name: "10X", payout: 10, mixedPayout: 0, description: "In the middle-row fourth column, multiplies any non-zero-trio reward by 10." },
  { ID: 7, Name: "5X", payout: 5, mixedPayout: 0, description: "In the middle-row fourth column, multiplies any non-zero-trio reward by 5." },
  { ID: 8, Name: "2X", payout: 2, mixedPayout: 0, description: "In the middle-row fourth column, multiplies any non-zero-trio reward by 2." },
  { ID: 9, Name: "DOUBLE+", payout: 2, mixedPayout: 0, description: "In the middle-row fourth column, adds 2 times the per-line bet to any non-zero-trio reward." },
  { ID: 10, Name: "ADD", payout: 1, mixedPayout: 0, description: "In the middle-row fourth column, adds 1 times the per-line bet to any non-zero-trio reward." },
  { ID: 11, Name: "RESPIN", payout: 0, mixedPayout: 0, description: "With three matching non-zero middle-row symbols, grants free spins by match tier." }
];
