const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const pkg = '@example/widget'
const target = pkg + '@1.2.3'
const message = 'Use 1.2.4.'
const cli = path.resolve(__dirname, '../bin.js')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octoops-versions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = (name) => path.join(dir, name)
  const write = (name, data) => fs.writeFileSync(file(name), JSON.stringify(data))
  const read = (name) => JSON.parse(fs.readFileSync(file(name)))
  const npm = { package: pkg, trustedPublishing: { workflow: 'release.yml' } }
  const repo = { name: 'widget', archived: true, npm }
  write('config.state.json', { 'example/widget': { archived: true, npm } })
  write('registry', { [target]: '', [pkg + '@1.2.4']: 'other message' })
  fs.writeFileSync(file('calls'), '')
  fs.writeFileSync(file('npm'), '#!' + process.execPath + '\n' + `(${fakeNpm.toString()})()`, {
    mode: 0o755
  })
  function apply(entry, ...args) {
    write('config.json', { org: 'example', repos: [entry] })
    return spawnSync(process.execPath, [cli, 'apply', 'config.json', ...args], {
      cwd: dir,
      env: { PATH: dir },
      encoding: 'utf8'
    })
  }
  function run(versions, ...args) {
    return apply({ ...repo, npm: { ...npm, deprecatedVersions: versions } }, ...args)
  }
  return {
    run,
    apply,
    repo,
    read,
    write,
    calls: () => fs.readFileSync(file('calls'), 'utf8').trim()
  }
}

// The CLI can only run this fixture's npm. Unexpected subcommands fail.
function fakeNpm() {
  const fs = require('node:fs')
  const args = process.argv.slice(2)
  if (args[0] === 'deprecate' && args[1] === '--') args.splice(1, 1)
  const [command, spec, value] = args
  fs.appendFileSync('calls', JSON.stringify(args) + '\n')
  const registry = JSON.parse(fs.readFileSync('registry'))
  if (command === 'whoami') return console.log('fixture')
  if (command === 'view' && value === 'name' && spec === '@example/widget') return console.log(spec)
  if (!Object.hasOwn(registry, spec)) {
    console.error('E404')
    process.exit(1)
  }
  if (command === 'view' && value === 'deprecated') {
    if (registry[spec]) console.log(JSON.stringify(registry[spec]))
    return
  }
  if (command !== 'deprecate') process.exit(2)
  registry[spec] = value
  fs.writeFileSync('registry', JSON.stringify(registry))
}

test('plans, applies and clears a warning on one published version', (t) => {
  const f = fixture(t)
  const before = f.read('config.state.json')
  const versions = { '1.2.3': message }
  const plan = f.run(versions, '--dry-run')
  assert.equal(plan.status, 0, plan.stderr)
  assert.match(plan.stdout, /\[dry\] npm-deprecate @example\/widget@1\.2\.3/)
  assert.deepEqual(f.read('config.state.json'), before)
  assert.equal(f.read('registry')[target], '')

  const apply = f.run(versions)
  assert.equal(apply.status, 0, apply.stderr)
  assert.deepEqual(f.read('registry'), { [target]: message, [pkg + '@1.2.4']: 'other message' })
  const calls = f.calls()
  assert.doesNotMatch(calls, /publish|trust|owner/)
  assert.equal(f.run(versions).status, 0)
  assert.equal(f.calls(), calls)
  assert.equal(f.run({}).status, 0)
  assert.equal(f.read('registry')[target], message)
  assert.equal(f.run({ '1.2.3': '' }).status, 0)
  assert.deepEqual(f.read('registry'), { [target]: '', [pkg + '@1.2.4']: 'other message' })
})

test('rejects an invalid declaration before any subprocess runs', (t) => {
  const f = fixture(t)
  for (const bad of ['*', 'latest', '^1.2.3', '1.2', '1.2.3+build', '01.2.3']) {
    const result = f.run({ '1.2.3': message, [bad]: message })
    assert.notEqual(result.status, 0, bad)
  }
  for (const bad of [null, [], true, { '1.2.3': {} }]) assert.notEqual(f.run(bad).status, 0)
  assert.equal(f.calls(), '')
})

test('a missing version is retried after publication', (t) => {
  const f = fixture(t)
  const versions = { '1.2.5-beta.1': message }
  const spec = pkg + '@1.2.5-beta.1'
  assert.notEqual(f.run(versions).status, 0)
  assert.doesNotMatch(f.calls(), /"deprecate"|"publish"/)
  f.write('registry', { [spec]: '' })
  const retry = f.run(versions)
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(f.read('registry')[spec], message)
})

test('checks seeded declarations on an active repo and resumes a partial apply', (t) => {
  const f = fixture(t)
  const later = pkg + '@1.2.5'
  const npm = [{ package: pkg, deprecatedVersions: { '1.2.3': message, '1.2.5': '--use-new' } }]
  const repo = { name: 'widget', npm }
  f.write('config.state.json', { 'example/widget': { exists: true, npm } })
  assert.notEqual(f.apply(repo).status, 0)
  assert.equal(f.read('registry')[target], message)
  f.write('registry', { ...f.read('registry'), [later]: '' })
  const retry = f.apply(repo)
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(f.read('registry')[later], '--use-new')
  const writes = f
    .calls()
    .split('\n')
    .map(JSON.parse)
    .filter(([cmd]) => cmd === 'deprecate')
  assert.deepEqual(writes, [
    ['deprecate', target, message],
    ['deprecate', later, '--use-new']
  ])
})

test('keeps the package-wide setting and rejects overlapping declarations', (t) => {
  const f = fixture(t)
  const broad = { package: pkg, deprecated: true }
  const specific = { package: pkg, deprecatedVersions: { '1.2.3': message } }
  const conflicting = f.apply({ ...f.repo, npm: [broad, specific] })
  assert.notEqual(conflicting.status, 0)
  assert.match(conflicting.stderr, /use either deprecated or deprecatedVersions/)
  assert.equal(f.calls(), '')
  f.write('registry', { [pkg]: '' })
  const result = f.apply({ ...f.repo, npm: broad })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.read('registry')[pkg], 'This package is deprecated')
})

test('a changed plan after a partial failure rechecks the previous warning', (t) => {
  const f = fixture(t)
  assert.equal(f.run({ '1.2.3': 'original' }).status, 0)
  assert.notEqual(f.run({ '1.2.3': 'changed', '2.0.0': message }).status, 0)
  assert.equal(f.read('registry')[target], 'changed')
  assert.equal(f.run({ '1.2.3': 'original' }).status, 0)
  assert.equal(f.read('registry')[target], 'original')
})
