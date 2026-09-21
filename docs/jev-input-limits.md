# Jev input-size testing

## Findings: 2026-09-18

Tested the direct `https://api.typesafe.ai/v1/systemone` endpoint with `model: jev-latest`, which resolved to **jev-1.13.0**. This did not go through Vercel AI Gateway.

The payload used patdown's one-question noul request shape, with the question `Does this diff add console.log debugging statements?` and a generated ASCII diff. No project files or secrets were submitted as input. Calls were sequential, with no retries.

| Synthetic diff bytes | JSON request bytes | HTTP | Reported input tokens |
| -------------------: | -----------------: | ---: | --------------------: |
|                1,024 |              1,347 |  200 |                   630 |
|               16,384 |             17,328 |  200 |                 5,633 |
|               65,536 |             68,446 |  200 |                22,018 |
|               81,920 |             85,478 |  200 |                27,601 |
|               90,112 |             93,989 |  200 |                30,474 |
|               94,208 |             98,245 |  200 |                31,909 |
|               96,256 |            100,373 |  200 |                32,630 |
|               96,512 |            100,639 |  200 |                32,718 |
|               96,768 |            100,904 |  200 |                32,808 |
|               97,536 |            101,702 |  400 |          Not returned |
|               98,304 |            102,500 |  400 |          Not returned |
|              262,144 |            272,724 |  400 |          Not returned |
|            1,500,000 |          1,558,085 |  400 |          Not returned |

The separately authorized 1.5 MB probe returned in 292 ms with the same token-limit rejection, not HTTP 413. It exceeded the checked-in probe script's safety cap and was run with a one-off harness.

Every rejected request returned:

```json
{ "detail": { "error_type": "max_tokens_exceeded" } }
```

A control request containing **131,072 spaces** succeeded: HTTP 200, 131,352 JSON request bytes, and only **2,363 reported input tokens**. A larger body succeeding while a smaller diff fails shows why a universal byte cutoff would be wrong.

There were 14 raw API probes (218,784 total reported input tokens on successful calls), plus one end-to-end CLI call reproducing the 97,536-byte rejection. Successful probabilities were not evaluated for judgment accuracy. This was a size/error-handling test, not a throughput or concurrency benchmark.

## What the boundary means

For this exact diff and question, the observed transition lies above 96,768 and at or below 97,536 input bytes. We did not determine the exact tokenizer limit. Successful usage already exceeds 32,768 reported input tokens, so it would be inaccurate to assert an exact 32,768-token ceiling from these results.

The API's token accounting, question overhead, model revision, and content all matter. Longer questions or rule bodies leave less room for input. Non-ASCII text, minified data, and generated identifiers can have very different bytes-to-token ratios. This report is empirical evidence for one model revision, not a provider SLA or a permanent limit for `jev-latest`.

Do not hardcode 96 KB as a safe limit. Reduce irrelevant diff content, or split evaluations only where the rule still makes sense without the other chunks. Cross-file or whole-diff rules may not survive splitting. Patdown does not silently truncate or automatically chunk inputs.

## Error handling

Previously, the System One client collapsed all non-success HTTP responses into `jev: System One request failed`. That hid the provider's token-limit rejection.

The TypeSafe Decision adapter preserves HTTP status, a validated provider error code, and the TypeSafe request ID. A token-limit rejection now exits 1 with:

```text
patdown: TypeSafe HTTP 400: model token limit exceeded; shorten the question/input or split it into smaller requests; code: max_tokens_exceeded; input UTF-8 bytes: 97536; request ID: req_...
```

The byte count is the state/input only, not the entire JSON request or a token estimate.

| Failure                         | Interpretation                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `max_tokens_exceeded`           | Provider explicitly rejected the token budget.                                                 |
| HTTP 413                        | HTTP payload too large; not necessarily the model context limit.                               |
| HTTP 401 / 403                  | Authentication or access rejection.                                                            |
| HTTP 429                        | Rate or quota limit; not proof of an oversized input.                                          |
| HTTP 5xx                        | Server/upstream failure; size might correlate, but the status does not establish a size limit. |
| Transport/request failure       | No usable HTTP response; not proof of a size limit.                                            |
| HTTP 2xx with an invalid result | Successful HTTP transport but an unreadable or incompatible response body.                     |

Only the token-limit rejection and successful responses were observed live. The other cases are covered by simulated HTTP tests, including non-JSON proxy errors. Arbitrary provider prose, HTML, request bodies, and authorization headers are not printed. Malformed error bodies do not hide the HTTP status.

## Reproduce direct Jev probes

This is a live, potentially billable diagnostic. It is never run by normal tests or CI. Set `TYPESAFE_API_KEY` in the environment; do not put it in the command line.

```sh
node scripts/probe-jev-input-size.mjs --live 1024 16384 65536 98304
node scripts/probe-jev-input-size.mjs --live 94208 96768 97536
node scripts/probe-jev-input-size.mjs --live --spaces 131072
```

The script emits JSON lines with input/request bytes, status, model, usage, and request ID. It stops at the first error and makes no retries, waits a second between calls, and imposes a 60-second per-call timeout. Inputs are synthetic; the script does not read project files. It permits at most 16 requests per invocation and at most 262,144 input bytes per request. These are diagnostic safeguards, not claimed API limits.

`TYPESAFE_DEFAULT_MODEL` can select a model. The endpoint is deliberately fixed to direct TypeSafe; `TYPESAFE_BASE_URL` is not used by this probe.

## Comparing Vercel AI Gateway

Gateway behavior was not tested. A custom gateway judge may use a different endpoint, request schema, model alias, context budget, timeout, or body-size limit. The changes here improve patdown's TypeSafe adapter, not an independently implemented Vercel adapter.

On the other machine, capture the exact model, status, provider error code, gateway/provider request IDs, elapsed time, and UTF-8/serialized request sizes. Keep the original input private. Reproduce with synthetic input through both paths, keeping the question and content comparable. A 400 carrying `max_tokens_exceeded` is much stronger evidence than a generic 502 or client timeout. Avoid silently converting a failed judgment into `no` or a lint pass.
