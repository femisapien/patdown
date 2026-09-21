# Judge providers

`PatdownJudge` is the provider-neutral Effect service used by `ask` and lint. It estimates whether a question is true of some text:

```ts
ask(question: string, text: string): Effect.Effect<
  { readonly yesProbability: number },
  PatdownJudgeFailed
>
```

The probability must be finite and between 0 and 1. Patdown validates responses before printing or applying its decision policy. It is always the probability of **yes**, not confidence in the selected answer. A value of 0.02 indicates strong support for no.

Providers estimate; patdown decides. Yes means estimated P(yes) is strictly above the configured cutoff. The default remains `0.85`. Override it with `--yes-threshold`, package.json `patdown.yesThreshold`, or a per-rule `yes-threshold:` line. In lint, yes means a rule violation. Default output hides the probability. `--verbose` exposes a P(yes) shade bar, the numeric probability, the cutoff, and elapsed judge time, without provider terminology.

## Supply a provider

The third argument to `runPatdownCli` accepts a judge Layer. Provide transport, credentials, and other dependencies inside that layer. Its acquisition may fail with `PatdownJudgeFailed`; its service methods use the same error type.

```ts
import { Effect, Layer } from 'effect'
import { PatdownJudge, runPatdownCli } from 'patdown'

// Fixed output for a local test. A real provider calls its own backend here.
const TestJudgeLive = Layer.succeed(PatdownJudge, {
	ask: (_question, _text) => Effect.succeed({ yesProbability: 0.9 }),
})

await Effect.runPromise(
	runPatdownCli(
		undefined, // keep normal rule-source discovery
		['ask', 'Is this urgent?', '--input-text', 'ASAP'],
		TestJudgeLive,
	),
)
```

This custom provider needs no TypeSafe API key. Rule-source adapters and judge providers are separate services. The CLI does not yet discover judge modules through a flag or package.json; use an embedded entrypoint to replace the judge.

Install `patdown` from npm. Custom providers still need a matching Effect version.

## Default backend

`TypeSafeJudgeLive` answers `PatdownJudge` through Effect `Decision` / `DecisionModel` and `@effect/ai-typesafe`. Yes/no uses a probability decision; FAIL-only evidence location uses classify. TypeSafe environment variables only configure this backend. Wire-format terminology stays inside the adapter.

The service contract, rule sources, output, and cutoff stay independent of the TypeSafe provider. Swap the judge layer; do not import `DecisionModel` from CLI callers unless you are writing a provider.
