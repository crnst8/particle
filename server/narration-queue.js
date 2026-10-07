// Synthesis jobs, one per passage of one variant, shared by everyone who wants
// that passage. Pure: no network, no database, no timers — the work arrives as
// a function of an AbortSignal, so the rules here can be tested on their own.
//
// The rules:
//   - one job per key; a second request joins it rather than starting another
//   - foreground (someone is waiting) runs before speculative (prefetch), and
//     within each, first come first served
//   - speculative work never fills every slot: one is always free for a
//     reader who is waiting, and with a single slot a waiting reader preempts
//     prefetch outright
//   - a job nobody wants any more is removed if queued and aborted if running
//   - a slot is released exactly once, however the job ends

export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'cancelled';
    this.retryable = true;
  }
}

export function createScheduler({ concurrency = 4, now = () => Date.now(), onEvent = () => {} } = {}) {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const jobs = new Map();       // key → job
  let order = 0;
  let running = 0;
  let speculative = 0;          // running jobs that are still only prefetch
  const stats = {
    requested: 0, joined: 0, started: 0, completed: 0, failed: 0, cancelled: 0, promoted: 0, preempted: 0,
    queueWaitMs: { count: 0, total: 0, max: 0 },
  };

  function request(key, { consumer, priority = 'speculative', run, meta = {} }) {
    stats.requested += 1;
    let job = jobs.get(key);
    if (job) {
      stats.joined += 1;
    } else {
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      promise.catch(() => {});   // a job nobody awaits must not be an unhandled rejection
      job = {
        key, meta, run, promise, resolve, reject,
        state: 'queued',
        priority: priority === 'foreground' ? 'foreground' : 'speculative',
        order: order++,
        consumers: new Set(),
        abort: new AbortController(),
        attempt: 0,
        countedSpeculative: false,
        enqueuedAt: now(),
        startedAt: null,
      };
      jobs.set(key, job);
      onEvent('queued', job);
    }
    if (consumer !== undefined) job.consumers.add(consumer);
    if (priority === 'foreground') promote(job);
    pump();
    return job.promise;
  }

  function promote(job) {
    if (job.priority === 'foreground') return;
    job.priority = 'foreground';
    stats.promoted += 1;
    if (job.state === 'running' && job.countedSpeculative) {
      job.countedSpeculative = false;
      speculative -= 1;
    }
    onEvent('promoted', job);
  }

  /** This consumer no longer needs the job. The last one leaving cancels it. */
  function release(key, consumer) {
    const job = jobs.get(key);
    if (!job) return false;
    job.consumers.delete(consumer);
    if (job.consumers.size === 0) cancelJob(job);
    return true;
  }

  function cancelJob(job, error = new CancelledError()) {
    if (jobs.get(job.key) !== job) return;
    jobs.delete(job.key);
    stats.cancelled += 1;
    if (job.state === 'running') job.abort.abort(error);
    job.state = 'cancelled';
    job.reject(error);
    onEvent('cancelled', job);
    pump();
  }

  /** Cancel every job the predicate picks — an article edited, deleted, or reset. */
  function cancelWhere(predicate, error) {
    let count = 0;
    for (const job of [...jobs.values()]) {
      if (predicate(job)) { cancelJob(job, error || new CancelledError()); count += 1; }
    }
    return count;
  }

  function pick() {
    const queued = [...jobs.values()].filter(job => job.state === 'queued').sort((a, b) => a.order - b.order);
    const foreground = queued.find(job => job.priority === 'foreground');
    if (foreground) return foreground;
    const room = limit > 1 ? limit - 1 : 1;
    if (speculative >= room) return null;
    return queued.find(job => job.priority === 'speculative') || null;
  }

  function pump() {
    // a single slot held by prefetch while someone waits: the prefetch yields
    if (limit === 1 && running === 1) {
      const waiting = [...jobs.values()].some(job => job.state === 'queued' && job.priority === 'foreground');
      const blocker = [...jobs.values()].find(job => job.state === 'running' && job.priority === 'speculative');
      if (waiting && blocker) requeue(blocker);
    }
    while (running < limit) {
      const next = pick();
      if (!next) break;
      start(next);
    }
  }

  /* Back to the queue in its original place, with its consumers and its promise;
     the interrupted attempt's outcome is ignored when it arrives. */
  function requeue(job) {
    stats.preempted += 1;
    const abort = job.abort;
    job.abort = new AbortController();
    job.state = 'queued';
    job.attempt += 1;
    abort.abort(new CancelledError('preempted'));
    onEvent('preempted', job);
  }

  function start(job) {
    job.state = 'running';
    job.startedAt = now();
    const wait = job.startedAt - job.enqueuedAt;
    stats.queueWaitMs.count += 1;
    stats.queueWaitMs.total += wait;
    stats.queueWaitMs.max = Math.max(stats.queueWaitMs.max, wait);
    stats.started += 1;
    running += 1;
    job.countedSpeculative = job.priority === 'speculative';
    if (job.countedSpeculative) speculative += 1;
    const attempt = job.attempt;
    const signal = job.abort.signal;
    let released = false;
    const free = () => {
      if (released) return;
      released = true;
      running -= 1;
      if (job.countedSpeculative) {
        job.countedSpeculative = false;
        speculative -= 1;
      }
    };
    onEvent('started', job);

    Promise.resolve()
      .then(() => job.run(signal, job))
      .then((value) => {
        free();
        if (job.attempt !== attempt || jobs.get(job.key) !== job) return;
        jobs.delete(job.key);
        job.state = 'done';
        stats.completed += 1;
        job.resolve(value);
        onEvent('done', job);
      }, (error) => {
        free();
        if (job.attempt !== attempt || jobs.get(job.key) !== job) return;
        jobs.delete(job.key);
        job.state = 'failed';
        stats.failed += 1;
        job.reject(error);
        onEvent('failed', job, error);
      })
      .finally(pump);
  }

  return {
    request,
    release,
    cancelWhere,
    get: key => jobs.get(key) || null,
    has: key => jobs.has(key),
    snapshot: () => ({
      running, speculative, queued: [...jobs.values()].filter(job => job.state === 'queued').length,
      jobs: [...jobs.values()].map(job => ({ key: job.key, state: job.state, priority: job.priority, consumers: job.consumers.size })),
    }),
    stats: () => structuredClone(stats),
    limit,
  };
}
