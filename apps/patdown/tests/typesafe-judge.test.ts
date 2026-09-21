import { TypeSafeClient } from '@effect/ai-typesafe'
import { describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect'
import { Predicate } from 'effect'
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from 'effect/unstable/http'

import {
	askPatdownJudge,
	locatePatdownEvidence,
	PatdownJudgeFailed,
	type PatdownEvidenceLocation,
	type PatdownJudge,
	type PatdownTimedJudgment,
} from '#src/patdown-judge'
import { TypeSafeJudgeFromClientLive } from '#src/typesafe-judge'

const testConfig = ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: 'test-key-not-a-secret' })

const noulSuccessBody = JSON.stringify({
	model: 'jev-1.13.0',
	answers: { yes: { type: 'noul', noul: 0.04 } },
	usage: { input_tokens: 630, output_tokens: 21 },
})

const evidenceCriteria = {
	L2: 'Line 2: title case',
	noMatch: 'No candidate provides clear, direct evidence of the violation',
}

function jsonResponse(
	request: HttpClientRequest.HttpClientRequest,
	status: number,
	body: string,
	headers: Readonly<Record<string, string>> = {},
): HttpClientResponse.HttpClientResponse {
	return HttpClientResponse.fromWeb(
		request,
		new Response(body, {
			status,
			headers: { 'content-type': 'application/json', ...headers },
		}),
	)
}

function makePatdownTestHttpClient(
	handler: (
		request: HttpClientRequest.HttpClientRequest,
	) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): HttpClient.HttpClient {
	return HttpClient.make((request) => handler(request))
}

function typeSafeJudgeWithClient(client: HttpClient.HttpClient): Layer.Layer<PatdownJudge> {
	return TypeSafeJudgeFromClientLive.pipe(
		Layer.provide(TypeSafeClient.layer({ apiKey: Redacted.make('test-key-not-a-secret') })),
		Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
		Layer.provide(ConfigProvider.layer(testConfig)),
	)
}

function askWithResponse(
	status: number,
	body: string,
	inputText = 'synthetic input 🐈',
): Effect.Effect<PatdownTimedJudgment, PatdownJudgeFailed> {
	return askPatdownJudge('Question?', inputText).pipe(
		Effect.provide(
			typeSafeJudgeWithClient(
				makePatdownTestHttpClient((request) =>
					Effect.succeed(
						jsonResponse(request, status, body, { 'x-typesafe-request-id': 'req_test123' }),
					),
				),
			),
		),
	)
}

function locateWithResponse(
	status: number,
	body: string,
): Effect.Effect<PatdownEvidenceLocation | null, PatdownJudgeFailed> {
	const regions = new Map([['L2', { startLine: 1, endLine: 1 }]])

	return locatePatdownEvidence('Which region?', 'file text', evidenceCriteria, regions).pipe(
		Effect.provide(
			typeSafeJudgeWithClient(
				makePatdownTestHttpClient((request) =>
					Effect.succeed(
						jsonResponse(request, status, body, { 'x-typesafe-request-id': 'req_test123' }),
					),
				),
			),
		),
	)
}

function decodeRequestJson(
	request: HttpClientRequest.HttpClientRequest | undefined,
): Effect.Effect<Schema.Json, Schema.SchemaError> {
	return Effect.gen(function* () {
		const body = request?.body

		if (body === undefined || !Predicate.isTagged(body, 'Uint8Array')) {
			return yield* Effect.die(new Error('patdown: expected Uint8Array TypeSafe request body'))
		}

		return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
			new TextDecoder().decode(body.body),
		)
	})
}

describe('TypeSafe DecisionModel judge answers', () => {
	it.effect('maps a noul probability onto yesProbability', () =>
		Effect.gen(function* () {
			const timed = yield* askWithResponse(200, noulSuccessBody)

			expect(timed.judgment.yesProbability).toBe(0.04)
			expect(timed.elapsedMs).toBeGreaterThanOrEqual(0)
		}),
	)

	it.effect('sends the question as a noul decision and the text as string state', () =>
		Effect.gen(function* () {
			const requests: HttpClientRequest.HttpClientRequest[] = []

			yield* askPatdownJudge('Is this urgent?', 'ASAP').pipe(
				Effect.provide(
					typeSafeJudgeWithClient(
						makePatdownTestHttpClient((request) => {
							requests.push(request)

							return Effect.succeed(jsonResponse(request, 200, noulSuccessBody))
						}),
					),
				),
			)

			expect(requests).toHaveLength(1)
			expect(requests[0]?.method).toBe('POST')
			expect(requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')

			const body = yield* decodeRequestJson(requests[0])

			expect(body).toEqual({
				model: 'jev-latest',
				state: 'ASAP',
				questions: {
					yes: {
						type: 'noul',
						instructions: 'Is this urgent?',
						criteria: {
							false: 'No. The state does not match, or there is not enough evidence.',
							true: 'Yes. The state clearly matches the question.',
						},
					},
				},
			})
		}),
	)

	it.effect('maps a classify answer onto an evidence region', () =>
		Effect.gen(function* () {
			const located = yield* locateWithResponse(
				200,
				JSON.stringify({
					model: 'jev-latest',
					answers: {
						region: {
							type: 'choice',
							choice: 'L2',
							probabilities: { L2: 0.8, noMatch: 0.2 },
							confidence: 0.81,
						},
					},
					usage: { input_tokens: 40, output_tokens: 8 },
				}),
			)

			expect(located).toEqual({
				startLine: 1,
				endLine: 1,
				regionId: 'L2',
				confidence: 0.81,
			})
		}),
	)

	it.effect('returns null when classify picks noMatch', () =>
		Effect.gen(function* () {
			const located = yield* locateWithResponse(
				200,
				JSON.stringify({
					model: 'jev-latest',
					answers: {
						region: {
							type: 'choice',
							choice: 'noMatch',
							probabilities: { L2: 0.1, noMatch: 0.9 },
							confidence: 0.9,
						},
					},
				}),
			)

			expect(located).toBeNull()
		}),
	)

	it.effect('returns null when classify confidence is below the evidence cutoff', () =>
		Effect.gen(function* () {
			const located = yield* locateWithResponse(
				200,
				JSON.stringify({
					model: 'jev-latest',
					answers: {
						region: {
							type: 'choice',
							choice: 'L2',
							probabilities: { L2: 0.6, noMatch: 0.4 },
							confidence: 0.4,
						},
					},
				}),
			)

			expect(located).toBeNull()
		}),
	)
})
