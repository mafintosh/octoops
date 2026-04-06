const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PERMISSIONS = {
  read: 'pull',
  write: 'push',
  triage: 'triage',
  maintain: 'maintain',
  admin: 'admin'
}

module.exports = { apply }

let auditStream = null

async function apply(config, opts = {}) {
  const dry = opts.dry === true
  const state = loadState(opts.statePath)

  if (opts.audit) {
    const dir = path.join(process.cwd(), 'audits')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const logPath = path.join(dir, stamp + '.log')
    auditStream = fs.createWriteStream(logPath)
    audit('octoops ' + (dry ? '--dry-run ' : '') + 'started at ' + new Date().toISOString())
    audit('config: ' + JSON.stringify(config, null, 2))
  }

  const presets = config.presets || {}

  try {
    for (const raw of config.repos) {
      const repo = resolve(raw, presets)
      const key = config.org + '/' + repo.name
      const prev = state[key] || {}
      const done = {}
      try {
        await reconcile(config.org, repo, prev, dry, done)
      } finally {
        if (!dry) {
          state[key] = Object.assign(prev, done)
          if (opts.statePath) saveState(opts.statePath, state)
        }
      }
    }
  } finally {
    if (auditStream) {
      audit('finished at ' + new Date().toISOString())
      auditStream.end()
      auditStream = null
    }
  }
}

function loadState(statePath) {
  if (!statePath) return {}
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'))
  } catch {
    return {}
  }
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
}

const PRESET_FIELDS = [
  'merging',
  'teams',
  'topics',
  'branchProtection',
  'environments',
  'rulesets',
  'npm'
]

function resolve(repo, presets) {
  const out = { ...repo }
  for (const field of PRESET_FIELDS) {
    if (typeof out[field] === 'string') {
      const val = presets[out[field]]
      if (!val) throw new Error('unknown preset "' + out[field] + '"')
      out[field] = val
    }
  }
  return out
}

function changed(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b)
}

async function reconcile(org, repo, prev, dry, done) {
  let current = await getRepo(org, repo.name)

  if (!current) {
    print(dry, 'create', `${org}/${repo.name}`)
    if (!dry) {
      await createRepo(org, repo)
      current = await getRepo(org, repo.name)
    }
  }

  const settings = { description: repo.description, private: repo.private, merging: repo.merging }
  const prevSettings = {
    description: prev.description,
    private: prev.private,
    merging: prev.merging
  }

  if (current && changed(settings, prevSettings)) {
    await reconcileSettings(org, repo, current, dry)
  }
  if (repo.description !== undefined) done.description = repo.description
  if (repo.private !== undefined) done.private = repo.private
  if (repo.merging) done.merging = repo.merging

  if (repo.topics && current && changed(repo.topics, prev.topics)) {
    await reconcileTopics(org, repo.name, repo.topics, dry)
  }
  if (repo.topics) done.topics = repo.topics

  if (current && repo.teams && changed(repo.teams, prev.teams)) {
    await reconcileTeams(org, repo.name, repo.teams, dry)
  }
  if (repo.teams) done.teams = repo.teams

  if (changed(repo.branchProtection, prev.branchProtection)) {
    for (const rule of repo.branchProtection || []) {
      if (current) await reconcileBranchProtection(org, repo.name, rule, dry)
    }
  }
  if (repo.branchProtection) done.branchProtection = repo.branchProtection

  if (changed(repo.environments, prev.environments)) {
    for (const env of repo.environments || []) {
      if (current) await reconcileEnvironment(org, repo.name, env, dry)
    }
  }
  if (repo.environments) done.environments = repo.environments

  if (current && repo.rulesets && changed(repo.rulesets, prev.rulesets)) {
    await reconcileRulesets(org, repo.name, repo.rulesets, dry)
  }
  if (repo.rulesets) done.rulesets = repo.rulesets

  if (repo.npm && changed(repo.npm, prev.npm)) {
    await reconcileNpm(org, repo.name, repo.npm, dry)
  }
  if (repo.npm) done.npm = repo.npm
}

async function reconcileSettings(org, repo, current, dry) {
  const patch = {}

  if (repo.description !== undefined && repo.description !== current.description) {
    patch.description = repo.description
  }
  if (repo.private !== undefined && repo.private !== current.private) {
    patch.private = repo.private
  }
  if (repo.merging) {
    const m = repo.merging
    if (m.squashOnly !== undefined) {
      if (m.squashOnly) {
        if (!current.allow_squash_merge) patch.allow_squash_merge = true
        if (current.allow_merge_commit) patch.allow_merge_commit = false
        if (current.allow_rebase_merge) patch.allow_rebase_merge = false
      } else {
        if (!current.allow_merge_commit) patch.allow_merge_commit = true
        if (!current.allow_rebase_merge) patch.allow_rebase_merge = true
      }
    }
    if (
      m.deleteBranchOnMerge !== undefined &&
      m.deleteBranchOnMerge !== current.delete_branch_on_merge
    ) {
      patch.delete_branch_on_merge = m.deleteBranchOnMerge
    }
  }

  if (!Object.keys(patch).length) return

  print(dry, 'update', `${org}/${repo.name}`, Object.keys(patch).join(', '))
  if (!dry)
    await gh(['api', `repos/${org}/${repo.name}`, '--method', 'PATCH', '--input', '-'], {
      body: patch
    })
}

async function reconcileTopics(org, name, topics, dry) {
  const { names: current } = await gh(['api', `repos/${org}/${name}/topics`]).then(JSON.parse)
  const sorted = [...topics].sort()
  if (JSON.stringify([...current].sort()) === JSON.stringify(sorted)) return

  print(dry, 'topics', `${org}/${name}`, topics.join(', '))
  if (!dry)
    await gh(['api', `repos/${org}/${name}/topics`, '--method', 'PUT', '--input', '-'], {
      body: { names: topics }
    })
}

async function reconcileTeams(org, name, desired, dry) {
  const current = await getTeams(org, name)
  const currentMap = new Map(current.map((t) => [t.slug, t.permission]))
  const desiredMap = new Map(
    desired.map((t) => [slugify(t.name), PERMISSIONS[t.permission] || t.permission])
  )

  for (const [slug, perm] of desiredMap) {
    if (currentMap.get(slug) === perm) continue
    print(dry, 'team', `${org}/${name}`, `${slug} -> ${perm}`)
    if (!dry)
      await gh([
        'api',
        `orgs/${org}/teams/${slug}/repos/${org}/${name}`,
        '--method',
        'PUT',
        '-f',
        `permission=${perm}`
      ])
  }

  for (const [slug] of currentMap) {
    if (desiredMap.has(slug)) continue
    print(dry, 'remove-team', `${org}/${name}`, slug)
    if (!dry)
      await gh(['api', `orgs/${org}/teams/${slug}/repos/${org}/${name}`, '--method', 'DELETE'])
  }
}

async function reconcileBranchProtection(org, name, rule, dry) {
  const { branch = 'main', enforceAdmins = false, requiredReviews } = rule

  const body = {
    required_status_checks: null,
    enforce_admins: enforceAdmins,
    required_pull_request_reviews: requiredReviews
      ? {
          required_approving_review_count: requiredReviews.approvals || 1,
          dismiss_stale_reviews: requiredReviews.dismissStale || false,
          require_code_owner_reviews: requiredReviews.codeOwners || false
        }
      : null,
    restrictions: null
  }

  print(dry, 'branch-protection', `${org}/${name}`, branch)
  if (!dry)
    await gh(
      [
        'api',
        `repos/${org}/${name}/branches/${branch}/protection`,
        '--method',
        'PUT',
        '--input',
        '-'
      ],
      { body }
    )
}

async function reconcileEnvironment(org, repoName, env, dry) {
  const current = await getEnvironment(org, repoName, env.name)

  const desiredReviewerSlugs = (env.reviewers || []).map((r) => slugify(r.team))

  if (current) {
    const currentSlugs = (current.protection_rules || [])
      .flatMap((r) => r.reviewers || [])
      .filter((r) => r.type === 'Team')
      .map((r) => r.reviewer.slug)
      .sort()

    if (JSON.stringify(currentSlugs) === JSON.stringify([...desiredReviewerSlugs].sort())) return
  }

  print(
    dry,
    'environment',
    `${org}/${repoName}`,
    `${env.name} reviewers=${desiredReviewerSlugs.join(',')}`
  )
  if (dry) return

  const reviewers = []
  for (const slug of desiredReviewerSlugs) {
    const team = JSON.parse(await gh(['api', `orgs/${org}/teams/${slug}`]))
    reviewers.push({ type: 'Team', id: team.id })
  }

  await gh(
    ['api', `repos/${org}/${repoName}/environments/${env.name}`, '--method', 'PUT', '--input', '-'],
    {
      body: { reviewers }
    }
  )
}

async function reconcileRulesets(org, repoName, desired, dry) {
  const current = await getRulesets(org, repoName)
  const currentByName = new Map(current.map((r) => [r.name, r]))

  for (const ruleset of desired) {
    const body = await buildRulesetBody(org, ruleset)
    const existing = currentByName.get(ruleset.name)

    if (existing) {
      const full = JSON.parse(await gh(['api', `repos/${org}/${repoName}/rulesets/${existing.id}`]))
      if (rulesetMatches(full, body)) continue
      print(dry, 'update-ruleset', `${org}/${repoName}`, ruleset.name)
      if (!dry)
        await gh(
          [
            'api',
            `repos/${org}/${repoName}/rulesets/${existing.id}`,
            '--method',
            'PUT',
            '--input',
            '-'
          ],
          { body }
        )
    } else {
      print(dry, 'create-ruleset', `${org}/${repoName}`, ruleset.name)
      if (!dry)
        await gh(['api', `repos/${org}/${repoName}/rulesets`, '--method', 'POST', '--input', '-'], {
          body
        })
    }
  }
}

async function buildRulesetBody(org, ruleset) {
  const rules = []

  if (ruleset.preventDeletion) {
    rules.push({ type: 'deletion' })
  }

  if (ruleset.preventForcePush) {
    rules.push({ type: 'non_fast_forward' })
  }

  if (ruleset.requirePR) {
    const pr = ruleset.requirePR
    rules.push({
      type: 'pull_request',
      parameters: {
        required_approving_review_count: pr.approvals || 1,
        dismiss_stale_reviews_on_push: pr.dismissStale || false,
        require_code_owner_review: pr.codeOwners || false,
        require_last_push_approval: pr.lastPushApproval || false,
        required_review_thread_resolution: pr.resolveThreads || false
      }
    })
  }

  if (ruleset.requiredStatusChecks) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: ruleset.requiredStatusChecks.strict || false,
        required_status_checks: ruleset.requiredStatusChecks.checks.map((c) => {
          if (typeof c === 'string') return { context: c }
          return { context: c.context, integration_id: c.integrationId }
        })
      }
    })
  }

  if (ruleset.filePathRestrictions) {
    rules.push({
      type: 'file_path_restriction',
      parameters: {
        restricted_file_paths: ruleset.filePathRestrictions
      }
    })
  }

  if (ruleset.requiredWorkflows) {
    rules.push({
      type: 'workflows',
      parameters: {
        do_not_enforce_on_create: false,
        workflows: ruleset.requiredWorkflows.map((w) => ({
          path: w.path,
          repository_id: w.repositoryId,
          ref: w.ref || 'main'
        }))
      }
    })
  }

  const body = {
    name: ruleset.name,
    target: ruleset.target || 'branch',
    enforcement: ruleset.enforcement || 'active',
    conditions: {
      ref_name: {
        include: ruleset.include || ['~DEFAULT_BRANCH'],
        exclude: ruleset.exclude || []
      }
    },
    rules
  }

  if (ruleset.bypassActors) {
    body.bypass_actors = []
    for (const a of ruleset.bypassActors) {
      let id = a.id || null
      const type = a.type || (a.team ? 'Team' : null)
      if (a.team) {
        const team = JSON.parse(await gh(['api', `orgs/${org}/teams/${slugify(a.team)}`]))
        id = team.id
      }
      body.bypass_actors.push({
        actor_id: id,
        actor_type: type,
        bypass_mode: a.mode || 'always'
      })
    }
  }

  return body
}

function rulesetMatches(current, desired) {
  if (current.name !== desired.name) return false
  if (current.target !== desired.target) return false
  if (current.enforcement !== desired.enforcement) return false
  if (JSON.stringify(current.conditions) !== JSON.stringify(desired.conditions)) return false

  // compare rules by type — ignore extra fields github adds (id, created_at, etc.)
  const currentRules = (current.rules || []).map((r) => r.type).sort()
  const desiredRules = (desired.rules || []).map((r) => r.type).sort()
  if (JSON.stringify(currentRules) !== JSON.stringify(desiredRules)) return false

  for (const dr of desired.rules || []) {
    const cr = (current.rules || []).find((r) => r.type === dr.type)
    if (!cr) return false
    if (dr.parameters && JSON.stringify(dr.parameters) !== JSON.stringify(cr.parameters))
      return false
  }

  // compare bypass actors by actor_id + actor_type + bypass_mode
  const normBypass = (actors) =>
    (actors || []).map((a) => a.actor_id + ':' + a.actor_type + ':' + a.bypass_mode).sort()
  if (
    JSON.stringify(normBypass(current.bypass_actors)) !==
    JSON.stringify(normBypass(desired.bypass_actors))
  )
    return false

  return true
}

async function getRulesets(org, name) {
  try {
    return JSON.parse(await gh(['api', `repos/${org}/${name}/rulesets`]))
  } catch {
    return []
  }
}

async function getEnvironment(org, name, env) {
  try {
    return JSON.parse(await gh(['api', `repos/${org}/${name}/environments/${env}`]))
  } catch {
    return null
  }
}

async function ensureNpmPackage(pkg, dry) {
  const { code } = await run('npm', ['view', pkg, 'name'], { allowFailure: true })
  if (code === 0) return

  print(dry, 'npm-publish', pkg, 'placeholder 0.0.0')
  if (dry) return

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octoops-'))
  try {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: pkg, version: '0.0.0' })
    )
    await run('npm', ['publish', '--access', 'public'], { cwd: tmp, interactive: true })
  } finally {
    fs.rmSync(tmp, { recursive: true })
  }
}

async function reconcileNpm(org, repoName, npm, dry) {
  const pkg = npm.package || repoName
  const tp = npm.trustedPublishing
  if (!tp) return

  await ensureNpmPackage(pkg, dry)

  const setArgs = [
    'trust',
    'github',
    pkg,
    '--file',
    tp.workflow,
    '--repository',
    `${org}/${repoName}`,
    '--yes'
  ]
  if (tp.environment) setArgs.push('--environment', tp.environment)

  print(dry, 'npm-trust', pkg, `${org}/${repoName} via ${tp.workflow}`)
  if (dry) return

  console.log(
    '\n  When authenticating with npm, check the box to allow 5 minutes of non-authenticated access.\n'
  )

  // trigger auth interactively
  await run('npm', ['trust', 'list', pkg], { interactive: true })

  // now re-run piped to capture JSON
  const out = await run('npm', ['trust', 'list', pkg, '--json'])
  const parsed = out ? JSON.parse(out) : []
  const current = Array.isArray(parsed) ? parsed : [parsed]

  const match = current.find(
    (c) => c.type === 'github' && c.repository === `${org}/${repoName}` && c.file === tp.workflow
  )

  if (match) return

  for (const c of current) {
    if (c.id) await run('npm', ['trust', 'revoke', pkg, '--id', c.id], { interactive: true })
  }

  await run('npm', setArgs, { interactive: true })
}

async function getRepo(org, name) {
  try {
    return JSON.parse(await gh(['api', `repos/${org}/${name}`]))
  } catch {
    return null
  }
}

async function getTeams(org, name) {
  try {
    return JSON.parse(await gh(['api', `repos/${org}/${name}/teams`, '--paginate']))
  } catch {
    return []
  }
}

async function createRepo(org, repo) {
  const args = [
    'repo',
    'create',
    `${org}/${repo.name}`,
    repo.private === false ? '--public' : '--private'
  ]
  if (repo.description) args.push('--description', repo.description)
  await gh(args)
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-')
}

function audit(msg) {
  if (auditStream) auditStream.write(msg + '\n')
}

function print(dry, action, target, detail) {
  const line = (dry ? '[dry] ' : '') + action + ' ' + target + (detail ? ' (' + detail + ')' : '')
  console.log(line)
  audit(line)
}

function gh(args, opts) {
  return run('gh', args, opts)
}

function run(cmd, args, opts = {}) {
  const line = '> ' + cmd + ' ' + args.join(' ')
  console.log(line)
  audit(line)

  if (opts.interactive) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', cwd: opts.cwd })
      child.on('close', (code) => {
        if (opts.allowFailure) resolve({ code })
        else if (code !== 0) reject(new Error(`${cmd} exited with code ${code}`))
        else resolve('')
      })
    })
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd })

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')

    let out = ''
    let err = ''

    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })

    child.on('close', (code) => {
      if (opts.allowFailure) resolve({ code, stdout: out.trim(), stderr: err.trim() })
      else if (code !== 0) reject(new Error(err.trim() || `${cmd} exited with code ${code}`))
      else resolve(out.trim())
    })

    if (opts.body) {
      child.stdin.write(JSON.stringify(opts.body))
    }
    child.stdin.end()
  })
}
