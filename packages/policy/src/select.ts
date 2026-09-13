export interface Criterion<T> {
  readonly key: string;
  readonly weight: number;
  score(candidate: T): number;
}

export interface RankedCandidate<T> {
  readonly candidate: T;
  readonly score: number;
  readonly breakdown: Record<string, number>;
}

export interface SelectionResult<T> {
  readonly winner: T;
  readonly ranked: RankedCandidate<T>[];
}

export function filterCandidates<T>(
  candidates: readonly T[],
  predicates: readonly ((candidate: T) => boolean)[],
): T[] {
  return candidates.filter(candidate => predicates.every(predicate => predicate(candidate)));
}

const evaluate = <T>(candidate: T, criteria: readonly Criterion<T>[]): RankedCandidate<T> => {
  const keys = new Set<string>();
  const entries: [string, number][] = [];
  let score = 0;

  for (const criterion of criteria) {
    if (criterion.key.length === 0 || keys.has(criterion.key)) {
      throw new Error("Selection criterion keys must be non-empty and unique");
    }
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0) {
      throw new Error(`Selection criterion ${criterion.key} has an invalid weight`);
    }

    const rawScore = criterion.score(candidate);
    if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > 1) {
      throw new Error(`Selection criterion ${criterion.key} returned a score outside [0, 1]`);
    }

    const contribution = rawScore * criterion.weight;
    keys.add(criterion.key);
    entries.push([criterion.key, contribution]);
    score += contribution;
  }

  return { candidate, score, breakdown: Object.fromEntries(entries) };
};

export function weightedScore<T>(candidate: T, criteria: readonly Criterion<T>[]): number {
  return evaluate(candidate, criteria).score;
}

export function selectBest<T>(
  candidates: readonly T[],
  criteria: readonly Criterion<T>[],
  tieBreak: (left: T, right: T) => number,
): SelectionResult<T> | null {
  const ranked = candidates.map(candidate => evaluate(candidate, criteria));
  ranked.sort((left, right) => {
    const scoreOrder = right.score - left.score;
    if (scoreOrder !== 0) return scoreOrder;
    const tieOrder = tieBreak(left.candidate, right.candidate);
    if (!Number.isFinite(tieOrder)) throw new Error("Selection tie-break must return a finite number");
    return tieOrder;
  });

  const first = ranked[0];
  return first === undefined ? null : { winner: first.candidate, ranked };
}
