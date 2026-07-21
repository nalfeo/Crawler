/**
 * feedback-summary.mjs — pure concise-summary helpers for a variant's judge
 * and sensor traces, plus the canonical per-criterion feedback read/write
 * helpers used by `renderCriterionFeedback`.
 *
 * The Runs tab used to render EVERY judge axis and EVERY sensor row inline,
 * always expanded. This computes a one-line summary (pass/fail counts + which
 * axes/sensors are failing) so the renderer can show that by default, with the
 * full per-axis/per-sensor detail (including the feedback thumbs) tucked behind
 * a `<details>` expander. Self-contained (no imports/closures) so
 * `Function.prototype.toString()` yields a runnable declaration for
 * `renderer.mjs` to splice into the browser client script.
 *
 * @module workflow/feedback-summary
 */

/**
 * @param {{judge?: {passed?:boolean, minScore?:number, rejectedBy?:string[]}|null, judgeSkipMessage?: string}} candidate
 * @returns {{state:'pass'|'fail'|'unjudged', text:string}}
 */
export function summarizeJudge(candidate) {
  var judge = candidate && candidate.judge;
  if (!judge) {
    return {
      state: 'unjudged',
      text: (candidate && candidate.judgeSkipMessage) || 'Not judged yet.',
    };
  }
  if (judge.passed) {
    return { state: 'pass', text: 'Judge passed \u00b7 lowest axis ' + judge.minScore + '/5' };
  }
  var rejectedBy = Array.isArray(judge.rejectedBy) ? judge.rejectedBy : [];
  var suffix = rejectedBy.length ? ' (' + rejectedBy.join(', ') + ')' : '';
  return {
    state: 'fail',
    text: 'Judge rejected \u00b7 lowest axis ' + judge.minScore + '/5' + suffix,
  };
}

/**
 * @param {{sensors?: Array<{sensor:string, ok:boolean}>, passed?:boolean}} candidate
 * @returns {{state:'pass'|'fail'|'none', text:string, failingNames:string[]}}
 */
export function summarizeSensors(candidate) {
  var sensors = candidate && Array.isArray(candidate.sensors) ? candidate.sensors : [];
  if (sensors.length === 0) {
    var text =
      candidate && candidate.passed
        ? 'All sensors passed (no per-sensor detail recorded).'
        : 'No per-sensor detail recorded for this run.';
    return { state: 'none', text: text, failingNames: [] };
  }
  var failing = [];
  for (var i = 0; i < sensors.length; i++) {
    if (sensors[i] && !sensors[i].ok) failing.push(sensors[i].sensor);
  }
  if (failing.length === 0) {
    return { state: 'pass', text: 'All ' + sensors.length + ' sensors passed', failingNames: [] };
  }
  return {
    state: 'fail',
    text: failing.length + '/' + sensors.length + ' sensors failed (' + failing.join(', ') + ')',
    failingNames: failing,
  };
}

/**
 * Read the currently-PERSISTED feedback for one candidate's judge/sensor
 * criterion, defaulting to an empty `{verdict:null, comment:''}` shape when
 * nothing has been confirmed yet for that criterion. `renderCriterionFeedback`
 * calls this on EVERY render, so it must always read from the CANONICAL
 * location (`candidate.feedback[kind][criterion]`) — never a disconnected
 * fallback object — otherwise a just-confirmed value can silently revert on
 * the next render (see `writeCriterionFeedback`).
 * @param {{feedback?: {judge?: object, sensor?: object}}} candidate
 * @param {'judge'|'sensor'} kind
 * @param {string} criterion
 * @returns {{verdict: 'up'|'down'|null, comment: string}}
 */
export function readCriterionFeedback(candidate, kind, criterion) {
  var feedback = candidate && candidate.feedback;
  var byKind = feedback && feedback[kind];
  var value = byKind && byKind[criterion];
  return value || { verdict: null, comment: '' };
}

/**
 * Write a freshly-confirmed criterion feedback value back onto the CANONICAL
 * location on the candidate object (`candidate.feedback[kind][criterion]`),
 * creating the `feedback`/`feedback[kind]` containers first if they don't
 * exist yet (the common case for a criterion that has never had feedback
 * before). `candidate` is the SAME object reference retained in the
 * renderer's `lastState.candidates`, so this mutation is what makes a
 * first-time-confirmed criterion survive a later re-render without a full
 * server rebuild — mirroring how sheet/brief feedback already patch
 * `state.sheetFeedback`/`state.briefFeedback` in place.
 * @param {{feedback?: {judge?: object, sensor?: object}}} candidate
 * @param {'judge'|'sensor'} kind
 * @param {string} criterion
 * @param {{verdict: 'up'|'down'|null, comment: string} | null | undefined} value
 * @returns {{verdict: 'up'|'down'|null, comment: string}}
 */
export function writeCriterionFeedback(candidate, kind, criterion, value) {
  if (!candidate.feedback) candidate.feedback = { sensor: {}, judge: {} };
  if (!candidate.feedback[kind]) candidate.feedback[kind] = {};
  candidate.feedback[kind][criterion] = value || { verdict: null, comment: '' };
  return candidate.feedback[kind][criterion];
}
