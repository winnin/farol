<!-- farol -->
### farol · merge risk 10/100 (low) · ◐ quick review

Most of the risk comes from `unsafe.ts`, new code not used by existing pages and `legacy.ts`, additive change: nothing that existed changed. 2 code files changed; 0 of 4 existing pages run changed code.

✓ Low risk and nothing to check by hand: likely safe to approve.

<sub>farol only informs: it never approves or blocks.</sub>

**Files by risk** (points are each part's share of the 10)
- 🟠 `src/lib/unsafe.ts` **8**
- and 1 file to skim: 2 points together

<details>
<summary>All signals</summary>

- **Why this review:** 3 new suppression(s) (lint/type/security ignores); diff coverage not verified: risk is counted as if nothing were tested
- **Risk:** 0 high, 0 medium, 2 low
- **Vulnerabilities in added or changed dependencies:** not verified
- **Diff coverage:** not verified
- **Lint on changed lines:** not verified
- **Added suppressions:** 3
  - `src/lib/unsafe.ts:1` `eslint-disable-next-line`
  - `src/lib/unsafe.ts:3` `ts-expect-error`
  - `src/lib/unsafe.ts:4` `as-any`
- **Modified existing tests:** none

</details>

<details>
<summary>Classification — open only after reviewing</summary>

**Class:** `isolated` — isolated: only adds new paths (new routes and files)

**Reasons:**
- only new declarations, comments or formatting (`declarations-additive`) `src/lib/legacy.ts`: only additions: new declarations src/lib/legacy.ts#version
- new file no route reaches (`new-file-disconnected`) `src/lib/unsafe.ts`: new file that no route reaches
- no existing code touched (`no-existing-code-touched`): the PR only adds new files, routes, exports or keys, or changes tests

**New routes:** none

**Affected existing routes:** none

**New files no route reaches:**
- `src/lib/unsafe.ts`

**Was the classification right? Tick one option:**
- [ ] I agree with the classification
- [ ] I disagree: the PR changed existing behavior
- [ ] I disagree: the PR was isolated and farol missed it

</details>

<sub>farol &lt;version&gt; · analyzed commit 0123456789ab · shadow mode</sub>
