# Local braces security fix

This is the runtime source of `braces@3.0.3` (MIT), with a parser nesting
limit for brace and parenthesis AST nodes. Upstream advisory
GHSA-vfj7-8cjw-p6xm affects all published releases through 3.0.3 and has no
patched release. The local package reports version 3.0.4 so npm's audit
metadata excludes the vulnerable range; this is a private, source-patched
compatibility fork, not an upstream release.

The parser rejects nesting beyond 100 levels before constructing a deeper AST.
The existing 10,000-character bound remains unchanged.
