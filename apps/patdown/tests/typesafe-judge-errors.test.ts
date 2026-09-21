import { TypeSafeClient } from '@effect/ai-typesafe'
import { describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted } from 'effect'
import {
	HttpClient,
	HttpClientError,
	type HttpClientRequest,
	HttpClientResponse,
} from 'effect/unstable/http'

import {
	askPatdownJudge,
	PatdownJudgeFailed,
	type PatdownJudge,
	type PatdownTimedJudgment,
} from '#src/patdown-judge'
import { TypeSafeJudgeFromClientLive, TypeSafeJudgeLive } from '#src/typesafe-judge'

const testConfig = ConfigProvider.fromUnknown({ TYPESAFE_API_KEY: 'test-key-not-a-secret' })

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

describe('TypeSafe DecisionModel judge errors', () => {
	it.effect('reports the observed token limit failure without leaking response prose', () =>
		Effect.gen(function* () {
			const error = yield* askWithResponse(
				400,
				JSON.stringify({
					detail: { error_type: 'max_tokens_exceeded', message: 'PRIVATE INPUT' },
				}),
			).pipe(Effect.flip)

			expect(error).toBeInstanceOf(PatdownJudgeFailed)
			expect(error.message).toContain('patdown: TypeSafe HTTP 400')
			expect(error.message).toContain('model token limit exceeded')
			expect(error.message).toContain('code: max_tokens_exceeded')
			expect(error.message).toContain('input UTF-8 bytes: 20')
			expect(error.message).toContain('request ID: req_test123')
			expect(error.message).not.toContain('PRIVATE INPUT')
		}),
	)

	for (const [status, expected] of [
		[413, 'HTTP payload too large'],
		[401, 'authentication or access rejected'],
		[403, 'authentication or access rejected'],
		[429, 'rate or quota limit'],
		[502, 'server or upstream failure'],
		[504, 'server or upstream failure'],
		[400, 'request rejected'],
	] as const) {
		it.effect(`preserves HTTP ${String(status)} even when the response is not JSON`, () =>
			Effect.gen(function* () {
				const error = yield* askWithResponse(
					status,
					'<html>PRIVATE INPUT: proxy error</html>',
				).pipe(Effect.flip)

				expect(error.message).toContain(`HTTP ${String(status)}`)
				expect(error.message).toContain(expected)
				expect(error.message).not.toContain('PRIVATE INPUT')
			}),
		)
	}

	it.effect('discards unsafe machine identifiers', () =>
		Effect.gen(function* () {
			const error = yield* askWithResponse(
				400,
				JSON.stringify({ detail: { error_type: 'untrusted\nPRIVATE INPUT' } }),
			).pipe(Effect.flip)

			expect(error.message).not.toContain('PRIVATE INPUT')
			expect(error.message).not.toContain('untrusted')
		}),
	)

	it.effect('distinguishes an invalid success body from an HTTP rejection', () =>
		Effect.gen(function* () {
			const error = yield* askWithResponse(200, 'not json').pipe(Effect.flip)

			expect(error.message).toContain('could not be decoded')
			expect(error.message).not.toContain('not json')
		}),
	)

	it.effect('reports transport failure separately without printing credentials or input', () =>
		Effect.gen(function* () {
			const client = makePatdownTestHttpClient((request) =>
				Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({ request, cause: 'PRIVATE INPUT' }),
					}),
				),
			)

			const error = yield* askPatdownJudge('Question?', 'synthetic input 🐈').pipe(
				Effect.provide(typeSafeJudgeWithClient(client)),
				Effect.flip,
			)

			expect(error.message).toContain('transport/request failure (TransportError)')
			expect(error.message).not.toContain('PRIVATE INPUT')
			expect(error.message).not.toContain('test-key-not-a-secret')
		}),
	)

	it.effect('fails closed when the TypeSafe API key is missing', () =>
		Effect.gen(function* () {
			const error = yield* askPatdownJudge('Question?', 'text').pipe(
				Effect.provide(
					Layer.mergeAll(TypeSafeJudgeLive, ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
				),
				Effect.flip,
			)

			expect(error.message).toBe('patdown: TYPESAFE_API_KEY is missing or empty')
		}),
	)
})
