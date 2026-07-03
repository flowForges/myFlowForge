interface Parsed { nums: number[]; pre: string | null }

function parse(v: string): Parsed {
  const clean = String(v).trim().replace(/^v/i, '')
  const [core, ...preParts] = clean.split('-')
  const nums = core.split('.').map(n => parseInt(n, 10) || 0)
  while (nums.length < 3) nums.push(0)
  return { nums, pre: preParts.length ? preParts.join('-') : null }
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a), pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1
    if (pa.nums[i] < pb.nums[i]) return -1
  }
  // equal core: a release (pre === null) outranks any prerelease
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre > pb.pre ? 1 : pa.pre < pb.pre ? -1 : 0
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) === 1
}
