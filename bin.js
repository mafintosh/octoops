#!/usr/bin/env node

const { command, summary, flag, arg } = require('paparam')
const path = require('path')
const { apply, importOrg, seed, filter, resync, lint, loadConfig, renameRepo, expandIncludes, listNpmTrust } = require('.')

const applyCmd = command(
  'apply',
  summary('Apply config to GitHub org'),
  flag('--dry-run|-n', 'Show what would change without making changes'),
  flag('--audit', 'Write an audit log to audits/<timestamp>.log'),
  flag('--enterprise', 'Enable enterprise features (env reviewers on private repos)'),
  flag('--no-renew', 'Do not recreate expired npm trusted publishers'),
  flag('--force-renew', 'Recreate every npm trusted publisher the registry has not confirmed, without waiting for the clock'),
  flag('--invalidate [names]', 'Comma-separated secret names to prompt for and set again'),
  arg('<config>', 'Path to config JSON file or manifest with "includes"'),
  async function () {
    const root = path.resolve(applyCmd.args.config)
    const paths = expandIncludes(root)
    const isManifest = paths.length !== 1 || paths[0] !== root
    for (const configPath of paths) {
      if (isManifest) console.log('\n=== applying ' + path.relative(process.cwd(), configPath) + ' ===\n')
      const config = loadConfig(configPath)
      const statePath = configPath.replace(/\.json$/, '.state.json')
      await apply(config, {
        dry: applyCmd.flags.dryRun,
        statePath,
        configPath,
        audit: applyCmd.flags.audit,
        enterprise: applyCmd.flags.enterprise,
        renew: applyCmd.flags.renew,
        forceRenew: applyCmd.flags.forceRenew,
        invalidate: applyCmd.flags.invalidate ? applyCmd.flags.invalidate.split(',') : []
      })
    }
  }
)

const importCmd = command(
  'import',
  summary('Import existing org config to JSON'),
  arg('<org>', 'GitHub org to import'),
  flag('--output|-o [path]', 'Output file path (default: stdout)'),
  flag('--only [sections]', 'Comma-separated sections to import (members,teams,secrets,repos)'),
  flag('--repos [file]', 'Path to file with newline-separated repo names to import'),
  async function () {
    const opts = {}
    if (importCmd.flags.only) opts.only = importCmd.flags.only.split(',')
    if (importCmd.flags.repos) {
      opts.repos = require('fs').readFileSync(path.resolve(importCmd.flags.repos), 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
    }
    const config = await importOrg(importCmd.args.org, opts)
    const json = JSON.stringify(config, null, 2) + '\n'
    if (importCmd.flags.output) {
      require('fs').writeFileSync(path.resolve(importCmd.flags.output), json)
      console.log('wrote ' + path.resolve(importCmd.flags.output))
    } else {
      process.stdout.write(json)
    }
  }
)

const seedCmd = command(
  'seed',
  summary('Write current config to state without checking GitHub'),
  arg('<config>', 'Path to config JSON file'),
  function () {
    const configPath = path.resolve(seedCmd.args.config)
    const config = loadConfig(configPath)
    const statePath = configPath.replace(/\.json$/, '.state.json')
    seed(config, { statePath })
  }
)

const resyncCmd = command(
  'resync',
  summary('Refetch live state from GitHub and overwrite the state file'),
  arg('<config>', 'Path to config JSON file'),
  async function () {
    const configPath = path.resolve(resyncCmd.args.config)
    const config = loadConfig(configPath)
    const statePath = configPath.replace(/\.json$/, '.state.json')
    await resync(config, { statePath })
    console.log('resynced state to ' + statePath)
  }
)

const lintCmd = command(
  'lint',
  summary('Check a config for mistakes without touching GitHub'),
  arg('<config>', 'Path to config JSON file or manifest with "includes"'),
  function () {
    const problems = lint(path.resolve(lintCmd.args.config))
    for (const p of problems) console.error(path.relative(process.cwd(), p.file) + ': ' + p.level + ': ' + p.message)
    const errors = problems.filter((p) => p.level === 'error').length
    const warnings = problems.length - errors
    if (errors) process.exitCode = 1
    console.log(problems.length ? errors + (errors === 1 ? ' error, ' : ' errors, ') + warnings + (warnings === 1 ? ' warning' : ' warnings') : 'ok')
  }
)

const listCmd = command(
  'list',
  summary('List repository names from a config file'),
  arg('<config>', 'Path to config JSON file'),
  function () {
    const configPath = path.resolve(listCmd.args.config)
    const config = loadConfig(configPath)
    for (const repo of config.repos || []) console.log(repo.name)
  }
)

const renameCmd = command(
  'rename',
  summary('Rename a repo on GitHub and update the config and state files'),
  arg('<config>', 'Path to config JSON file containing the repo entry'),
  arg('<from>', 'Current repo name'),
  arg('<to>', 'New repo name'),
  flag('--dry-run|-n', 'Show what would change without making changes'),
  async function () {
    const configPath = path.resolve(renameCmd.args.config)
    await renameRepo(configPath, renameCmd.args.from, renameCmd.args.to, { dry: renameCmd.flags.dryRun })
  }
)

const filterCmd = command(
  'filter',
  summary('Filter a config file (keep/prune repos, teams, members)'),
  arg('<config>', 'Path to config JSON file'),
  flag('--output|-o [path]', 'Output file path (default: stdout)'),
  flag('--repos [file]', 'Path to file with newline-separated repo names to keep'),
  flag('--prune-teams', 'Remove teams not referenced by any repo'),
  flag('--prune-members', 'Remove admins/members not referenced by any team'),
  function () {
    const configPath = path.resolve(filterCmd.args.config)
    const config = loadConfig(configPath)
    const opts = {}
    if (filterCmd.flags.repos) {
      opts.repos = require('fs').readFileSync(path.resolve(filterCmd.flags.repos), 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
    }
    if (filterCmd.flags.pruneTeams) opts.pruneTeams = true
    if (filterCmd.flags.pruneMembers) opts.pruneMembers = true
    const out = filter(config, opts)
    const json = JSON.stringify(out, null, 2) + '\n'
    if (filterCmd.flags.output) {
      require('fs').writeFileSync(path.resolve(filterCmd.flags.output), json)
      console.log('wrote ' + path.resolve(filterCmd.flags.output))
    } else {
      process.stdout.write(json)
    }
  }
)

const npmTrustCmd = command(
  'npm-trust',
  summary('List npm trusted publishers and whether the registry has confirmed them'),
  arg('<config>', 'Path to config JSON file or manifest with "includes"'),
  flag('--unconfirmed', 'Only publishers the registry has not confirmed yet'),
  function () {
    const root = path.resolve(npmTrustCmd.args.config)
    const hours = (ms) => Math.round(ms / 36e5) + 'h'
    for (const configPath of expandIncludes(root)) {
      const config = loadConfig(configPath)
      const statePath = configPath.replace(/\.json$/, '.state.json')
      for (const e of listNpmTrust(config, statePath)) {
        if (e.confirmed && npmTrustCmd.flags.unconfirmed) continue
        const where = e.file + (e.environment ? ' (' + e.environment + ')' : '')
        let status
        if (e.confirmed) status = 'confirmed, published after ' + e.setAt
        else if (e.archived) status = 'unconfirmed, repo archived so never checked'
        else if (e.deprecated) status = 'unconfirmed, package deprecated so not renewed'
        else if (!e.setAt) status = 'unconfirmed, not tracked yet, checked on next apply'
        else {
          const left = Date.parse(e.dueAt) - Date.now()
          status = 'unconfirmed, set ' + e.setAt + (left > 0 ? ', checked in ' + hours(left) : ', due for check')
        }
        console.log(e.repo + ' ' + e.pkg + ' ' + where + ': ' + status)
      }
    }
  }
)

const cmd = command(
  'octoops',
  summary('Declarative GitHub repo configuration using the gh CLI'),
  applyCmd,
  importCmd,
  seedCmd,
  resyncCmd,
  lintCmd,
  listCmd,
  filterCmd,
  renameCmd,
  npmTrustCmd
)

cmd.parse()
