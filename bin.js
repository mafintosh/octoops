#!/usr/bin/env node

const { command, summary, flag, arg } = require('paparam')
const path = require('path')
const { apply, importOrg, seed, filter, resync } = require('.')

const applyCmd = command(
  'apply',
  summary('Apply config to GitHub org'),
  flag('--dry-run|-n', 'Show what would change without making changes'),
  flag('--audit', 'Write an audit log to audits/<timestamp>.log'),
  flag('--enterprise', 'Enable enterprise features (env reviewers on private repos)'),
  arg('<config>', 'Path to config JSON file'),
  async function () {
    const configPath = path.resolve(applyCmd.args.config)
    const config = require(configPath)
    const statePath = configPath.replace(/\.json$/, '.state.json')
    await apply(config, {
      dry: applyCmd.flags.dryRun,
      statePath,
      audit: applyCmd.flags.audit,
      enterprise: applyCmd.flags.enterprise
    })
  }
)

const importCmd = command(
  'import',
  summary('Import existing org config to JSON'),
  arg('<org>', 'GitHub org to import'),
  flag('--output|-o [path]', 'Output file path (default: stdout)'),
  flag('--only [sections]', 'Comma-separated sections to import (members,teams,repos)'),
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
    const config = require(configPath)
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
    const config = require(configPath)
    const statePath = configPath.replace(/\.json$/, '.state.json')
    await resync(config, { statePath })
    console.log('resynced state to ' + statePath)
  }
)

const listCmd = command(
  'list',
  summary('List repository names from a config file'),
  arg('<config>', 'Path to config JSON file'),
  function () {
    const configPath = path.resolve(listCmd.args.config)
    const config = require(configPath)
    for (const repo of config.repos || []) console.log(repo.name)
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
    const config = require(configPath)
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

const cmd = command(
  'octoops',
  summary('Declarative GitHub repo configuration using the gh CLI'),
  applyCmd,
  importCmd,
  seedCmd,
  resyncCmd,
  listCmd,
  filterCmd
)

cmd.parse()
