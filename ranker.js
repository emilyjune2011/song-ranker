/**
 * Ranking engine: binary insertion sort driven by the user's picks.
 *
 * Each song is inserted into the sorted list by comparing it against the middle of the
 * remaining range, which is the minimum number of questions for a pairwise sort. With a
 * top-N goal, only the first N slots are searched and anything landing below is dropped.
 *
 * A session is plain data — { order, topN, log, legacyAdj? } — and every other piece of
 * state is derived by replaying `log`, so saving is cheap and undo is "drop the last
 * manual answer and replay".
 *
 * Log characters:
 *   "n"  the new song (candidate being inserted) was preferred
 *   "e"  the existing song (already in the sorted list) was preferred
 *   "s"  skipped: candidate goes to the back of the queue
 *   "N" / "E"  same as n / e, answered automatically from earlier picks
 */
(function (global) {
  "use strict";

  function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** Stable 0/1 per pair so the candidate isn't always on the same side. */
  function pairSide(a, b) {
    const k = pairKey(a, b);
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
    return h & 1;
  }

  /** Expected picks to fully insert `count` more songs into a list that already has `size`. */
  function estimateRemainingInsertions(size, count, cap) {
    let total = 0;
    let s = size;
    for (let i = 0; i < count; i++) {
      total += Math.log2(Math.min(s, cap) + 1);
      s += 1;
    }
    return total;
  }

  /** Expected number of picks to rank n songs (optionally only the top `topN`). */
  function estimateComparisons(n, topN) {
    if (n < 2) return 0;
    const cap = topN && topN < n ? topN : Infinity;
    return Math.round(estimateRemainingInsertions(1, n - 1, cap));
  }

  function createSession(trackIds, topN) {
    const order = [...trackIds];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const n = order.length;
    const top = topN && topN >= 2 && topN < n ? Math.floor(topN) : null;
    return { v: 2, order, topN: top, log: "" };
  }

  class Ranker {
    constructor(session) {
      this.session = session;
      this.legacy = null;
      if (session.legacyAdj && typeof session.legacyAdj === "object") {
        this.legacy = new Map(
          Object.entries(session.legacyAdj).map(([w, losers]) => [w, new Set(losers || [])])
        );
      }
      this._rebuild();
    }

    get cap() {
      return this.session.topN || Infinity;
    }

    _rebuild() {
      this.sorted = this.session.order.length ? [this.session.order[0]] : [];
      this.queue = this.session.order.slice(1);
      this.head = 0;
      /** id → Map(otherId → true if id was preferred) */
      this.known = new Map();
      this.manualCount = 0;
      this.cur = this._startNext();
      for (const ch of this.session.log) {
        if (!this.cur) break;
        this._apply(ch);
      }
      this._autoAdvance();
    }

    _remember(winner, loser) {
      if (!this.known.has(winner)) this.known.set(winner, new Map());
      if (!this.known.has(loser)) this.known.set(loser, new Map());
      this.known.get(winner).set(loser, true);
      this.known.get(loser).set(winner, false);
    }

    _startNext() {
      if (this.head >= this.queue.length) return null;
      const id = this.queue[this.head++];
      let lo = 0;
      let hi = Math.min(this.sorted.length, this.cap);
      // Narrow the range using answers from an earlier, skipped attempt at this song.
      const k = this.known.get(id);
      if (k) {
        for (const [other, won] of k) {
          const p = this.sorted.indexOf(other);
          if (p < 0) continue;
          if (won) hi = Math.min(hi, p);
          else lo = Math.max(lo, p + 1);
        }
        if (lo > hi) lo = hi;
      }
      const cur = { id, lo, hi };
      if (cur.lo >= cur.hi) {
        this._place(cur);
        return this._startNext();
      }
      return cur;
    }

    _place(cur) {
      if (cur.lo < this.cap) {
        this.sorted.splice(cur.lo, 0, cur.id);
        if (this.sorted.length > this.cap) this.sorted.length = this.cap;
      }
    }

    _apply(ch) {
      const cur = this.cur;
      const mid = (cur.lo + cur.hi) >> 1;
      const other = this.sorted[mid];
      if (ch === "s") {
        this.queue.push(cur.id);
        this.cur = this._startNext();
        return;
      }
      const lower = ch.toLowerCase();
      if (ch === "n" || ch === "e") this.manualCount += 1;
      if (lower === "n") {
        this._remember(cur.id, other);
        cur.hi = mid;
      } else {
        this._remember(other, cur.id);
        cur.lo = mid + 1;
      }
      if (cur.lo >= cur.hi) {
        this._place(cur);
        this.cur = this._startNext();
      }
    }

    _legacyPrefers(a, b) {
      if (!this.legacy) return false;
      const seen = new Set();
      const stack = [a];
      while (stack.length) {
        const x = stack.pop();
        if (x === b) return true;
        if (seen.has(x)) continue;
        seen.add(x);
        for (const y of this.legacy.get(x) || []) stack.push(y);
      }
      return false;
    }

    /** Answer pairs we already know (from a skipped attempt or an older saved session). */
    _autoAdvance() {
      while (this.cur) {
        const pair = this.currentPair();
        const c = pair.candidate;
        const o = pair.other;
        let ch = null;
        const direct = this.known.get(c)?.get(o);
        if (direct === true) ch = "N";
        else if (direct === false) ch = "E";
        else if (this._legacyPrefers(c, o)) ch = "N";
        else if (this._legacyPrefers(o, c)) ch = "E";
        if (!ch) return;
        this.session.log += ch;
        this._apply(ch);
      }
    }

    isDone() {
      return !this.cur;
    }

    /** { candidate, other, left, right } ids for the matchup on screen, or null when done. */
    currentPair() {
      if (!this.cur) return null;
      const mid = (this.cur.lo + this.cur.hi) >> 1;
      const candidate = this.cur.id;
      const other = this.sorted[mid];
      const flip = pairSide(candidate, other) === 1;
      return {
        candidate,
        other,
        left: flip ? other : candidate,
        right: flip ? candidate : other,
      };
    }

    choose(winnerId) {
      const pair = this.currentPair();
      if (!pair) return;
      const ch = winnerId === pair.candidate ? "n" : "e";
      this.session.log += ch;
      this._apply(ch);
      this._autoAdvance();
    }

    /** Skipping only makes sense when another song can be inserted first. */
    canSkip() {
      return !!this.cur && this.head < this.queue.length;
    }

    skip() {
      if (!this.canSkip()) return;
      this.session.log += "s";
      this._apply("s");
      this._autoAdvance();
    }

    canUndo() {
      return /[nes]/.test(this.session.log);
    }

    undo() {
      let log = this.session.log;
      while (log.length) {
        const ch = log[log.length - 1];
        log = log.slice(0, -1);
        if (ch === "n" || ch === "e" || ch === "s") break;
      }
      this.session.log = log;
      this._rebuild();
    }

    /** Final order (best first). Only meaningful once isDone(). */
    result() {
      return [...this.sorted];
    }

    progress() {
      const done = this.manualCount;
      if (!this.cur) return { done, total: done, remaining: 0 };
      const span = this.cur.hi - this.cur.lo;
      const pending = this.queue.length - this.head;
      const current = Math.log2(span + 1);
      const afterSize = this.sorted.length + (this.cur.lo < this.cap ? 1 : 0);
      const future = estimateRemainingInsertions(afterSize, pending, this.cap);
      const remaining = Math.max(1, Math.round(current + future));
      return { done, total: done + remaining, remaining };
    }
  }

  global.SongRanker = { Ranker, createSession, estimateComparisons, pairKey };
})(window);
