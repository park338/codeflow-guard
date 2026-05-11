# CodeFlow Guard Examples

This folder provides multi-language review samples for validating coverage across
critical boundaries. These examples are intentionally risky and are meant for
review demonstrations only.

## Projects

- `demo-project` (JavaScript / Node.js)
- `python-order-service` (Python)
- `go-checkout-service` (Go)

## Boundary Coverage Matrix

| Boundary | JS | Python | Go |
| --- | --- | --- | --- |
| Auth bypass on missing/invalid credential | yes | yes | yes |
| Hardcoded token / API key | yes | yes | yes |
| Sensitive credential logging | yes | yes | yes |
| Skipped critical tests | yes | yes | yes |
| Negative quantity not validated | yes | yes | yes |
| Percent coupon not capped | yes | yes | yes |
| JSON parsing / request handling risk | yes | yes | yes |
| Runtime error / panic path | yes | yes | yes |

## Suggested Review Commands

```bash
node scripts/collect-review-context.js --repo . --no-tests --brief-only
node scripts/collect-review-context.js --repo . --path examples/python-order-service
node scripts/collect-review-context.js --repo . --path examples/go-checkout-service
```

