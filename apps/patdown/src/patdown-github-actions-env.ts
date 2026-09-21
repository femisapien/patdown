import { Config, Effect, Option } from 'effect'

/** True when GitHub Actions exposes a step summary file. */
export const patdownGitHubActionsIsEnabled: Effect.Effect<boolean> = Effect.gen(function* () {
	const actions = yield* Config.String('GITHUB_ACTIONS').pipe(
		Config.option,
		Effect.orElseSucceed(() => Option.none()),
	)

	const summary = yield* Config.String('GITHUB_STEP_SUMMARY').pipe(
		Config.option,
		Effect.orElseSucceed(() => Option.none()),
	)

	return (
		Option.isSome(actions) &&
		actions.value === 'true' &&
		Option.isSome(summary) &&
		summary.value.length > 0
	)
})

/** Absolute path of the step summary file when Actions is active. */
export const readPatdownGitHubStepSummaryPath: Effect.Effect<string | null> = Effect.gen(
	function* () {
		if (!(yield* patdownGitHubActionsIsEnabled)) return null

		const summary = yield* Config.String('GITHUB_STEP_SUMMARY').pipe(
			Config.option,
			Effect.orElseSucceed(() => Option.none()),
		)

		return Option.getOrNull(summary)
	},
)
