import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'
import { Config, Effect, Layer, Option, Predicate, Redacted, Schema } from 'effect'
import { AiError, Decision, DecisionModel } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'

import {
	patdownEvidenceMinConfidence,
	patdownEvidenceNoMatchChoice,
} from '#src/patdown-evidence-regions'
import {
	PatdownJudge,
	PatdownJudgeFailed,
	type PatdownEvidenceChoice,
	type PatdownJudgment,
} from '#src/patdown-judge'

export { patdownEvidenceMinConfidence } from '#src/patdown-evidence-regions'

const defaultTypeSafeOrigin = 'https://api.typesafe.ai'

const defaultTypeSafeModel = 'jev-latest'

const defaultTypeSafeApiUrl = `${defaultTypeSafeOrigin}/v1`

const TypeSafeErrorBodySchema = Schema.fromJsonString(
	Schema.Struct({
		detail: Schema.Struct({
			error_type: Schema.String,
		}),
	}),
)

const TypeSafeMachineIdentifierSchema = Schema.String.check(
	Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/u),
)

/** Decision that estimates P(yes) for a patdown question. */
function patdownYesNoDecision(question: string): Decision.Definition<
	typeof Schema.String,
	{
		readonly yes: Decision.Probability
	}
> {
	return Decision.make({
		input: Schema.String,
		decisions: {
			yes: Decision.probability({
				instructions: question,
				criteria: {
					false: 'No. The state does not match, or there is not enough evidence.',
					true: 'Yes. The state clearly matches the question.',
				},
			}),
		},
	})
}

/** Classification over evidence region ids, including noMatch. */
function patdownEvidenceClassifyDecision(
	question: string,
	criteria: Readonly<Record<string, string>>,
): Decision.Definition<
	typeof Schema.String,
	{
		readonly region: Decision.Classify<string>
	}
> {
	return Decision.make({
		input: Schema.String,
		decisions: {
			region: Decision.classify({
				instructions: question,
				criteria,
			}),
		},
	})
}

/** Only machine identifiers are logged. Provider prose can contain submitted text or credentials. */
function safeTypeSafeMachineIdentifier(value: string | undefined): string | undefined {
	if (value === undefined) return undefined

	return Option.getOrUndefined(Schema.decodeOption(TypeSafeMachineIdentifierSchema)(value))
}

function typeSafeHttpContext(
	reason: AiError.AiErrorReason,
): typeof AiError.HttpContext.Type | undefined {
	if (!('http' in reason)) return undefined

	return reason.http
}

function typeSafeResponseHeader(
	http: typeof AiError.HttpContext.Type | undefined,
	name: string,
): string | undefined {
	const value = http?.response?.headers[name]

	return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(value))
}

function readTypeSafeProviderErrorCode(body: string | undefined): string | undefined {
	if (body === undefined) return undefined

	const decoded = Option.getOrUndefined(Schema.decodeOption(TypeSafeErrorBodySchema)(body))

	return safeTypeSafeMachineIdentifier(decoded?.detail.error_type)
}

function describePatdownTypeSafeHttpFailure(
	status: number,
	providerErrorCode: string | undefined,
): string {
	if (providerErrorCode === 'max_tokens_exceeded') {
		return 'model token limit exceeded; shorten the question/input or split it into smaller requests'
	}

	if (status === 413) return 'HTTP payload too large; reduce the request body size'

	if (status === 401 || status === 403)
		return 'authentication or access rejected; check API credentials and permissions'

	if (status === 429) return 'rate or quota limit reached; check provider limits before retrying'

	if (status >= 500)
		return 'server or upstream failure; this response does not establish an input-size limit'

	return 'request rejected'
}

function formatPatdownTypeSafeHttpFailure(
	reason: AiError.AiErrorReason,
	inputText: string,
): string {
	const http = typeSafeHttpContext(reason)
	const status = http?.response?.status

	if (status === undefined) {
		return `patdown: TypeSafe request failed (${reason._tag})`
	}

	const providerErrorCode = readTypeSafeProviderErrorCode(http?.body)

	const requestId = safeTypeSafeMachineIdentifier(
		typeSafeResponseHeader(http, 'x-typesafe-request-id'),
	)

	const codeLabel = providerErrorCode === undefined ? '' : `; code: ${providerErrorCode}`
	const requestLabel = requestId === undefined ? '' : `; request ID: ${requestId}`
	const inputBytes = new TextEncoder().encode(inputText).byteLength

	return `patdown: TypeSafe HTTP ${String(status)}: ${describePatdownTypeSafeHttpFailure(status, providerErrorCode)}${codeLabel}; input UTF-8 bytes: ${String(inputBytes)}${requestLabel}`
}

/**
 * Formats a TypeSafe/Decision failure for stderr. Never interpolates response bodies or provider
 * prose; those can echo submitted text.
 */
function formatPatdownTypeSafeJudgeFailure(error: AiError.AiError, inputText: string): string {
	const { reason } = error

	if (
		Predicate.isTagged(reason, 'InvalidOutputError') ||
		Predicate.isTagged(reason, 'InvalidUserInputError')
	) {
		return 'patdown: TypeSafe response could not be decoded as a decision answer'
	}

	if (Predicate.isTagged(reason, 'NetworkError')) {
		return `patdown: TypeSafe transport/request failure (${reason.reason}); no usable HTTP response`
	}

	return formatPatdownTypeSafeHttpFailure(reason, inputText)
}

function failPatdownTypeSafeJudge(error: AiError.AiError, inputText: string): PatdownJudgeFailed {
	return new PatdownJudgeFailed({
		message: formatPatdownTypeSafeJudgeFailure(error, inputText),
	})
}

function readTypeSafeApiKey(): Effect.Effect<Redacted.Redacted, PatdownJudgeFailed> {
	return Config.Redacted('TYPESAFE_API_KEY').pipe(
		Effect.mapError(
			() =>
				new PatdownJudgeFailed({
					message: 'patdown: TYPESAFE_API_KEY is missing or empty',
				}),
		),
		Effect.filterOrFail(
			(apiKey) => Redacted.value(apiKey).trim().length > 0,
			() =>
				new PatdownJudgeFailed({
					message: 'patdown: TYPESAFE_API_KEY is missing or empty',
				}),
		),
	)
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/u, '')
}

function readTypeSafeApiUrl(): Effect.Effect<string, PatdownJudgeFailed> {
	return Config.String('TYPESAFE_BASE_URL').pipe(
		Config.map((url) => `${trimTrailingSlash(url)}/v1`),
		Config.withDefault(defaultTypeSafeApiUrl),
		Effect.mapError(
			() =>
				new PatdownJudgeFailed({
					message: 'patdown: TYPESAFE_BASE_URL is invalid',
				}),
		),
	)
}

function readTypeSafeModel(): Effect.Effect<string, PatdownJudgeFailed> {
	return Config.String('TYPESAFE_DEFAULT_MODEL').pipe(
		Config.withDefault(defaultTypeSafeModel),
		Effect.mapError(
			() =>
				new PatdownJudgeFailed({
					message: 'patdown: TYPESAFE_DEFAULT_MODEL is invalid',
				}),
		),
	)
}

function askPatdownTypeSafeYes(
	question: string,
	inputText: string,
): Effect.Effect<PatdownJudgment, AiError.AiError, DecisionModel.DecisionModel> {
	return DecisionModel.decide(patdownYesNoDecision(question), { input: inputText }).pipe(
		Effect.map((response) => ({ yesProbability: response.answers.yes.probability })),
	)
}

function locatePatdownTypeSafeEvidence(
	question: string,
	inputText: string,
	criteria: Readonly<Record<string, string>>,
): Effect.Effect<
	PatdownEvidenceChoice | null,
	AiError.AiError | PatdownJudgeFailed,
	DecisionModel.DecisionModel
> {
	if (Object.keys(criteria).length < 2) {
		return Effect.fail(
			new PatdownJudgeFailed({
				message: 'patdown: evidence choice criteria need at least two labels',
			}),
		)
	}

	return DecisionModel.decide(patdownEvidenceClassifyDecision(question, criteria), {
		input: inputText,
	}).pipe(
		Effect.map((response) => {
			const answer = response.answers.region

			if (answer.label === patdownEvidenceNoMatchChoice()) return null

			if (answer.confidence === undefined || answer.confidence < patdownEvidenceMinConfidence)
				return null

			if (!(answer.label in criteria)) return null

			return {
				regionId: answer.label,
				confidence: answer.confidence,
			}
		}),
	)
}

function mapPatdownTypeSafeDecisionError(
	error: AiError.AiError | PatdownJudgeFailed,
	inputText: string,
): PatdownJudgeFailed {
	return AiError.isAiError(error) ? failPatdownTypeSafeJudge(error, inputText) : error
}

function runPatdownTypeSafeDecision<A>(
	inputText: string,
	effect: Effect.Effect<A, AiError.AiError | PatdownJudgeFailed, DecisionModel.DecisionModel>,
): Effect.Effect<A, PatdownJudgeFailed, TypeSafeClient.TypeSafeClient> {
	return Effect.gen(function* () {
		const model = yield* readTypeSafeModel()

		return yield* effect.pipe(
			Effect.provide(TypeSafeDecisionModel.layer({ model })),
			Effect.mapError((error) => mapPatdownTypeSafeDecisionError(error, inputText)),
		)
	})
}

function runConfiguredPatdownTypeSafeDecision<A>(
	inputText: string,
	effect: Effect.Effect<A, AiError.AiError | PatdownJudgeFailed, DecisionModel.DecisionModel>,
): Effect.Effect<A, PatdownJudgeFailed> {
	return Effect.gen(function* () {
		const apiKey = yield* readTypeSafeApiKey()
		const apiUrl = yield* readTypeSafeApiUrl()

		return yield* runPatdownTypeSafeDecision(inputText, effect).pipe(
			Effect.provide(
				TypeSafeClient.layer({ apiKey, apiUrl }).pipe(Layer.provide(FetchHttpClient.layer)),
			),
		)
	})
}

/**
 * TypeSafe DecisionModel judge that still needs a TypeSafeClient. Tests inject a fake HTTP client
 * here; the default live layer reads TYPESAFE_* on each call so `rules` works without a key.
 */
export const TypeSafeJudgeFromClientLive: Layer.Layer<
	PatdownJudge,
	never,
	TypeSafeClient.TypeSafeClient
> = Layer.effect(
	PatdownJudge,
	Effect.gen(function* () {
		const client = yield* TypeSafeClient.TypeSafeClient

		return {
			ask: (question, inputText): Effect.Effect<PatdownJudgment, PatdownJudgeFailed> =>
				runPatdownTypeSafeDecision(inputText, askPatdownTypeSafeYes(question, inputText)).pipe(
					Effect.provideService(TypeSafeClient.TypeSafeClient, client),
				),
			locateEvidence: (
				question,
				inputText,
				criteria,
			): Effect.Effect<PatdownEvidenceChoice | null, PatdownJudgeFailed> =>
				runPatdownTypeSafeDecision(
					inputText,
					locatePatdownTypeSafeEvidence(question, inputText, criteria),
				).pipe(Effect.provideService(TypeSafeClient.TypeSafeClient, client)),
		}
	}),
)

/**
 * Default TypeSafe backend. Uses Effect `Decision` / `DecisionModel` with `@effect/ai-typesafe`.
 * Wire-format terminology stays inside this adapter. Credentials are read per call, not at layer
 * construction, so listing rules does not require `TYPESAFE_API_KEY`.
 */
export const TypeSafeJudgeLive: Layer.Layer<PatdownJudge> = Layer.succeed(PatdownJudge, {
	ask: (question, inputText): Effect.Effect<PatdownJudgment, PatdownJudgeFailed> =>
		runConfiguredPatdownTypeSafeDecision(inputText, askPatdownTypeSafeYes(question, inputText)),
	locateEvidence: (
		question,
		inputText,
		criteria,
	): Effect.Effect<PatdownEvidenceChoice | null, PatdownJudgeFailed> =>
		runConfiguredPatdownTypeSafeDecision(
			inputText,
			locatePatdownTypeSafeEvidence(question, inputText, criteria),
		),
})
