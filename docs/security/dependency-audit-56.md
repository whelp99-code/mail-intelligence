# Issue 56: existing lockfile audit

Baseline: main `cbc1ef78ef9992da2debc76686114d4ac7ee43c3`.
`npm audit --json` exits 1: eight high entries and one moderate entry.
These are nine package entries, not nine independent root advisories:
three advisories propagate through the CSS tooling graph.

All 208 installed-package entries have `dev: true`; package.json has four
devDependencies and no production dependencies. No application import of
these packages was identified. This is a source-bound production-path
assessment, not a claim about arbitrary operator-configured subprocesses.
Developer and pull-request CSS/configuration input can reach the tooling.

## Complete baseline disposition

| Package | Version | Severity | Direct? | Scope | Actual path and disposition |
| --- | --- | --- | --- | --- | --- |
| braces | 3.0.3 | high | no | development | stylelint -> micromatch -> braces; also fast-glob/globby. No product path. Actual installed API with depth 4,900 reproduces RangeError; bounded private compatibility fork fixes the parser, not just audit metadata. |
| fast-glob | 3.3.3 | high | no | development | stylelint -> fast-glob, or stylelint -> globby -> fast-glob -> micromatch -> braces. Propagated advisory; retain compatible version and repair leaf. |
| globby | 11.1.0 | high | no | development | stylelint -> globby -> fast-glob. Propagated braces advisory, no product import. |
| micromatch | 4.0.8 | high | no | development | stylelint -> micromatch -> braces; fast-glob also consumes it. Propagated advisory; verify real glob behavior with repaired leaf. |
| postcss-selector-parser | 7.1.4 | moderate | no | development | stylelint and selector-specificity -> selector parser. Repository CSS is the input, not mail HTML; compatible 7.1.6 fixes quadratic flat-selector parsing. |
| source-map-js | 1.2.1 | high | no | development | stylelint -> postcss/css-tree -> source-map-js. No product source-map consumer found; compatible 1.2.2 fixes indexed section offset exhaustion. |
| stylelint | 16.26.1 | high | yes | development | package.json runs `stylelint src/styles.css`; CI calls CSS validation. Propagated graph advisory; retain 16.26.1 and the current lint rules. |
| stylelint-config-recommended | 14.0.1 | high | no | development | stylelint-config-standard -> recommended, with stylelint peer. Propagated graph advisory; retain compatible configuration. |
| stylelint-config-standard | 36.0.1 | high | yes | development | .stylelintrc.json extends standard; standard -> recommended/stylelint peer. No product execution; retain 36.0.1 rather than downgrade rules. |

Concrete repository entrypoints: package.json `validate:css`, `.stylelintrc.json`,
and `.github/workflows/ci.yml` CSS validation. The server serves static CSS
bytes; mail normalization uses local code, not these parsers. Attachment
scanning can invoke an operator-configured executable; deployed configuration
was deliberately not inspected or changed.

The runtime-reachable package upgrade set is empty. Development-only does
not waive the required audit: repair its leaves so the same gate passes.
No audit ignore list, omit-dev audit, threshold reduction or failure masking.

## Version and major-impact decision

The registry has no published braces fix beyond vulnerable 3.0.3. npm's
suggested stylelint 7.7.0/config-standard 15.0.1 downgrade would replace the
current modern rules and is rejected. Instead reuse the existing reviewed
MIT source-preserving braces patch from the accepted source `70fa07f`, scoped
to its vendor package only. It enforces brace and parenthesis AST depth 100
before recursive walkers; the original 10,000-character limit stays intact.
Private version 3.0.4 identifies this actual source patch, not an upstream
release and not a version-only relabel.

Selector-parser 7.1.4 -> 7.1.6 and source-map-js 1.2.1 -> 1.2.2 are compatible
same-major patch updates with unchanged dependency contracts. Existing
direct ranges and stylelint/config versions remain unchanged. No major
upgrade, product code, database schema or operational setting change.

Advisories:

- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/advisories/GHSA-rj75-hqrm-r3gf
- https://github.com/advisories/GHSA-68fv-2mgg-jv7q

## Verification

The original installed braces compile API reproduces
`RangeError: Maximum call stack size exceeded` at depth 4,900.
The installed-package boundary regression is run before the patch and must
fail, then run after a fresh locked install and must pass. It covers normal
expansion, the exact depth-100 boundary, and depth 101/4,900 for both brace
and parenthesis ASTs. Actual tooling and final audit results are recorded
in the measured check section below.

## Captured final checks

Node 22.23.2 / npm 10.9.8, fresh exact lockfile install:

| Invocation | Observed result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Exit 0, 208 installed packages. No lockfile generation or broad update. |
| `node scripts/run-tests-isolated.mjs test/braces-depth-limit.test.js test/repository-policy.test.js` | 12 PASS, 0 FAIL; test-owned temporary directory removed by the runner. |
| `npm audit --audit-level=high` | Exit 0, `found 0 vulnerabilities`; the original CI gate is unchanged. |
| `npm run lint` | Exit 0. |
| `npm run validate:css` | Exit 0 with the existing stylesheet/config and stylelint 16.26.1. |
| `npm run validate:html` | Exit 0, one file scanned and no errors. |
| `eslint vendor/braces/index.js vendor/braces/lib/*.js test/braces-depth-limit.test.js` | Exit 0, no exemptions. |
| `node --check` on each vendored JS file, plus `git diff --check` | Exit 0. |

The final actual dependency API scenario is:

```sh
node --input-type=module -e '
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const mm=require("micromatch");
assert.deepEqual(mm(["src/a.js","src/b.mjs","data/a"],"src/*.{js,mjs}"),["src/a.js","src/b.mjs"]);
const selector=require("postcss-selector-parser");
const flat=".a".repeat(20000);
assert.equal(selector().processSync(flat),flat);
const {SourceMapGenerator,SourceMapConsumer}=require("source-map-js");
const gen=new SourceMapGenerator({file:"out.css"});
gen.addMapping({generated:{line:1,column:0},original:{line:2,column:3},source:"in.css"});
const leaf=gen.toJSON();
const indexed=line=>({version:3,sections:[{offset:{line,column:0},map:leaf}]});
const consumer=new SourceMapConsumer(leaf);
assert.equal(consumer.originalPositionFor({line:1,column:0}).source,"in.css");
for(const line of [-1,0.5,10000001])assert.throws(()=>new SourceMapConsumer(indexed(line)));
assert.throws(()=>new SourceMapConsumer({version:3,sections:[{offset:{line:6000000,column:0},map:indexed(6000000)}]}));
console.log(JSON.stringify({stage:"PATCHED_DEPENDENCY_APIS",glob:true,flatSelectorClasses:20000,sourceMapNormal:true,rejectedInvalidOffsets:3,rejectedNestedOffset:true}));
'
```

Observed exit 0 with all six reported fields matching the invocation.
This checks actual installed glob behavior, flat-selector output, normal
source-map lookup and oversized/negative/fractional/nested offset rejection
without timing luck or sending/synchronizing mail.

An initial manual smoke used indexed line 1/column 0 as its normal lookup
and failed (`null`, expected `in.css`). Direct original 1.2.1 versus patched
1.2.2 comparison established identical behavior: flat column 0 works,
indexed column 0 returns null, indexed column 1 works. The new QA expectation
was corrected to the normal flat-map contract; no existing test or product
code was changed to hide this unchanged library boundary.

LSP diagnostics could not initialize because this JS repository has no
TypeScript installation or type script. This is not counted as a clean
language-server result; actual syntax/lint and installed API checks passed.

Self-review: the HEAVY tier held because this is a security parser repair.
The source-preserving vendor code and license match the already-reviewed
remediation. Only actual leaf versions and their local binding moved;
all direct tool versions, lint configuration, CI policy, product code and
operational settings remain unchanged. No ulw-plan was produced, so the
bare-ultrawork gate is this recorded self-review, not an additional reviewer.
