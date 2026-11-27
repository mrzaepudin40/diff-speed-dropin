// Fast exact drop-in for makefun-diff 1.0.0.
//
// The same patch as makefun-diff's diffPatch, computed the same way the
// house baseline's header states it, but without any per-step object:
//   - lines are cut after every "\n" (a "\r" is part of its line); a last
//     line with no "\n" is a line too. Two lines are equal only when they
//     are the same code units, newline or its absence included.
//   - the common prefix is kept, then the common suffix of the lines left;
//     between them Myers's greedy search runs from the first lines, keeping
//     on each diagonal the path reaching furthest into the old text and,
//     when a deletion and an insertion reach the same point, the deletion's;
//     it never moves past either text's end, prunes no edge diagonal, and
//     follows every run of equal lines as far as it goes; the first path to
//     reach both ends is the script.
//   - the patch is "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I",
//     then per hunk "@ os ol ns nl" and one line per covered line ("=" kept,
//     "-" deleted, "+" inserted); each run of changes lists deletions before
//     insertions and shows up to 3 kept lines before and after it; two runs
//     at most 6 kept lines apart share a hunk. A line ending its text with
//     no newline is written with one and followed by a line "%". Identical
//     texts are the first line alone.
//
// Speed comes from interning every line to a small integer id once (so the
// search compares integers, never strings), running the greedy search on
// typed arrays with one snapshot of the furthest reach per edit depth (the
// snapshots are what the backtrack walks), and building the patch straight
// from the runs. Nothing is cached from one case to the next: every call
// interns its own two texts from scratch.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const CONTEXT = 3;

/** The patch's first word. */
export const FORMAT = 'makefun-diff/1';

/**
 * Intern the lines of a text to integer ids.
 *
 * `parts` is text.split('\n'): parts[0..len-2] are lines that end in "\n",
 * parts[len-1] is the last line with no "\n" (absent when it is ""). Two
 * maps keep the two kinds apart, so a bare last line never shares an id
 * with a line that ends in "\n", while the same bare line in both texts
 * still shares one id. Both maps draw from one counter, so their ids never
 * collide either.
 */
function internLines(parts, bare, mapN, mapB, next) {
  const n = parts.length - 1 + (bare ? 1 : 0);
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const line = parts[i];
    if (bare && i === n - 1) {
      let id = mapB.get(line);
      if (id === undefined) {
        id = next.value++;
        mapB.set(line, id);
      }
      ids[i] = id;
    } else {
      let id = mapN.get(line);
      if (id === undefined) {
        id = next.value++;
        mapN.set(line, id);
      }
      ids[i] = id;
    }
  }
  return ids;
}

/**
 * The edit script's runs for the middle (after prefix/suffix trimming),
 * as two parallel arrays of kinds and counts, in order. kinds are KEEP,
 * DELETE, INSERT; adjacent runs never share a kind.
 */
function editRuns(a, n, b, m) {
  // The trivial middles.
  if (n === 0 && m === 0) return [[], []];
  if (n === 0) return [[INSERT], [m]];
  if (m === 0) return [[DELETE], [n]];

  const small = n < 65535 && m < 65535;
  const Arr = small ? Uint16Array : Int32Array;
  const SENT = small ? 65535 : -1;
  const maxEdit = n + m;

  // snaps[d] holds, for edit depth d, the furthest old-lines-consumed on
  // each diagonal k in -d..d, at index k + d + 2 of an array of length
  // 2d + 5 whose two slots at each end stay SENT, so the neighbours a
  // diagonal reads (k - 1 and k + 1 at depth d - 1, at indices k + d and
  // k + d + 2) are always in range and read SENT where that diagonal does
  // not exist. SENT marks no path.
  const snaps = new Array(maxEdit + 1);
  let cur = new Arr(5);
  cur.fill(SENT);
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) {
    x++;
    y++;
  }
  cur[2] = x;
  snaps[0] = cur;
  let D = 0;
  if (x !== n || y !== m) {
    let found = false;
    for (let d = 1; d <= maxEdit && !found; d++) {
      const prev = snaps[d - 1];
      cur = new Arr(2 * d + 5);
      cur.fill(SENT);
      let iD = 0;
      let iI = 2;
      let iC = 2;
      for (let k = -d; k <= d; k += 2) {
        const xd = prev[iD];
        const xi = prev[iI];
        const canD = xd !== SENT && xd < n;
        // An insertion is possible while the k+1 path has a new line left:
        // its new-lines-consumed is xi - (k + 1).
        const canI = xi !== SENT && xi - (k + 1) < m;
        let X;
        if (canD && (!canI || xd >= xi - 1)) {
          X = xd + 1; // deletion; it wins the tie
        } else if (canI) {
          X = xi; // insertion
        } else {
          iD += 2;
          iI += 2;
          iC += 2;
          continue;
        }
        let Y = X - k;
        while (X < n && Y < m && a[X] === b[Y]) {
          X++;
          Y++;
        }
        cur[iC] = X;
        if (X === n && Y === m) {
          D = d;
          found = true;
          break;
        }
        iD += 2;
        iI += 2;
        iC += 2;
      }
      snaps[d] = cur;
    }
    if (!found) throw new Error('makefun-diff: the search ended without reaching both ends');
  }

  // Walk the snapshots back from (n, m), redoing each depth's choice by
  // the same rule the forward search used, and collect the runs reversed.
  const kinds = [];
  const counts = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = kinds.length - 1;
    if (last >= 0 && kinds[last] === kind) counts[last] += count;
    else {
      kinds.push(kind);
      counts.push(count);
    }
  };
  let k = n - m;
  x = n;
  for (let d = D; d > 0; d--) {
    const prev = snaps[d - 1];
    const xd = prev[k + d];
    const xi = prev[k + d + 2];
    const canD = xd !== SENT && xd < n;
    const canI = xi !== SENT && xi - (k + 1) < m;
    const isDel = canD && (!canI || xd >= xi - 1);
    const xEdit = isDel ? xd + 1 : xi;
    const snake = x - xEdit;
    push(KEEP, snake);
    push(isDel ? DELETE : INSERT, 1);
    k = isDel ? k - 1 : k + 1;
    x = isDel ? xd : xi;
  }
  push(KEEP, x); // the d = 0 snake, from (0, 0)
  kinds.reverse();
  counts.reverse();
  return [kinds, counts];
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, part, bare) {
  return bare ? `${op}${part}\n%\n` : `${op}${part}\n`;
}

/** makefun-diff 1.0.0's answer for one case's input: its patch of { old, new }, as one JSON string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;
  const aParts = oldText.split('\n');
  const bParts = newText.split('\n');
  const aBare = aParts[aParts.length - 1] !== '';
  const bBare = bParts[bParts.length - 1] !== '';
  const n = aParts.length - 1 + (aBare ? 1 : 0);
  const m = bParts.length - 1 + (bBare ? 1 : 0);

  const mapN = new Map();
  const mapB = new Map();
  const next = { value: 0 };
  const a = internLines(aParts, aBare, mapN, mapB, next);
  const b = internLines(bParts, bBare, mapN, mapB, next);

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const [midKinds, midCounts] = editRuns(
    a.subarray(prefix, n - suffix),
    n - prefix - suffix,
    b.subarray(prefix, m - suffix),
    m - prefix - suffix,
  );

  // The full runs: prefix keep, middle, suffix keep.
  const kinds = [];
  const counts = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = kinds.length - 1;
    if (last >= 0 && kinds[last] === kind) counts[last] += count;
    else {
      kinds.push(kind);
      counts.push(count);
    }
  };
  pushRun(KEEP, prefix);
  for (let i = 0; i < midKinds.length; i++) pushRun(midKinds[i], midCounts[i]);
  pushRun(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const count = counts[i];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aParts[at], aBare && at === n - 1));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aParts[c.o + i], aBare && c.o + i === n - 1));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bParts[c.p + i], bBare && c.p + i === m - 1));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aParts[at], aBare && at === n - 1));
  }
  return out.join('');
}
