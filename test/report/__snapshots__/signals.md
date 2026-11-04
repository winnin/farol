<!-- farol -->
### farol · merge risk 8/100 (low) · ◐ quick review

Most of the risk comes from a lint error in `format.ts` and `discount.ts`, new code not used by existing pages. 2 code files changed; 0 of 4 existing pages run changed code.

<sub>farol only informs: it never approves or blocks.</sub>

**Must check** (by hand, before approving)
- [ ] Lint error at `format.ts:9`: `no-magic-numbers`, No magic number: 100. — **5**

**Files by risk** (points are each part's share of the 8)
- 2 files to skim: 3 points together

**New code tested:** 44% (4 of 9 changed lines), 67% without 1 file not in the coverage report

<details>
<summary>All signals</summary>

- **Why this review:** diff coverage 44%; 1 lint error(s) on changed lines
- **Risk:** 0 high, 0 medium, 2 low
- **Vulnerabilities in added or changed dependencies:** not verified
- **Diff coverage:** 44.4% (4 of 9 changed executable lines covered) — uncovered ranges:
  - `src/lib/discount.ts` (missing from the coverage report): 1–3
  - `src/lib/format.ts`: 7, 14
- **Lint on changed lines:** 1 error, 1 warning (outside the changed lines: 1 error, 1 warning)
  - `src/lib/format.ts:9` error `no-magic-numbers`: No magic number: 100.
  - `src/lib/format.ts:14` warning `no-nested-ternary`: Do not nest ternary expressions.
- **Added suppressions:** none
- **Modified existing tests:** none

</details>

<details>
<summary>Classification — open only after reviewing</summary>

**Class:** `isolated` — isolated: only adds new paths (new routes and files)

**Reasons:**
- only new declarations, comments or formatting (`declarations-additive`) `src/lib/format.ts`: only additions: new declarations src/lib/format.ts#formatCount, src/lib/format.ts#formatPercent
- new file no route reaches (`new-file-disconnected`) `src/lib/discount.ts`: new file that no route reaches
- no existing code touched (`no-existing-code-touched`): the PR only adds new files, routes, exports or keys, or changes tests

**New routes:** none

**Affected existing routes:** none

**New files no route reaches:**
- `src/lib/discount.ts`

**Was the classification right? Tick one option:**
- [ ] I agree with the classification
- [ ] I disagree: the PR changed existing behavior
- [ ] I disagree: the PR was isolated and farol missed it

</details>

<sub>farol &lt;version&gt; · analyzed commit 0123456789ab · shadow mode</sub>
