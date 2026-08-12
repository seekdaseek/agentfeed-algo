import io, sys
P = "test/wiring.test.mjs"
s = io.open(P, encoding="utf-8").read()
ANCHOR = """  for (const e of compiled) {
    assert.ok(e.tags.includes(CHALLENGE_TAG), `${e.id} is missing the challenge tag`);
  }
});
"""
NEW = ANCHOR + """
/**
 * Where the tag lives is not cosmetic. The Global x402 Challenge leaderboard
 * filters on accepts[].extra.tag, not on resource.tags. Confirmed by the
 * Algorand Foundation on 2026-08-11, after six mainnet settlements went
 * unattributed because the tag was only ever on the resource. ExactAvmScheme
 * merges extra rather than replacing it, so feePayer survives alongside.
 */
test('the challenge tag rides in accepts.extra, which is where the leaderboard reads it', async () => {
  const { CHALLENGE_TAG } = await import('../src/catalog.mjs');
  const cfg = loadConfig(baseEnv());
  const routes = buildRoutes(compileCatalog(), cfg);
  assert.ok(Object.keys(routes).length > 0);
  for (const [path, r] of Object.entries(routes)) {
    assert.ok(r.tags.includes(CHALLENGE_TAG), `${path} lost the tag on resource.tags`);
    assert.ok(r.accepts.length > 0, `${path} has no payment options`);
    for (const accept of r.accepts) {
      assert.equal(
        accept.extra?.tag,
        CHALLENGE_TAG,
        `${path} does not carry the challenge tag in accepts.extra; the leaderboard will not attribute its settlements`,
      );
    }
  }
});
"""
if "which is where the leaderboard reads it" in s:
    print("ALREADY PATCHED"); sys.exit(0)
if s.count(ANCHOR) != 1:
    print("FAIL anchor count", s.count(ANCHOR)); sys.exit(1)
io.open(P, "w", encoding="utf-8").write(s.replace(ANCHOR, NEW))
print("PATCHED test/wiring.test.mjs")
