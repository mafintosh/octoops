#!/usr/bin/env node

const { command, summary, flag, arg } = require('paparam')
const path = require('path')
const { apply, importOrg } = require('.')

const applyCmd = command(
  'apply',
  summary('Apply config to GitHub org'),
  flag('--dry-run|-n', 'Show what would change without making changes'),
  flag('--audit', 'Write an audit log to audits/<timestamp>.log'),
  arg('<config>', 'Path to config JSON file'),
  async function () {
    const configPath = path.resolve(applyCmd.args.config)
    const config = require(configPath)
    const statePath = configPath.replace(/\.json$/, '.state.json')
    await apply(config, {
      dry: applyCmd.flags.dryRun,
      statePath,
      audit: applyCmd.flags.audit
    })
  }
)

const importCmd = command(
  'import',
  summary('Import existing org config to JSON'),
  arg('<org>', 'GitHub org to import'),
  flag('--output|-o [path]', 'Output file path (default: stdout)'),
  async function () {
    const config = await importOrg(importCmd.args.org)
    const json = JSON.stringify(config, null, 2) + '\n'
    if (importCmd.flags.output) {
      require('fs').writeFileSync(path.resolve(importCmd.flags.output), json)
      console.log('wrote ' + path.resolve(importCmd.flags.output))
    } else {
      process.stdout.write(json)
    }
  }
)

const cmd = command(
  'octoops',
  summary('Declarative GitHub repo configuration using the gh CLI'),
  applyCmd,
  importCmd
)

cmd.parse()
