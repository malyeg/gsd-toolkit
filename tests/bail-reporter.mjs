// Extra test reporter for CI (runs next to TAP): stops the whole run once GSD_TEST_MAX_FAILS leaf tests
// (a test with no failed subtest) have failed, so a broken shard is red in minutes, not after the timeout.
export default async function* bail(source) {
  const max = Number(process.env.GSD_TEST_MAX_FAILS || 15);
  let n = 0;
  for await (const e of source) {
    if (e.type !== 'test:fail') continue;
    if (e.data?.details?.error?.failureType === 'subtestsFailed') continue;
    n++;
    if (n >= max) {
      yield `bail: ${n} failures, stopping\n`;
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 200).unref?.();
      process.exit(1);
    }
  }
}
