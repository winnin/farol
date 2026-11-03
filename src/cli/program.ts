import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import { UsageError } from '../config/load.js'
import { TOOL_NAME, TOOL_VERSION } from '../output/tool.js'
import { loadContext, type GlobalOptions } from './context.js'
import { analyzeCommand, type AnalyzeOptions } from './analyze.js'
import { calibrateCommand, type CalibrateOptions } from './calibrate.js'
import { commentCommand, type CommentOptions } from './comment.js'
import { findFarolFile, FAROL_FILE, loadFarolFile, mergeOptions, pathKeys, required, type CommandName, type LoadedFarolFile } from './farol-file.js'
import { historyCommand, type HistoryOptions } from './history.js'
import { impactCommand } from './impact.js'
import { htmlCommand, reportCommand, type RenderOptions } from './report.js'
import { routesCommand } from './routes.js'
import { runAction } from './run.js'
import { usageCommand, type UsageOptions } from './usage.js'
import { reviewersCommand, type ReviewersOptions } from './reviewers-run.js'

function positiveInt(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError('must be a positive integer')
  return n
}

export function buildProgram(): Command {
  const program = new Command()
  program
    .name(TOOL_NAME)
    .description('Tells PR reviewers how much review a PR needs (TypeScript, Go and Python): what it touches, how risky it is, where to start.')
    .version(TOOL_VERSION)
    .option('--config <file>', 'configuration file, relative to --cwd', 'farol.config.json')
    .option('--cwd <dir>', 'project directory (where the configuration lives)')
    .option('--verbose', 'print progress to stderr', false)
    .option('--farol-file <file>', `file with default values for every parameter (default: the nearest ${FAROL_FILE} up to the repository root)`)
    .showHelpAfterError()

  let farolFile: LoadedFarolFile | null | undefined
  const loadedFarolFile = (): LoadedFarolFile | null => {
    if (farolFile !== undefined) return farolFile
    const explicit = program.opts<{ farolFile?: string }>().farolFile
    if (explicit !== undefined && !existsSync(resolve(explicit))) throw new UsageError(`--farol-file ${resolve(explicit)} does not exist`)
    const path = explicit !== undefined ? resolve(explicit) : findFarolFile(process.cwd())
    farolFile = path === undefined ? null : loadFarolFile(path)
    return farolFile
  }
  const globals = (): GlobalOptions => {
    const fp = loadedFarolFile()
    const merged = mergeOptions(program, program.opts<GlobalOptions>(), fp?.data, pathKeys('global'), fp?.path)
    // With a .farol.json and no --cwd, the project is the .farol.json's directory, wherever the command runs from.
    return fp && merged.cwd === undefined ? { ...merged, cwd: dirname(fp.path) } : merged
  }
  /** Command options with the .farol.json section of that command filled in. */
  const withFarolFile = <T extends object>(name: CommandName, cmd: Command, opts: T): T => {
    const fp = loadedFarolFile()
    return mergeOptions(cmd, opts, fp?.data[name], pathKeys(name), fp?.path)
  }

  program
    .command('analyze')
    .description('run the pipeline between two refs and write the JSON result')
    .option('--base <ref>', 'base ref (the PR target)')
    .option('--head <ref>', 'head ref (the PR tip)')
    .option('--coverage <file>', 'coverage report: Istanbul JSON, Go coverprofile or coverage.py JSON (overrides signals.coverage)')
    .option('--eslint <file>', 'lint report: eslint -f json, biome lint --reporter=gitlab, golangci-lint JSON or ruff JSON (overrides signals.eslint)')
    .option('--out <file>', 'write the JSON here instead of stdout')
    .option('--ignore <glob...>', 'leave matching changed files out of the analysis; a rename into a matching path still counts for the class (adds to "ignore" in the configuration)')
    .option('--pr <number>', 'pull request number, for links to the PR diff (default: the GitHub Actions event)', positiveInt)
    .option('--audit <file>', 'vulnerability report: npm/pnpm audit --json, govulncheck -json or pip-audit JSON (overrides signals.audit)')
    .option('--usage <file>', 'traffic per page/operation written by "farol usage" (overrides signals.usage); information only')
    .option('--coverage-ignore <glob...>', 'leave matching changed files out of diff coverage only (adds to signals.coverageIgnore)')
    .option('--since <ref>', 'incremental: analyze only the changes since this commit (e.g. the head you last reviewed)')
    .option('--reviewers', 'suggest reviewers from CODEOWNERS and the git history of the changed files')
    .option('--cache-dir <dir>', 'Go/Python: keep helper outputs here between runs (default: $FAROL_CACHE_DIR or ~/.cache/farol)')
    .option('--no-cache', 'Go/Python: read every tree again, without the cache')
    .action((raw: Partial<AnalyzeOptions>, cmd: Command) =>
      runAction(async () => {
        const opts = withFarolFile('analyze', cmd, raw)
        const options: AnalyzeOptions = { ...opts, base: required(opts.base, '--base', 'analyze'), head: required(opts.head, '--head', 'analyze') }
        return analyzeCommand(await loadContext(globals()), options)
      }),
    )

  program
    .command('report')
    .description('print the PR comment markdown from an analyze JSON')
    .option('--in <file>', 'analyze JSON')
    .option('--repo <owner/name>', 'repository for file links (default: the one in the JSON)')
    .option('--pr <number>', 'pull request number for file links (default: the one in the JSON)', positiveInt)
    .option('--report-url <url>', 'link to the HTML report (e.g. the workflow artifact) shown at the top')
    .option('--reviewers <file>', 'reviewers file written by "farol reviewers"')
    .action((raw: Partial<RenderOptions>, cmd: Command) =>
      runAction(() => {
        const opts = withFarolFile('report', cmd, raw)
        return reportCommand({ ...opts, in: required(opts.in, '--in', 'report') })
      }),
    )

  program
    .command('html')
    .description('write the single-file HTML report (a review workbench: live merge risk, what to check by hand, files by risk with their diff and coverage, what the change can affect, results for the PR) from an analyze JSON')
    .option('--in <file>', 'analyze JSON')
    .option('--out <file>', 'write the HTML here instead of stdout')
    .option('--repo <owner/name>', 'repository for file links (default: the one in the JSON)')
    .option('--pr <number>', 'pull request number for file links (default: the one in the JSON)', positiveInt)
    .option('--reviewers <file>', 'reviewers file written by "farol reviewers"')
    .action((raw: Partial<RenderOptions> & { out?: string }, cmd: Command) =>
      runAction(() => {
        const opts = withFarolFile('html', cmd, raw)
        return htmlCommand({ ...opts, in: required(opts.in, '--in', 'html') })
      }),
    )

  program
    .command('comment')
    .description('create or update the PR comment (uses GITHUB_TOKEN and GITHUB_REPOSITORY)')
    .option('--in <file>', 'analyze JSON')
    .option('--pr <number>', 'pull request number', positiveInt)
    .option('--repo <owner/name>', 'repository (defaults to GITHUB_REPOSITORY)')
    .option('--report-url <url>', 'link to the HTML report (e.g. the workflow artifact) shown at the top of the comment')
    .option('--reviewers <file>', 'reviewers file written by "farol reviewers"')
    .option('--new', 'create a new comment instead of updating farol\'s comment (one comment per push)')
    .option('--since-in <file>', 'incremental analyze JSON (analyze --since) summarized on top of the comment')
    .option('--since-report-url <url>', 'link to the HTML report of the incremental analysis')
    .action((raw: Partial<CommentOptions>, cmd: Command) =>
      runAction(() => {
        const opts = withFarolFile('comment', cmd, raw)
        return commentCommand({ ...opts, in: required(opts.in, '--in', 'comment'), pr: required(opts.pr, '--pr', 'comment') })
      }),
    )

  program
    .command('routes')
    .description('print the entry points farol finds (pages, operations, endpoints, RPC methods, tools, jobs, scripts) as JSON')
    .option('--ref <ref>', 'git ref (defaults to the working tree)')
    .action((raw: { ref?: string }, cmd: Command) =>
      runAction(async () => {
        const opts = withFarolFile('routes', cmd, raw)
        return routesCommand(await loadContext(globals()), opts.ref)
      }),
    )

  program
    .command('impact')
    .description('list the entry points that reach a file and the chain of files to each one')
    .argument('[file]', 'file path, relative to the project directory')
    .option('--ref <ref>', 'git ref (defaults to the working tree)')
    .action((file: string | undefined, raw: { ref?: string; file?: string }, cmd: Command) =>
      runAction(async () => {
        const opts = withFarolFile('impact', cmd, { ...raw, ...(file === undefined ? {} : { file }) })
        // The positional argument is a command-line value: it wins over the .farol.json.
        return impactCommand(await loadContext(globals()), required(file ?? opts.file, '<file>', 'impact'), opts.ref)
      }),
    )

  program
    .command('calibrate')
    .description('compare the merge risk score and the review verdict of past commits (from history) with what followed them: reverts and fixes of the same files')
    .option('--history <dir...>', 'directories written by "farol history" (one per repository)')
    .option('--window <days>', 'days after a commit in which a fix of the same files counts against it (default 14)', positiveInt)
    .option('--out <file>', 'also write the full report as JSON')
    .action((raw: Partial<CalibrateOptions>, cmd: Command) =>
      runAction(() => {
        const opts = withFarolFile('calibrate', cmd, raw)
        return calibrateCommand({ ...opts, history: required(opts.history, '--history', 'calibrate') })
      }),
    )

  program
    .command('history')
    .description('run analyze for every merge commit of a branch since a date and write one JSON per merge plus a summary')
    .option('--since <date>', 'only merges after this date (anything git log --since accepts)')
    .option('--branch <name>', 'branch to walk', 'HEAD')
    .option('--out <dir>', 'output directory', 'farol-history')
    .option('--ignore <glob...>', 'leave matching changed files out of the analysis; a rename into a matching path still counts for the class (adds to "ignore" in the configuration)')
    .option('--first-parent', 'analyze every first-parent commit instead of merge commits only (squash-merge repositories)', false)
    .action((raw: Partial<HistoryOptions>, cmd: Command) =>
      runAction(async () => {
        const opts = withFarolFile('history', cmd, raw)
        const options: HistoryOptions = { branch: 'HEAD', out: 'farol-history', ...opts, since: required(opts.since, '--since', 'history') }
        return historyCommand(await loadContext(globals()), options)
      }),
    )

  program
    .command('reviewers')
    .description('suggest reviewers for an analyzed PR by who wrote the code it changes (git blame, weighed by risk) and CODEOWNERS; html/report/comment add it with --reviewers')
    .option('--in <file>', 'analyze JSON')
    .option('--out <file>', 'write the reviewers file here instead of stdout')
    .action((raw: Partial<ReviewersOptions>, cmd: Command) =>
      runAction(async () => {
        const opts = withFarolFile('reviewers', cmd, raw)
        return reviewersCommand(await loadContext(globals()), { ...opts, in: required(opts.in, '--in', 'reviewers') })
      }),
    )

  program
    .command('usage')
    .description('read page views (Datadog RUM) and requests per operation (Datadog APM) and write a usage report for analyze --usage (uses DD_API_KEY and DD_APP_KEY)')
    .option('--out <file>', 'write the report here instead of stdout')
    .option('--days <n>', 'days of traffic up to now (default: datadog.days, 14)', positiveInt)
    .action((raw: UsageOptions, cmd: Command) =>
      runAction(async () => {
        const opts = withFarolFile('usage', cmd, raw)
        return usageCommand(await loadContext(globals()), opts)
      }),
    )

  return program
}
