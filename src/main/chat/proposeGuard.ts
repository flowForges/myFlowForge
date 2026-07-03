/**
 * makeProposeGuard — per-turn factory that caps `proposePlan` invocations.
 *
 * Returns a "blocked?" predicate.  Each call increments an internal counter;
 * once the counter exceeds `max` the predicate returns `true` (caller should
 * short-circuit and NOT call the real proposePlan).  Creating a new guard via
 * `makeProposeGuard(max)` always starts fresh, so a new turn gets a new cap.
 *
 * @param max  Maximum allowed invocations before blocking (default 3).
 */
export function makeProposeGuard(max = 3): () => boolean {
  let count = 0
  return () => (++count > max)
}
