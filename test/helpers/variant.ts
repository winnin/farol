import type { AnalyzeOptions } from '../../src/cli/analyze.js'
import type { Output } from '../../src/output/schema.js'
import { analyzeRepo } from './analyze.js'
import { createScenarioRepo, type TestRepo } from './repo.js'

export type Change = (repo: TestRepo) => void

export function edit(repo: TestRepo, file: string, from: string, to: string): void {
  const code = repo.read(file)
  if (!code.includes(from)) throw new Error(`${file} does not contain: ${from}`)
  repo.write(file, code.replace(from, to))
}

/** Analyzes a PR that applies `change` on a scenario's base; `setup` first changes the base itself. */
export async function analyzeVariant(scenario: string, cleanups: (() => void)[], change: Change, setup?: Change, options: Partial<AnalyzeOptions> = {}): Promise<Output> {
  const { repo } = createScenarioRepo(scenario)
  cleanups.push(() => { repo.cleanup(); })
  repo.git('checkout', '-q', 'main')
  setup?.(repo)
  repo.commit('setup')
  repo.git('checkout', '-q', '-B', 'feature')
  change(repo)
  repo.commit('variant')
  return (await analyzeRepo(repo, options)).output
}
