// Pinned before Jest forks its workers, so every test process inherits it.
// Node reads TZ once, at the first `Date` use in a process, which is why this
// belongs here rather than in `jest.setup.js` — by the time a setup file runs
// the framework has already constructed Dates and the zone is fixed.
//
// Deliberately NOT 'UTC'. The item detail screen formats `createdAt` with the
// local-time getters (`getDate()`/`getMonth()`/`getFullYear()`), and under a
// UTC pin a UTC-getter implementation and a local-getter one are
// indistinguishable — the test that is supposed to catch the difference would
// pass against both. America/Los_Angeles is a large negative offset, so
// `2026-08-02T01:00:00.000Z` reads as 1 August locally and 2 August in UTC,
// and the two are told apart. Any fixed non-UTC zone would do; this one is
// named in `app/items/[id].tsx`'s own comment as the worked example.
process.env.TZ = 'America/Los_Angeles';

module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
