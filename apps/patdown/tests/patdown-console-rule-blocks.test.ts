import { describe, expect, it } from 'vitest'

import { formatPatdownConsolePath, formatPatdownRuleBlock } from '#src/patdown-console-rule-blocks'
import type { PatdownLintResult } from '#src/patdown-output'

function result(
	partial: Pick<PatdownLintResult, 'filePath' | 'violated' | 'violationProbability' | 'elapsedMs'>,
): PatdownLintResult {
	return {
		ruleTitle: 'Follow Effect diagnostics',
		ruleBody: 'Address Effect diagnostics.',
		ruleGlobs: ['**/*.ts'],
		yesThreshold: 0.85,
		...partial,
	}
}

describe('console rule blocks', () => {
	it('groups files under directory headers with fixed metric columns', () => {
		const block = formatPatdownRuleBlock('Follow Effect diagnostics', [
			result({
				filePath: 'apps/patdown/src/cli.ts',
				violated: false,
				violationProbability: 0.22,
				elapsedMs: 131,
			}),
			result({
				filePath: 'apps/patdown/oxlint.config.ts',
				violated: false,
				violationProbability: 0.06,
				elapsedMs: 9,
			}),
			result({
				filePath: 'packages/patdown-rules/src/index.ts',
				violated: true,
				violationProbability: 0.91,
				elapsedMs: 90,
			}),
		])

		const lines = block.split('\n')

		expect(lines[0]).toMatch(/^┌ Follow Effect diagnostics ─+ 3$/u)
		expect(lines.slice(1)).toEqual([
			'│',
			'├─ apps/patdown',
			'│',
			'│  ✓  ▒░░░░░░░░░  0.06     9ms  oxlint.config.ts',
			'│',
			'├─ apps/patdown/src',
			'│',
			'│  ✓  ▓▓░░░░░░░░  0.22   131ms  cli.ts',
			'│',
			'├─ packages/patdown-rules/src',
			'│',
			'│  ✗  ▓▓▓▓▓▓▓▓▓░  0.91    90ms  index.ts',
			'└ 1✗ / 3',
		])
	})

	it('truncates long paths from the left', () => {
		expect(formatPatdownConsolePath('apps/patdown/src/cli.ts', 48)).toBe('apps/patdown/src/cli.ts')
		expect(
			formatPatdownConsolePath(
				'apps/patdown/src/really/deeply/nested/patdown-github-actions-summary.ts',
				40,
			),
		).toBe('…/patdown-github-actions-summary.ts')
	})

	it('shows an empty rule block when no files matched', () => {
		const block = formatPatdownRuleBlock('No title case', [])

		expect(block.split('\n')[0]).toMatch(/^┌ No title case ─+ 0$/u)
		expect(block).toContain('│\n│  (no files matched)\n└ 0✗ / 0')
		expect(block.endsWith('└ 0✗ / 0')).toBe(true)
	})
})
