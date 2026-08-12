import io, sys
P = "src/x402.mjs"
s = io.open(P, encoding="utf-8").read()
IMP_OLD = "import { EVENT } from './ledger.mjs';"
IMP_NEW = "import { CHALLENGE_TAG } from './catalog.mjs';\nimport { EVENT } from './ledger.mjs';"
ACC_OLD = """          maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
        },
      ],"""
ACC_NEW = """          maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
          // Global x402 Challenge attribution. The leaderboard filters on
          // accepts[].extra.tag, NOT resource.tags. Confirmed by the Algorand
          // Foundation 2026-08-11; settlements before this were not counted.
          // resource.tags stays as it is, for Bazaar discovery.
          extra: { tag: CHALLENGE_TAG },
        },
      ],"""
if "extra: { tag: CHALLENGE_TAG }" in s:
    print("ALREADY PATCHED"); sys.exit(0)
if s.count(IMP_OLD) != 1: print("FAIL import anchor", s.count(IMP_OLD)); sys.exit(1)
if s.count(ACC_OLD) != 1: print("FAIL accepts anchor", s.count(ACC_OLD)); sys.exit(1)
io.open(P, "w", encoding="utf-8").write(s.replace(IMP_OLD, IMP_NEW).replace(ACC_OLD, ACC_NEW))
print("PATCHED")
