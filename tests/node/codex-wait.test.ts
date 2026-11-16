// codex-wait.test.ts — node:test port of tests/test-codex-wait.sh: gsdt-codex-wait waits out a
// Codex usage limit, and a REVIEWS.md whose reviewer hit it never passes the review gate.
//
// A fake clock (GSD_CODEX_WAIT_CLOCK) makes hours of waiting take no time; stub commands (node
// scripts, so they run the same everywhere) stand in for Codex; CODEX_HOME points at a
// throwaway folder. Run: node --test tests/node/codex-wait.test.ts
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { reviewsProblem } from '../../src/common.ts';
import { gsdt, tmp, write } from './g2-helpers.ts';
import type { Run } from './g2-helpers.ts';

const WORK = tmp('gsd-cw-');
const CODEX_HOME = path.join(WORK, 'codex');
const CLOCK = path.join(WORK, 'clock');
const RUNS = path.join(WORK, 'runs');
const SESS = path.join(CODEX_HOME, 'sessions', '2026', '10', '10');
mkdirSync(SESS, { recursive: true });
const T0 = Math.floor(Date.now() / 1000);

const resetClock = (): void => {
  writeFileSync(CLOCK, `${T0}\n`);
  rmSync(RUNS, { force: true });
};
const clock = (): number => parseInt(readFileSync(CLOCK, 'utf8').trim(), 10);
const runs = (): number => (existsSync(RUNS) ? readFileSync(RUNS, 'utf8').split('\n').filter((l) => l !== '').length : 0);
const clearLogs = (): void => {
  for (const f of readdirSync(SESS)) if (f.endsWith('.jsonl')) rmSync(path.join(SESS, f));
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number): string => String(n).padStart(2, '0');
// Codex's wording for a reset at epoch s: "Oct 11th, 2026 01:22 AM" (local time = UTC here)
const at = (s: number): string => {
  const d = new Date(s * 1000);
  const h = d.getUTCHours();
  return `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())}th, ${d.getUTCFullYear()} ${p2(h % 12 === 0 ? 12 : h % 12)}:${p2(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
};
const RSQ = '’'; // the curly apostrophe Codex prints
const limitMsg = (s: number): string => `You${RSQ}ve hit your usage limit. Upgrade to Pro or try again at ${at(s)}.`;
const iso = (s: number): string => new Date(s * 1000).toISOString();

// stub: counts its runs; limited (exit 2, message on stderr) for the first `limited` runs, then
// prints a review and exits 0. msg = the message.
let stubMsg = '';
const STUB_JS = path.join(WORK, 'stub.js');
const STUB3_JS = path.join(WORK, 'stub3.js');
let stubLimited = 0;
const stub = (limited: number, msg: string): void => {
  stubLimited = limited;
  stubMsg = msg;
};
write(
  STUB_JS,
  `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(RUNS)}, 'x\\n');
const n = fs.readFileSync(${JSON.stringify(RUNS)}, 'utf8').split('\\n').filter((l) => l !== '').length;
if (n <= Number(process.env.STUB_LIMITED)) { process.stderr.write(process.env.STUB_MSG + '\\n'); process.exit(2); }
process.stdout.write('review: looks fine\\n'); process.stderr.write('note on stderr\\n');
`,
);
write(STUB3_JS, `require('fs').appendFileSync(${JSON.stringify(RUNS)}, 'x\\n'); process.stderr.write('unrelated test failure\\n'); process.exit(3);\n`);

const cw = (args: string[], input = ''): Run =>
  gsdt('codex-wait', args, {
    input,
    env: { TZ: 'UTC', CODEX_HOME, GSD_CODEX_WAIT_CLOCK: CLOCK, HOME: path.join(WORK, 'home'), STUB_MSG: stubMsg, STUB_LIMITED: String(stubLimited) },
  });
const chompEnd = (s: string): string => s.replace(/\n+$/, '');
const node = (code: string): string[] => [process.execPath, '-e', code];
const STUB = [process.execPath, STUB_JS];
const STUB3 = [process.execPath, STUB3_JS];

describe('help and usage', () => {
  let h: Run;
  it('--help exits 0', () => {
    h = cw(['--help']);
    assert.equal(h.status, 0);
  });
  it('--help explains --wait-only', () => assert.match(h.out, /--wait-only/));
  it('no command → 64', () => assert.equal(cw([]).status, 64));
  it('bad duration → 64', () => assert.equal(cw(['--max-wait', 'soon', '--', 'true']).status, 64));
  it('--wait-only with a command → 64', () => assert.equal(cw(['--wait-only', '--', 'true']).status, 64));
});

describe('pass-through: no limit', () => {
  it('exit 0 passes through; stdout streams to stdout; stderr streams to stderr', () => {
    resetClock();
    const r = cw(['--', ...node(`console.log('to-stdout'); console.error('to-stderr')`)]);
    assert.equal(r.status, 0, 'exit 0 passes through');
    assert.equal(chompEnd(r.stdout), 'to-stdout', 'stdout streams to stdout');
    assert.equal(chompEnd(r.stderr), 'to-stderr', 'stderr streams to stderr');
  });
  it('exit 3 passes through (no limit)', () => assert.equal(cw(['--', ...node(`console.error('nope'); process.exit(3)`)]).status, 3));
  it('…and no time passed', () => assert.equal(clock(), T0));
  it('limit text but exit 0 → not a limit', () => {
    assert.equal(cw(['--', ...node(`console.log('a review quoting: You have hit your usage limit')`)]).status, 0);
  });
  it('plain failure, no limit message → 7', () => assert.equal(cw(['--', ...node('process.exit(7)')]).status, 7));
});

describe('a parsed reset time', () => {
  const R = Math.floor(T0 / 60) * 60 + 3 * 3600; // Codex prints whole minutes
  let r: Run;
  it('limited once, then ok → exit 0', () => {
    resetClock();
    stub(1, limitMsg(R));
    r = cw(['--', ...STUB]);
    assert.equal(r.status, 0);
  });
  it('ran twice', () => assert.equal(runs(), 2));
  it('waited until the reset + 2m margin', () => assert.equal(clock(), R + 120));
  it('names the reset time', () => assert.match(r.stderr, /it resets/));
  it('the review reached stdout', () => assert.equal(chompEnd(r.stdout), 'review: looks fine'));
  it('--margin 10m', () => {
    resetClock();
    cw(['--margin', '10m', '--', ...STUB]);
    assert.equal(clock(), R + 600);
  });
  it("'try again in 2 hours 5 minutes' form", () => {
    resetClock();
    stub(1, "You've hit your usage limit. Try again in 2 hours 5 minutes.");
    cw(['--', ...STUB]);
    assert.equal(clock(), T0 + 7500 + 120);
  });
  let e: Run;
  it("message hidden, found in Codex's session log → waits, exit 0", () => {
    resetClock();
    stub(1, '');
    writeFileSync(path.join(SESS, 'rollout-1.jsonl'), `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: { message: limitMsg(R) } } })}\n`);
    e = cw(['--', ...STUB]);
    assert.equal(e.status, 0);
  });
  it('…says it came from the log', () => assert.match(e.stderr, /session log/));
  it('…waited until the logged reset + margin', () => assert.equal(clock(), R + 120));
});

describe('an unparseable message → fixed interval', () => {
  let r: Run;
  it('waits --interval, then runs again → exit 0', () => {
    resetClock();
    clearLogs();
    stub(1, "You've hit your usage limit. Try again later.");
    r = cw(['--interval', '45m', '--', ...STUB]);
    assert.equal(r.status, 0);
  });
  it('waited 45m', () => assert.equal(clock(), T0 + 2700));
  it('says no reset time was found', () => assert.match(r.stderr, /no reset time/));
});

describe('the cap', () => {
  let r: Run;
  it('reset 30h away, cap 24h → 75 at once', () => {
    resetClock();
    stub(9, limitMsg(Math.floor(T0 / 60) * 60 + 30 * 3600));
    r = cw(['--', ...STUB]);
    assert.equal(r.status, 75);
  });
  it('…without waiting', () => assert.equal(clock(), T0));
  it('…and without running it again', () => assert.equal(runs(), 1));
  it('says it is not a pass', () => assert.match(r.stderr, /NOT a pass/));
  it('limited every time → 75 when the total would pass the cap', () => {
    resetClock();
    stub(99, "You've hit your usage limit.");
    assert.equal(cw(['--interval', '1h', '--max-wait', '3h', '--', ...STUB]).status, 75);
  });
  it('…after 3 one-hour waits', () => assert.equal(clock(), T0 + 10800));
  it('…and 4 runs', () => assert.equal(runs(), 4));
});

describe('an OLD limit in a session log that has been written to since is no limit', () => {
  const R = Math.floor(T0 / 60) * 60 + 3 * 3600;
  const log3 = path.join(SESS, 'rollout-3.jsonl');
  it('an unrelated failure → its own exit code, at once', () => {
    resetClock();
    clearLogs();
    writeFileSync(
      log3,
      `${JSON.stringify({ timestamp: iso(T0 - 2 * 86400), type: 'event_msg', payload: { type: 'task_complete', error: { message: limitMsg(Math.floor(T0 / 60) * 60 - 86400) } } })}\n` +
        `${JSON.stringify({ timestamp: iso(T0), type: 'event_msg', payload: { type: 'token_count' } })}\n`,
    );
    const r = cw(['--max-wait', '3h', '--', ...STUB3]);
    assert.equal(`${r.status}:${runs()}:${clock()}`, `3:1:${T0}`);
  });
  it('…but a limit logged since the run started still counts', () => {
    resetClock();
    appendFileSync(log3, `${JSON.stringify({ timestamp: iso(T0), type: 'event_msg', payload: { type: 'task_complete', error: { message: limitMsg(R) } } })}\n`);
    stub(1, '');
    const r = cw(['--', ...STUB]);
    assert.equal(`${r.status}:${clock()}`, `0:${R + 120}`);
    clearLogs();
  });
});

describe('--wait-only', () => {
  const R = Math.floor(T0 / 60) * 60 + 3 * 3600;
  let r: Run;
  it('--message: waits, exit 0', () => {
    resetClock();
    r = cw(['--wait-only', '--message', limitMsg(R)]);
    assert.equal(r.status, 0);
  });
  it('…until the reset + margin', () => assert.equal(clock(), R + 120));
  it('…then says to run the step again', () => assert.match(r.stderr, /Run the step again/));
  it('--message without a limit → 64', () => {
    resetClock();
    assert.equal(cw(['--wait-only', '--message', 'all fine']).status, 64);
  });
  it('reset already past → exit 0 at once', () => {
    resetClock();
    const x = cw(['--wait-only', '--message', limitMsg(Math.floor(T0 / 60) * 60 - 3600)]);
    assert.equal(`${x.status}${clock()}`, `0${T0}`);
  });
  it('past the cap → 75', () => {
    resetClock();
    assert.equal(cw(['--wait-only', '--message', limitMsg(Math.floor(T0 / 60) * 60 + 30 * 3600)]).status, 75);
  });
  it("no --message: reads Codex's session log", () => {
    resetClock();
    writeFileSync(path.join(SESS, 'rollout-2.jsonl'), `${JSON.stringify({ payload: { error: { message: limitMsg(R) } } })}\n`);
    const x = cw(['--wait-only']);
    assert.equal(`${x.status}${clock()}`, `0${R + 120}`);
  });
  it('nothing to go on → waits --interval', () => {
    resetClock();
    clearLogs();
    const x = cw(['--wait-only', '--interval', '20m']);
    assert.equal(`${x.status}${clock()}`, `0${T0 + 1200}`);
  });
});

describe('a REVIEWS.md whose reviewer hit the limit is no review', () => {
  const RV = path.join(WORK, '07-REVIEWS.md');
  const review = (body: string): void => {
    writeFileSync(RV, `---\nphase: 7\nreviewers: [codex]\n---\n\n# Cross-AI Plan Review — Phase 7\n\n## Codex Review\n\n${body.replace(/\n+$/, '')}\n\n---\n\n## Consensus Summary\n\nok\n`);
  };
  const problem = (provider: string): string | null => reviewsProblem(RV, provider);
  it('a real Codex review is usable', () => {
    review('Strong plan.\n\n### Concerns\n- HIGH: x');
    assert.equal(problem('codex'), null);
  });
  it('an empty Codex section is not', () => {
    review('');
    assert.equal(problem('codex'), 'Codex Review is empty');
  });
  it('a Codex section with only the limit error is not', () => {
    review(`ERROR: You${RSQ}ve hit your usage limit. Try again at Oct 11th, 2026 1:22 AM.`);
    assert.equal(problem('codex'), 'Codex Review — usage limit hit');
  });
  it('a long review that quotes the message is usable', () => {
    review('Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nQuotes the message: hit your usage limit.');
    assert.equal(problem('codex'), null);
  });
  it('configured reviewer failed, another ok → not usable', () => {
    writeFileSync(RV, '## Claude Review\n\nGood.\n\n## Codex Review\n\nCodex review failed or returned empty output.\n');
    assert.equal(problem('codex'), 'Codex Review — reviewer failed');
  });
  it('…but fine when claude is the configured reviewer', () => assert.equal(problem('claude'), null));
  // gsd-core names reviewer instances: "## Codex Review (fast)"
  it('an instance section counts as its reviewer\'s', () => {
    writeFileSync(RV, '## Claude Review\n\nGood.\n\n## Codex Review (fast)\n\nCodex review failed or returned empty output.\n');
    assert.equal(problem('codex'), 'Codex Review (fast) — reviewer failed');
  });
  it('…and every instance empty is not usable', () => {
    writeFileSync(RV, '## Codex Review (fast)\n\n\n## Codex Review (deep)\n\n');
    assert.equal(problem('claude'), 'Codex Review (fast) is empty');
  });
  it('…a real instance review is usable', () => {
    writeFileSync(RV, '## Codex Review (fast)\n\nLooks fine.\n');
    assert.equal(problem('codex'), null);
  });
  it('a hand-recorded file without sections is not judged', () => {
    writeFileSync(RV, '');
    assert.equal(problem('codex'), null);
  });
  it('a missing file is not judged here', () => assert.equal(reviewsProblem(path.join(WORK, 'none.md'), 'codex'), null));
});

describe('a review body runs on past its own ## headings and ---', () => {
  const RV = path.join(WORK, '07b-REVIEWS.md');
  const LONG = 'a\nb\nc\nd\ne\nf\ng';
  const put = (t: string): void => {
    writeFileSync(RV, t);
  };
  const usable = (name: string, text: string): void => {
    it(name, () => {
      put(text);
      assert.equal(reviewsProblem(RV, 'codex'), null);
    });
  };
  const rejected = (name: string, text: string, why: string): void => {
    it(name, () => {
      put(text);
      assert.equal(reviewsProblem(RV, 'codex'), why);
    });
  };
  // the layout gsd-core's template asks for: one ## section per plan id
  usable('## plan sections under the review are usable', '## Codex Review\n\n## 30-01\nx\ny\n\n---\n\n## 30-02\nz\n\n---\n\n## Consensus Summary\n\nok\n');
  usable('### plan sections are usable', '## Codex Review\n\n### 30-01\nx\n\n### 30-02\nz\n\n---\n\n## Consensus Summary\n\nok\n');
  usable('an instance heading with ## plan sections is usable', '## Codex Review (fast)\n\n## 30-01\nx\n\n## 30-02\ny\n');
  usable("a reviewer's own ## Summary first is usable", '## Codex Review\n\n## Summary\nx\n\n## Concerns\ny\n');
  usable('a plan heading ending in Review stays in the body', '## Codex Review\n\n## 30-01 Code Review\nx\ny\n\n## Plan 30-02 Review\nz\n');
  usable('a --- before the first plan section is usable', '## Codex Review\n\n---\n\n## 30-01\nx\ny\n');
  usable('a --- does not cut a long body that quotes the limit', `## Codex Review\n\nAn earlier run hit your usage limit.\n\n---\n\n${LONG}\n`);
  rejected("nothing but the template's --- is empty", '## Codex Review\n\n---\n\n## Consensus Summary\n\nok\n', 'Codex Review is empty');
  rejected("the consensus text is not the review's body", `## Codex Review\n\n## Consensus Summary (one reviewer)\n\n${LONG}\n`, 'Codex Review is empty');
  rejected('## headings with no findings are empty', '## Codex Review\n\n## 30-01\n## 30-02\n## 30-03\n## 30-04\n## 30-05\n## 30-06\n\n---\n', 'Codex Review is empty');
  rejected('### headings with no findings are empty', '## Codex Review\n\n### 30-01\n### 30-02\n\n---\n', 'Codex Review is empty');
  rejected('a limit message under a plan heading is the limit', '## Codex Review\n\n## 30-01\nYou hit your usage limit.\n\n---\n\n## Consensus Summary\n\nok\n', 'Codex Review — usage limit hit');
  rejected(
    'two reviewers, the configured one failed',
    '## Claude Review\n\n## 30-01\ngood\n\n---\n\n## Codex Review\n\nCodex review failed or returned empty output.\n\n---\n',
    'Codex Review — reviewer failed',
  );
  // notes people add after a review section must not count as its body
  rejected('an empty review followed by --- and notes is empty', `## Codex Review\n\n---\n\n## Verification\n\n${LONG}\n`, 'Codex Review is empty');
  rejected('a failed review followed by --- and notes failed', `## Codex Review\n\nCodex review failed or returned empty output.\n\n---\n\n## Verification\n\n${LONG}\n`, 'Codex Review — reviewer failed');
});
