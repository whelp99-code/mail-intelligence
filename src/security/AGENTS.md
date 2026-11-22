# src/security

**Score:** 9. Code ratio, symbol density, exports, and reference centrality. Distinct domain: tailnet proxy, recipient allowlist, static path, and a policy helper that is not the live gate.

## OVERVIEW

Network and send-recipient checks plus static-file resolution. `server.mjs` does not import `safety-policy.js`.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Tailnet TCP proxy | `tcp-allowlist-proxy.js` | CIDR allowlist. `createAllowlistedTcpProxy` is the runner. |
| Allowed hosts | same file | `parseTailnetAllowedHosts` is what `server.mjs` and `activate-user-service.sh` import. |
| Send recipients | `mail-send-recipient-policy.js` | Env allowlist. Graph send and draft modules import the assert. |
| Static files | `static-path.js` | `resolveStaticFile` is the server static root check. |
| Service URL | `service-url.js` | Loopback hostname check for tests and URL validation. |
| Policy helper | `safety-policy.js` | Env flags only. Imported by `test/safety-policy.test.js`, not by `server.mjs`. |

## CONVENTIONS

- Denial throws `Error` with `statusCode` and `code` (`CAPABILITY_DISABLED`, `EXTERNAL_ACTION_DISABLED`). This file does not define `MutationDisabledError`.
- `getSafetyPolicy` here reads `MAIL_INTELLIGENCE_ALLOW_*` with no break-glass requirement. That is a different function from `src/safety.js`.
- IPv4 CIDR parsing is explicit. Do not pass hostnames through `ipv4InCidr`.
- `npm run check` syntax-checks `safety-policy.js`, `static-path.js`, and `service-url.js`.

## ANTI-PATTERNS

- Do not wire `safety-policy.js` into `server.mjs` as a second live gate. Listen and mutation stay in `src/safety.js`.
- Do not treat `MAIL_INTELLIGENCE_ALLOW_SEND=1` in this helper as permission to send. The live path still requires the approval boundary.
- Do not widen `resolveStaticFile` to a caller-supplied root.
- Do not log proxy credentials or recipient allowlist contents in verify scripts.

## NOTES

Tailnet activate scripts call `loadProxyConfig` and `parseTailnetAllowedHosts`. A proxy that is running is not evidence that mail send is enabled.
