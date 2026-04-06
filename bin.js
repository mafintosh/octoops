#!/usr/bin/env node

const { command, summary, flag, arg } = require('paparam')
const path = require('path')
const { apply } = require('.')

const cmd = command(
  'octoops',
  summary('Declarative GitHub repo configuration using the gh CLI'),
  flag('--dry-run|-n', 'Show what would change without making changes'),
  flag('--audit', 'Write an audit log to audits/<timestamp>.log'),
  arg('<config>', 'Path to config JSON file'),
  async function () {
    const configPath = path.resolve(cmd.args.config)
    const config = require(configPath)
    const statePath = configPath.replace(/\.json$/, '.state.json')
    await apply(config, { dry: cmd.flags.dryRun, statePath, audit: cmd.flags.audit })
  }
)

cmd.parse()
