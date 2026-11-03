# Yelp discovery acceptance examples

YELP-01 maps to `tests/adapters/yelp.test.ts` and `tests/adapters/yelp-research.test.ts`.

- Given public dinner location and private participant requirements, Yelp receives only city/area and a generic restaurant term or safe positive cuisine terms.
- Given candidates, Muse receives transient name/address hints, without Yelp phone, price tiers, reviews or ratings. Persisted identities require independent location and name support.
- Given expired cached content, a subsequent lookup fetches fresh data. Cached objects are isolated from caller mutation and removed within the maximum retention period.
- Given unauthorized, rate-limited, malformed or unavailable directory access, web research continues and organizer diagnostics contain only typed status and IDs.
- Given focused verification of a selected restaurant, discovery does not search for replacements.
- Given credentials without production usage mode, existing web research remains the live path.

- Given Japanese as a flexible preference, discovery asks for Japanese restaurants before falling back. Arbitrary text and negative preferences do not become directory queries.
- Given independently supported name, address and city but unverified neighborhood, keep the suggestion with location still unconfirmed; do not falsely declare feasibility.
- Given a grounded identity but an unknown price claim on Yelp, scrub the claim rather than deleting the identified suggestion.
- Given verification failures, store aggregate typed reasons without raw restaurant text or private input and show clear organizer guidance.

- Given a direct page retrieval failure and completed non-Yelp search-tool text containing the exact name, street and city, retain identity while feasibility details remain unknown. Model prose, mismatched query URLs, unsafe redirects and successfully fetched conflicting pages cannot use this fallback. Fragment and root trailing-slash variants are equivalent for source provenance; query parameters are preserved.
