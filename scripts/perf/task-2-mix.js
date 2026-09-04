'use strict';

/**
 * RULING 5, DISCHARGED: what "a simulated concurrent user" is in Task 2, fixed
 * in one file BEFORE anything was counted, and required by both the negative
 * controls and the measurements so they cannot drift apart.
 *
 * ------------------------------------------------------------------------
 * THE DEFINITION
 * ------------------------------------------------------------------------
 * A SIMULATED CONCURRENT USER is one client that:
 *
 *   1. holds ONE outstanding request at a time and waits for the response
 *      before issuing the next -- a closed loop, so N users means at most N
 *      requests in flight;
 *   2. opens its OWN TCP connection per request (keep-alive off, so the
 *      per-request byte counts stay attributable -- see `lib/http.js`);
 *   3. draws each request IN ORDER from the weighted mix below, starting at
 *      its own offset, so a run of N users issues a KNOWN number of each
 *      request type rather than a sampled approximation;
 *   4. waits a STATED think time between requests. The primary runs use
 *      0 ms, which is the harshest reading of "50 simultaneous users" and the
 *      one a stability claim should be judged on; a 1000 ms run is reported
 *      beside it because a real user does not tap continuously.
 *   5. carries a real bearer token verified by `requireAuth` on every request.
 *
 * FIFTY OF THESE IS NOT: fifty idle sockets (which cost the server nothing),
 * fifty requests per second (an open loop, a different shape entirely), or
 * fifty users spread over a minute. Those three all share the headline
 * "50 simultaneous users" and none of them is this.
 *
 * ------------------------------------------------------------------------
 * WHERE THE MIX COMES FROM
 * ------------------------------------------------------------------------
 * Not invented. It is the set of GETs the mobile app's five tabs issue on
 * focus, weighted by how many screens issue each:
 *
 *   apps/mobile/app/(tabs)/index.tsx      -> useWardrobe        GET /items
 *   apps/mobile/app/(tabs)/search.tsx     -> useCommunityFeed   GET /community/posts
 *   apps/mobile/app/(tabs)/favorites.tsx  -> useSavedPosts      GET /community/saved
 *   apps/mobile/app/(tabs)/profile.tsx    -> useWearHistory     GET /wear-history
 *                                            useUsageAnalytics  GET /analytics/usage
 *                                            useWardrobe        GET /items
 *   apps/mobile/src/outfits/useOutfits.ts                       GET /outfits
 *
 * NO `?limit=` ON ANY OF THEM, deliberately, because the client sends none:
 * `buildFeedQuery` in `apps/mobile/src/community/api.ts` documents that adding
 * one is not a free optimisation, and the server's default of 24 is what the
 * app actually receives. Measuring `limit=100` would measure a request this
 * app never sends.
 *
 * `GET /suggestions` IS DELIBERATELY EXCLUDED from the primary mix and is
 * measured separately. It proxies to the Python AI service in another
 * container, so a stability number that includes it is a number about two
 * servers and a VM boundary, not about "the backend API server" that Claim 6
 * names. Excluding it would be cheating if it were hidden; it is reported
 * separately instead, with its own 50-user run, so the effect of including it
 * is a number rather than an assumption.
 */

const PRIMARY_MIX = [
  // Wardrobe grid: the Wardrobe tab and the Profile tab both read it.
  { name: 'GET /items', path: '/items', weight: 4 },
  // Community feed: the Search tab. This is the Claim 4 request.
  { name: 'GET /community/posts', path: '/community/posts', weight: 3 },
  // Outfit list.
  { name: 'GET /outfits', path: '/outfits', weight: 2 },
  // Saved posts: the Favorites tab.
  { name: 'GET /community/saved', path: '/community/saved', weight: 2 },
  // Profile tab.
  { name: 'GET /wear-history', path: '/wear-history', weight: 1 },
  { name: 'GET /analytics/usage', path: '/analytics/usage', weight: 1 },
  // Session check on app open.
  { name: 'GET /auth/me', path: '/auth/me', weight: 1 },
];

/** The primary mix plus the AI-service-backed suggestion endpoint. */
const MIX_WITH_SUGGESTIONS = [...PRIMARY_MIX, { name: 'GET /suggestions', path: '/suggestions', weight: 1 }];

const DEFINITION =
  'A simulated concurrent user = one client, one outstanding request at a time (closed loop), ' +
  'its own TCP connection per request (keep-alive off), requests drawn in order from the ' +
  'weighted mix of the seven GETs the mobile app\'s tabs issue on focus, no ?limit= (the client ' +
  'sends none; the server default of 24 applies), a real bearer token verified on every request, ' +
  'and a stated think time between requests.';

/**
 * PRE-REGISTERED DEGRADATION CRITERIA -- written down before the sweep ran, so
 * "nothing degraded" cannot be produced by choosing the test afterwards.
 *
 * D2's threshold is 2000 ms because that is the tightest user-visible budget
 * any claim in the submitted document names (Claim 4, "rendering the first
 * batch of posts within 2 seconds"). It is not a number invented for this
 * sweep.
 */
const DEGRADATION_CRITERIA = [
  { id: 'D1', name: 'errors', description: 'any response that is not the expected status, or any connection error / timeout' },
  { id: 'D2', name: 'latency', description: 'mix p95 latency exceeds 2000 ms -- the tightest user-visible budget the submitted document names (Claim 4)' },
  { id: 'D3', name: 'throughput knee', description: 'requests/second at this concurrency is no more than 1.05x the requests/second at the previous step, i.e. added users buy less than 5% more throughput' },
];

module.exports = { PRIMARY_MIX, MIX_WITH_SUGGESTIONS, DEFINITION, DEGRADATION_CRITERIA };
