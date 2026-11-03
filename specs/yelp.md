# Yelp discovery acceptance examples

YELP-01 maps to `tests/adapters/yelp.test.ts` and `tests/adapters/yelp-research.test.ts`.

- Given public dinner location and private participant requirements, Yelp receives only city/area and a generic restaurant term.
- Given candidates, Muse receives transient name/address hints, without Yelp phone, price tiers, reviews or ratings. Persisted identities require independent location and name support.
- Given expired cached content, a subsequent lookup fetches fresh data. Cached objects are isolated from caller mutation and removed within the maximum retention period.
- Given unauthorized, rate-limited, malformed or unavailable directory access, web research continues and organizer diagnostics contain only typed status and IDs.
- Given focused verification of a selected restaurant, discovery does not search for replacements.
- Given credentials without production usage mode, existing web research remains the live path.
