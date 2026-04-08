#!/usr/bin/env node

const { command, summary, flag, arg } = require('paparam')
const path = require('path')
const { apply, importOrg, seed } = require('.')

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
  async function () {
    const opts = {}
    if (importCmd.flags.only) opts.only = importCmd.flags.only.split(',')
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

const cmd = command(
  'octoops',
  summary('Declarative GitHub repo configuration using the gh CLI'),
  applyCmd,
  importCmd,
  seedCmd
)

cmd.parse()
