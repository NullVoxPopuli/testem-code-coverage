/**
 * Formats a numeric score for display.
 *
 * The `score < 0` guard is intentionally never exercised by tests so the
 * coverage report highlights the uncovered branch.
 */
export function formatScore(score, { unit = 'pts' } = {}) {
  if (score < 0) {
    // This branch is deliberately left uncovered by tests.
    return `(${Math.abs(score)} ${unit} below zero)`;
  }

  if (score === 0) {
    return `No score yet`;
  }

  return `${score} ${unit}`;
}
