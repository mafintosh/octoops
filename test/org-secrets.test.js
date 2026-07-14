const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const cli = path.join(root, 'bin.js')

function createFixture(t, config = validConfig()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octoops-org-secrets-'))
  const binDir = path.join(dir, 'bin')
  const configPath = path.join(dir, 'config.json')
  const statePath = path.join(dir, 'config.state.json')
  const logPath = path.join(dir, 'gh.log')
  const secretsPath = path.join(dir, '.org-secrets')

  fs.mkdirSync(binDir)
  const fakeGh = path.join(binDir, 'gh')
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(
  process.env.GH_LOG,
  JSON.stringify({ args, stdin: input }) + '\\n'
)
if (args[0] === 'api') {
  process.stdout.write(JSON.stringify(args[1] === 'orgs/test-org' ? {} : []))
}
`
  )
  fs.chmodSync(fakeGh, 0o755)

  const env = {
    ...process.env,
    GH_LOG: logPath,
    PATH: binDir + path.delimiter + process.env.PATH
  }

  const fixture = {
    dir,
    configPath,
    statePath,
    logPath,
    secretsPath,
    apply(...args) {
      const result = spawnSync(process.execPath, [cli, 'apply', ...args, configPath], {
        cwd: dir,
        env,
        encoding: 'utf8'
      })
      if (result.error) throw result.error
      return result
    },
    resync() {
      const result = spawnSync(process.execPath, [cli, 'resync', configPath], {
        cwd: dir,
        env,
        encoding: 'utf8'
      })
      if (result.error) throw result.error
      return result
    },
    calls() {
      if (!fs.existsSync(logPath)) return []
      return fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    clearCalls() {
      fs.writeFileSync(logPath, '')
    },
    writeConfig(next) {
      fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n')
    },
    writeSecrets(contents = validSecrets()) {
      fs.writeFileSync(secretsPath, contents)
    }
  }

  fixture.writeConfig(config)
  fixture.writeSecrets()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return fixture
}

function validConfig() {
  return {
    org: 'test-org',
    orgSecrets: {
      file: '.org-secrets',
      secrets: {
        OCTOOPS_TEST_ALL: { visibility: 'all' },
        OCTOOPS_TEST_PRIVATE: { visibility: 'private' },
        OCTOOPS_TEST_SELECTED: {
          visibility: 'selected',
          repos: ['Repo-B', 'repo-a']
        }
      }
    },
    repos: []
  }
}

function validSecrets(privateValue = 'line-one') {
  return (
    'OCTOOPS_TEST_ALL=dummy-all\n' +
    'OCTOOPS_TEST_PRIVATE="-----BEGIN PRIVATE KEY-----\n' +
    privateValue +
    '\n-----END PRIVATE KEY-----"\n' +
    'OCTOOPS_TEST_SELECTED="dummy\\nselected"\n'
  )
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('reconciles every visibility and tracks value and policy changes', (t) => {
  const fixture = createFixture(t)

  const first = fixture.apply()
  assertSuccess(first)
  const calls = fixture.calls()
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], {
    args: ['secret', 'set', 'OCTOOPS_TEST_ALL', '--org', 'test-org', '--visibility', 'all'],
    stdin: 'dummy-all'
  })
  assert.deepEqual(calls[1], {
    args: ['secret', 'set', 'OCTOOPS_TEST_PRIVATE', '--org', 'test-org', '--visibility', 'private'],
    stdin: '-----BEGIN PRIVATE KEY-----\nline-one\n-----END PRIVATE KEY-----'
  })
  assert.deepEqual(calls[2], {
    args: [
      'secret',
      'set',
      'OCTOOPS_TEST_SELECTED',
      '--org',
      'test-org',
      '--visibility',
      'selected',
      '--repos',
      'repo-a,repo-b'
    ],
    stdin: 'dummy\nselected'
  })

  const stateText = fs.readFileSync(fixture.statePath, 'utf8')
  const state = JSON.parse(stateText)
  assert.equal(state.orgSecrets.OCTOOPS_TEST_ALL.visibility, 'all')
  assert.equal(state.orgSecrets.OCTOOPS_TEST_PRIVATE.visibility, 'private')
  assert.deepEqual(state.orgSecrets.OCTOOPS_TEST_SELECTED.repos, ['repo-a', 'repo-b'])
  assert.match(state.orgSecrets.OCTOOPS_TEST_ALL.salt, /^[a-f0-9]{64}$/)
  assert.match(state.orgSecrets.OCTOOPS_TEST_ALL.hmac, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(stateText, /dummy-all|line-one|dummy\\nselected/)
  assert.doesNotMatch(first.stdout + first.stderr, /dummy-all|line-one|dummy\\nselected/)

  fixture.clearCalls()
  assertSuccess(fixture.apply())
  assert.deepEqual(fixture.calls(), [])

  fixture.writeSecrets(validSecrets('line-two'))
  fixture.clearCalls()
  assertSuccess(fixture.apply())
  assert.deepEqual(
    fixture.calls().map((call) => call.args[2]),
    ['OCTOOPS_TEST_PRIVATE']
  )

  const changedPolicy = validConfig()
  changedPolicy.orgSecrets.secrets.OCTOOPS_TEST_ALL.visibility = 'private'
  changedPolicy.orgSecrets.secrets.OCTOOPS_TEST_SELECTED.repos = ['repo-c']
  fixture.writeConfig(changedPolicy)
  fixture.clearCalls()
  assertSuccess(fixture.apply())
  assert.deepEqual(
    fixture.calls().map((call) => call.args),
    [
      ['secret', 'set', 'OCTOOPS_TEST_ALL', '--org', 'test-org', '--visibility', 'private'],
      [
        'secret',
        'set',
        'OCTOOPS_TEST_SELECTED',
        '--org',
        'test-org',
        '--visibility',
        'selected',
        '--repos',
        'repo-c'
      ]
    ]
  )

  delete changedPolicy.orgSecrets.secrets.OCTOOPS_TEST_PRIVATE
  fixture.writeConfig(changedPolicy)
  fixture.writeSecrets('OCTOOPS_TEST_ALL=dummy-all\nOCTOOPS_TEST_SELECTED="dummy\\nselected"\n')
  fixture.clearCalls()
  const blocked = fixture.apply()
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /without --allow-org-secret-deletes/)
  assert.deepEqual(fixture.calls(), [])

  fixture.clearCalls()
  assertSuccess(fixture.apply('--allow-org-secret-deletes'))
  assert.deepEqual(fixture.calls(), [
    {
      args: ['secret', 'delete', 'OCTOOPS_TEST_PRIVATE', '--org', 'test-org'],
      stdin: ''
    }
  ])
})

test('missing value file is a no-op that preserves state', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.apply())
  const before = fs.readFileSync(fixture.statePath, 'utf8')

  const config = validConfig()
  config.orgSecrets.file = '.missing-org-secrets'
  fixture.writeConfig(config)
  fixture.clearCalls()
  const result = fixture.apply()

  assertSuccess(result)
  assert.match(result.stdout, /skip-org-secrets test-org/)
  assert.deepEqual(fixture.calls(), [])
  assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), before)
})

test('dry-run reports changes without calling gh or writing state', (t) => {
  const fixture = createFixture(t)
  const result = fixture.apply('--dry-run')

  assertSuccess(result)
  assert.match(result.stdout, /\[dry\] set-org-secret test-org/)
  assert.deepEqual(fixture.calls(), [])
  assert.equal(fs.existsSync(fixture.statePath), false)
  assert.doesNotMatch(result.stdout + result.stderr, /dummy-all|line-one|dummy\\nselected/)
})

test('dry-run reports org-secret deletions without requiring the delete flag', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.apply())

  fixture.writeConfig({ org: 'test-org', repos: [] })
  fixture.clearCalls()
  const result = fixture.apply('--dry-run')

  assertSuccess(result)
  assert.match(result.stdout, /\[dry\] remove-org-secret test-org \(OCTOOPS_TEST_ALL\)/)
  assert.deepEqual(fixture.calls(), [])
  assert.ok(JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).orgSecrets)
})

test('blocks mixed org-secret updates and deletions before any mutation', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.apply())
  const before = fs.readFileSync(fixture.statePath, 'utf8')

  const config = validConfig()
  config.orgSecrets.secrets.OCTOOPS_TEST_ALL.visibility = 'private'
  delete config.orgSecrets.secrets.OCTOOPS_TEST_PRIVATE
  fixture.writeConfig(config)
  fixture.writeSecrets(
    'OCTOOPS_TEST_ALL=dummy-all-updated\nOCTOOPS_TEST_SELECTED="dummy\\nselected"\n'
  )
  fixture.clearCalls()

  const blocked = fixture.apply()
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /without --allow-org-secret-deletes/)
  assert.deepEqual(fixture.calls(), [])
  assert.equal(fs.readFileSync(fixture.statePath, 'utf8'), before)

  fixture.clearCalls()
  assertSuccess(fixture.apply('--allow-org-secret-deletes'))
  assert.deepEqual(fixture.calls(), [
    {
      args: ['secret', 'set', 'OCTOOPS_TEST_ALL', '--org', 'test-org', '--visibility', 'private'],
      stdin: 'dummy-all-updated'
    },
    {
      args: ['secret', 'delete', 'OCTOOPS_TEST_PRIVATE', '--org', 'test-org'],
      stdin: ''
    }
  ])

  const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).orgSecrets
  assert.equal(state.OCTOOPS_TEST_ALL.visibility, 'private')
  assert.equal(state.OCTOOPS_TEST_PRIVATE, undefined)

  fixture.clearCalls()
  assertSuccess(fixture.apply())
  assert.deepEqual(fixture.calls(), [])
})

test('removing orgSecrets deletes all previously managed secrets with explicit opt-in', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.apply())

  fixture.writeConfig({ org: 'test-org', repos: [] })
  fixture.clearCalls()
  const blocked = fixture.apply()
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /without --allow-org-secret-deletes/)
  assert.deepEqual(fixture.calls(), [])
  assert.ok(JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).orgSecrets)

  fixture.clearCalls()
  assertSuccess(fixture.apply('--allow-org-secret-deletes'))

  assert.deepEqual(
    fixture.calls().map((call) => call.args),
    [
      ['secret', 'delete', 'OCTOOPS_TEST_ALL', '--org', 'test-org'],
      ['secret', 'delete', 'OCTOOPS_TEST_PRIVATE', '--org', 'test-org'],
      ['secret', 'delete', 'OCTOOPS_TEST_SELECTED', '--org', 'test-org']
    ]
  )
  assert.equal(JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).orgSecrets, undefined)
})

test('resync preserves org secret state for later deletion', (t) => {
  const config = validConfig()
  config.admins = []
  const fixture = createFixture(t, config)
  assertSuccess(fixture.apply())
  const before = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).orgSecrets

  fixture.clearCalls()
  assertSuccess(fixture.resync())
  const after = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8')).orgSecrets
  assert.deepEqual(after, before)

  fixture.writeConfig({ org: 'test-org', repos: [] })
  fixture.clearCalls()
  assertSuccess(fixture.apply('--allow-org-secret-deletes'))
  assert.deepEqual(
    fixture.calls().map((call) => call.args),
    [
      ['secret', 'delete', 'OCTOOPS_TEST_ALL', '--org', 'test-org'],
      ['secret', 'delete', 'OCTOOPS_TEST_PRIVATE', '--org', 'test-org'],
      ['secret', 'delete', 'OCTOOPS_TEST_SELECTED', '--org', 'test-org']
    ]
  )
})

test('preserves repo and environment secret parsing behavior', (t) => {
  const config = {
    org: 'test-org',
    repos: [
      { name: 'repo-secrets', secrets: '.repo-secrets' },
      {
        name: 'env-secrets',
        environments: [
          {
            name: 'production',
            secrets: '.env-secrets'
          }
        ]
      }
    ]
  }
  const fixture = createFixture(t, config)
  fs.writeFileSync(
    path.join(fixture.dir, '.repo-secrets'),
    [
      'PLAIN=plain-value',
      "SINGLE='single value'",
      'QUOTED="ab\\ncd"',
      'UNTERMINATED="still-literal',
      'TRAILING="quoted" leftover',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(fixture.dir, '.env-secrets'), 'ESCAPED="escaped\\nline"\n')
  fs.writeFileSync(
    fixture.statePath,
    JSON.stringify(
      {
        'test-org/repo-secrets': { private: true },
        'test-org/env-secrets': {
          environments: config.repos[1].environments
        }
      },
      null,
      2
    ) + '\n'
  )

  const result = fixture.apply()
  assertSuccess(result)
  assert.deepEqual(
    fixture.calls().map((call) => ({
      key: call.args[2],
      scope: call.args.slice(3),
      value: call.stdin
    })),
    [
      {
        key: 'PLAIN',
        scope: ['--repo', 'test-org/repo-secrets'],
        value: 'plain-value'
      },
      {
        key: 'SINGLE',
        scope: ['--repo', 'test-org/repo-secrets'],
        value: 'single value'
      },
      {
        key: 'QUOTED',
        scope: ['--repo', 'test-org/repo-secrets'],
        value: 'ab\\ncd'
      },
      {
        key: 'UNTERMINATED',
        scope: ['--repo', 'test-org/repo-secrets'],
        value: '"still-literal'
      },
      {
        key: 'TRAILING',
        scope: ['--repo', 'test-org/repo-secrets'],
        value: '"quoted" leftover'
      },
      {
        key: 'ESCAPED',
        scope: ['--repo', 'test-org/env-secrets', '--env', 'production'],
        value: 'escaped\\nline'
      }
    ]
  )
})

test('rejects invalid organization secret policies before calling gh', async (t) => {
  const cases = [
    {
      name: 'unknown visibility',
      mutate(config) {
        config.orgSecrets.secrets.OCTOOPS_TEST_ALL.visibility = 'public'
      },
      message: /expected all\|private\|selected/
    },
    {
      name: 'selected without repos',
      mutate(config) {
        config.orgSecrets.secrets.OCTOOPS_TEST_SELECTED.repos = []
      },
      message: /must list at least one repo/
    },
    {
      name: 'repos with private visibility',
      mutate(config) {
        config.orgSecrets.secrets.OCTOOPS_TEST_PRIVATE.repos = ['repo-a']
      },
      message: /repos is only valid with selected visibility/
    },
    {
      name: 'duplicate selected repos',
      mutate(config) {
        config.orgSecrets.secrets.OCTOOPS_TEST_SELECTED.repos = ['Repo-A', 'repo-a']
      },
      message: /duplicate repo/
    },
    {
      name: 'unknown policy property',
      mutate(config) {
        config.orgSecrets.secrets.OCTOOPS_TEST_ALL.repositories = ['repo-a']
      },
      message: /unknown property "repositories"/
    },
    {
      name: 'invalid secret name',
      mutate(config) {
        config.orgSecrets.secrets['GITHUB_RESERVED'] = { visibility: 'all' }
      },
      message: /invalid organization secret name/
    }
  ]

  for (const entry of cases) {
    await t.test(entry.name, (t) => {
      const config = validConfig()
      entry.mutate(config)
      const fixture = createFixture(t, config)
      const result = fixture.apply()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, entry.message)
      assert.deepEqual(fixture.calls(), [])
    })
  }
})

test('requires every value to have exactly one policy', async (t) => {
  await t.test('declared secret missing from file', (t) => {
    const config = validConfig()
    config.security = { secretScanning: true }
    const fixture = createFixture(t, config)
    fixture.writeSecrets('OCTOOPS_TEST_ALL=dummy-all\nOCTOOPS_TEST_PRIVATE=dummy-private\n')
    const result = fixture.apply()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OCTOOPS_TEST_SELECTED.*declared but missing/)
    assert.deepEqual(fixture.calls(), [])
  })

  await t.test('file value missing a policy', (t) => {
    const config = validConfig()
    config.security = { secretScanning: true }
    const fixture = createFixture(t, config)
    fixture.writeSecrets(validSecrets() + 'OCTOOPS_TEST_EXTRA=dummy-extra\n')
    const result = fixture.apply()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OCTOOPS_TEST_EXTRA.*has no policy/)
    assert.deepEqual(fixture.calls(), [])
  })
})
