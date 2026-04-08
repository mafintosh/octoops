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

module.exports = { apply, importOrg, seed }

const PERMISSIONS_REVERSE = {
  pull: 'read',
  push: 'write',
  triage: 'triage',
  maintain: 'maintain',
  admin: 'admin'
}

async function importOrg(org, opts = {}) {
  const only = opts.only ? new Set(opts.only) : null
  const config = { org }

  if (!only || only.has('members')) {
    console.log('fetching org members...')
    const admins = JSON.parse(await gh(['api', `orgs/${org}/members?role=admin`, '--paginate']))
      .map((m) => m.login)
      .sort()
    const members = JSON.parse(await gh(['api', `orgs/${org}/members?role=member`, '--paginate']))
      .map((m) => m.login)
      .sort()
    if (admins.length) config.admins = admins
    if (members.length) config.members = members
  }

  if (!only || only.has('teams')) {
    console.log('fetching org teams...')
    const orgTeams = await importOrgTeams(org)
    if (orgTeams.length) config.teams = orgTeams
  }

  if (!only || only.has('repos')) {
    console.log('fetching repos...')
    const repoNames = JSON.parse(await gh(['api', `orgs/${org}/repos`, '--paginate']))
      .map((r) => r.name)
      .sort()

    config.repos = []
    for (let i = 0; i < repoNames.length; i++) {
      const name = repoNames[i]
      console.log(`importing ${name} (${i + 1}/${repoNames.length})...`)
      await checkRateLimit()
      config.repos.push(await importRepo(org, name))
    }
  }

  return config
}

async function importOrgTeams(org) {
  const teams = JSON.parse(await gh(['api', `orgs/${org}/teams`, '--paginate']))
  const result = []

  for (const team of teams) {
    await checkRateLimit()
    const entry = { name: team.name }
    if (team.description) entry.description = team.description
    if (team.privacy) entry.privacy = team.privacy
    if (team.parent) entry.parent = team.parent.name

    const members = JSON.parse(
      await gh(['api', `orgs/${org}/teams/${team.slug}/members`, '--paginate'])
    )
    if (members.length) {
      entry.members = []
      for (const m of members) {
        await checkRateLimit()
        const membership = JSON.parse(
          await gh(['api', `orgs/${org}/teams/${team.slug}/memberships/${m.login}`])
        )
        entry.members.push({ username: m.login, role: membership.role })
      }
    }

    result.push(entry)
  }

  return result
}

async function importRepo(org, name) {
  const repo = JSON.parse(await gh(['api', `repos/${org}/${name}`]))
  const entry = { name }

  if (repo.description) entry.description = repo.description
  entry.private = repo.private

  const merging = {}
  if (!repo.allow_merge_commit && !repo.allow_rebase_merge && repo.allow_squash_merge) {
    merging.squashOnly = true
  }
  if (repo.delete_branch_on_merge) merging.deleteBranchOnMerge = true
  if (Object.keys(merging).length) entry.merging = merging

  const { names: topics } = JSON.parse(await gh(['api', `repos/${org}/${name}/topics`]))
  if (topics.length) entry.topics = topics

  const teams = JSON.parse(await gh(['api', `repos/${org}/${name}/teams`, '--paginate']))
  if (teams.length) {
    entry.teams = teams.map((t) => ({
      name: t.name,
      permission: PERMISSIONS_REVERSE[t.permission] || t.permission
    }))
  }

  const collabs = await getCollaborators(org, name)
  if (collabs.length) {
    entry.collaborators = collabs.map((c) => ({
      username: c.login,
      permission: PERMISSIONS_REVERSE[c.role_name] || c.role_name
    }))
  }

  try {
    const bp = JSON.parse(
      await gh(['api', `repos/${org}/${name}/branches/${repo.default_branch}/protection`])
    )
    const rule = { branch: repo.default_branch }
    if (bp.enforce_admins && bp.enforce_admins.enabled) rule.enforceAdmins = true
    if (bp.required_pull_request_reviews) {
      const pr = bp.required_pull_request_reviews
      rule.requiredReviews = {}
      if (pr.required_approving_review_count) {
        rule.requiredReviews.approvals = pr.required_approving_review_count
      }
      if (pr.dismiss_stale_reviews) rule.requiredReviews.dismissStale = true
      if (pr.require_code_owner_reviews) rule.requiredReviews.codeOwners = true
    }
    entry.branchProtection = [rule]
  } catch {}

  try {
    const { environments } = JSON.parse(await gh(['api', `repos/${org}/${name}/environments`]))
    if (environments && environments.length) {
      entry.environments = []
      for (const env of environments) {
        const e = { name: env.name }
        const reviewers = (env.protection_rules || [])
          .flatMap((r) => r.reviewers || [])
          .filter((r) => r.type === 'Team')
          .map((r) => ({ team: r.reviewer.name }))
        if (reviewers.length) e.reviewers = reviewers
        entry.environments.push(e)
      }
    }
  } catch {}

  try {
    const rulesets = JSON.parse(await gh(['api', `repos/${org}/${name}/rulesets`]))
    if (rulesets.length) {
      entry.rulesets = []
      for (const rs of rulesets) {
        await checkRateLimit()
        const full = JSON.parse(await gh(['api', `repos/${org}/${name}/rulesets/${rs.id}`]))
        const r = { name: full.name }
        if (full.target && full.target !== 'branch') r.target = full.target
        if (full.enforcement && full.enforcement !== 'active') r.enforcement = full.enforcement
        if (full.conditions && full.conditions.ref_name) {
          const ref = full.conditions.ref_name
          if (ref.include && JSON.stringify(ref.include) !== '["~DEFAULT_BRANCH"]') {
            r.include = ref.include
          }
          if (ref.exclude && ref.exclude.length) r.exclude = ref.exclude
        }
        for (const rule of full.rules || []) {
          if (rule.type === 'deletion') r.preventDeletion = true
          if (rule.type === 'non_fast_forward') r.preventForcePush = true
          if (rule.type === 'pull_request' && rule.parameters) {
            r.requirePR = {}
            if (rule.parameters.required_approving_review_count) {
              r.requirePR.approvals = rule.parameters.required_approving_review_count
            }
            if (rule.parameters.dismiss_stale_reviews_on_push) r.requirePR.dismissStale = true
            if (rule.parameters.require_code_owner_review) r.requirePR.codeOwners = true
            if (rule.parameters.require_last_push_approval) r.requirePR.lastPushApproval = true
            if (rule.parameters.required_review_thread_resolution) r.requirePR.resolveThreads = true
          }
          if (rule.type === 'file_path_restriction' && rule.parameters) {
            r.filePathRestrictions = rule.parameters.restricted_file_paths
          }
          if (rule.type === 'required_status_checks' && rule.parameters) {
            r.requiredStatusChecks = {
              strict: rule.parameters.strict_required_status_checks_policy || false,
              checks: (rule.parameters.required_status_checks || []).map((c) => c.context)
            }
          }
        }
        if (full.bypass_actors && full.bypass_actors.length) {
          r.bypassActors = full.bypass_actors.map((a) => ({
            id: a.actor_id,
            type: a.actor_type,
            mode: a.bypass_mode
          }))
        }
        entry.rulesets.push(r)
      }
    }
  } catch {}

  return entry
}

async function checkRateLimit() {
  const data = JSON.parse(await gh(['api', 'rate_limit']))
  const core = data.resources.core
  if (core.remaining > 100) return
  const reset = core.reset * 1000
  const wait = reset - Date.now() + 1000
  if (wait <= 0) return
  console.log(`rate limit low (${core.remaining} remaining), waiting ${Math.ceil(wait / 1000)}s...`)
  await new Promise((resolve) => setTimeout(resolve, wait))
}

let auditStream = null

function seed(config, opts = {}) {
  const state = loadState(opts.statePath)
  const presets = config.presets || {}

  if (config.admins) state.admins = config.admins
  if (config.members) state.members = config.members

  if (config.teams) {
    const teamState = {}
    for (const team of config.teams) teamState[slugify(team.name)] = team
    state.teams = teamState
  }

  for (const raw of config.repos) {
    const repo = resolve(raw, presets)
    const key = config.org + '/' + repo.name
    const entry = {}
    if (repo.description !== undefined) entry.description = repo.description
    if (repo.private !== undefined) entry.private = repo.private
    if (repo.merging) entry.merging = repo.merging
    if (repo.topics) entry.topics = repo.topics
    if (repo.teams) entry.teams = repo.teams
    if (repo.collaborators) entry.collaborators = repo.collaborators
    if (repo.branchProtection) entry.branchProtection = repo.branchProtection
    if (repo.environments) entry.environments = repo.environments
    if (repo.rulesets) entry.rulesets = repo.rulesets
    if (repo.npm) entry.npm = repo.npm
    state[key] = entry
  }

  if (opts.statePath) saveState(opts.statePath, state)
  console.log('seeded state for ' + (config.teams ? config.teams.length + ' teams and ' : '') + config.repos.length + ' repos')
}

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

  if ((config.admins || config.members) && config.teams) {
    const orgMembers = new Set([...(config.admins || []), ...(config.members || [])])
    for (const team of config.teams) {
      for (const m of team.members || []) {
        if (!orgMembers.has(m.username)) {
          console.error(`warning: ${m.username} is in team "${team.name}" but not in admins/members`)
        }
      }
    }
  }

  try {
    const adminsChanged = (config.admins || state.admins) && changed(config.admins, state.admins)
    const membersChanged = (config.members || state.members) && changed(config.members, state.members)

    if (adminsChanged || membersChanged) {
      const allDesired = new Set([...(config.admins || []), ...(config.members || [])])
      await reconcileOrgMembers(config.org, config.admins || [], state.admins, 'admin', allDesired, dry)
      await reconcileOrgMembers(config.org, config.members || [], state.members, 'member', allDesired, dry)
      if (!dry) {
        state.admins = config.admins
        state.members = config.members
        if (opts.statePath) saveState(opts.statePath, state)
      }
    }

    if (config.teams) {
      if (Array.isArray(state.teams)) {
        const migrated = {}
        for (const t of state.teams) migrated[slugify(t.name)] = t
        state.teams = migrated
        if (opts.statePath) saveState(opts.statePath, state)
      }
      const teamState = state.teams || {}
      let teamsChanged = false
      for (const team of config.teams) {
        const key = slugify(team.name)
        if (changed(team, teamState[key])) {
          await reconcileOrgTeam(config.org, team, teamState[key], dry)
          if (!dry) {
            teamState[key] = team
            teamsChanged = true
          }
        }
      }
      if (teamsChanged) {
        state.teams = teamState
        if (opts.statePath) saveState(opts.statePath, state)
      }
    }

    for (const raw of config.repos || []) {
      const repo = resolve(raw, presets)
      const key = config.org + '/' + repo.name
      const prev = state[key] || {}
      const done = {}
      try {
        await reconcile(config.org, repo, prev, dry, done, opts)
      } finally {
        if (!dry && Object.keys(done).length) {
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

function repoChanged(repo, prev) {
  const settings = { description: repo.description, private: repo.private, merging: repo.merging }
  const prevSettings = { description: prev.description, private: prev.private, merging: prev.merging }
  if (changed(settings, prevSettings)) return true
  if ((repo.topics || prev.topics) && changed(repo.topics, prev.topics)) return true
  if ((repo.teams || prev.teams) && changed(repo.teams, prev.teams)) return true
  if ((repo.collaborators || prev.collaborators) && changed(repo.collaborators, prev.collaborators)) return true
  if (changed(repo.branchProtection, prev.branchProtection)) return true
  if (changed(repo.environments, prev.environments)) return true
  if ((repo.rulesets || prev.rulesets) && changed(repo.rulesets, prev.rulesets)) return true
  if ((repo.npm || prev.npm) && changed(repo.npm, prev.npm)) return true
  return false
}

async function reconcile(org, repo, prev, dry, done, opts) {
  if (!repoChanged(repo, prev)) return

  let current = Object.keys(prev).length > 0

  if (!current) {
    const existing = await getRepo(org, repo.name)
    if (!existing) {
      print(dry, 'create', `${org}/${repo.name}`)
      if (!dry) {
        await createRepo(org, repo)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      // createRepo already sets description and visibility
      if (repo.description !== undefined) prev.description = repo.description
      if (repo.private !== undefined) prev.private = repo.private
    }
    current = true
  }

  const settings = { description: repo.description, private: repo.private, merging: repo.merging }
  const prevSettings = {
    description: prev.description,
    private: prev.private,
    merging: prev.merging
  }

  if (current && changed(settings, prevSettings)) {
    await reconcileSettings(org, repo, dry)
  }
  if (repo.description !== undefined) done.description = repo.description
  if (repo.private !== undefined) done.private = repo.private
  if (repo.merging) done.merging = repo.merging

  if (repo.topics && current && changed(repo.topics, prev.topics)) {
    await reconcileTopics(org, repo.name, repo.topics, dry)
  }
  if (repo.topics) done.topics = repo.topics

  if (current && (repo.teams || prev.teams) && changed(repo.teams, prev.teams)) {
    await reconcileTeams(org, repo.name, repo.teams || [], prev.teams, dry)
  }
  done.teams = repo.teams

  if (current && (repo.collaborators || prev.collaborators) && changed(repo.collaborators, prev.collaborators)) {
    await reconcileCollaborators(org, repo.name, repo.collaborators || [], prev.collaborators, dry)
  }
  done.collaborators = repo.collaborators

  if (changed(repo.branchProtection, prev.branchProtection)) {
    for (const rule of repo.branchProtection || []) {
      if (current) await reconcileBranchProtection(org, repo.name, rule, dry)
    }
  }
  if (repo.branchProtection) done.branchProtection = repo.branchProtection

  if (changed(repo.environments, prev.environments)) {
    const hasReviewers = (repo.environments || []).some((e) => e.reviewers && e.reviewers.length)
    const skip = hasReviewers && repo.private !== false && !opts.enterprise

    if (skip) {
      print(dry, 'skip-environments', `${org}/${repo.name}`, 'requires enterprise for private repos with reviewers')
    } else {
      for (const env of repo.environments || []) {
        if (current) await reconcileEnvironment(org, repo.name, env, dry)
      }
      if (repo.environments) done.environments = repo.environments
    }
  }

  if (current && repo.rulesets && changed(repo.rulesets, prev.rulesets)) {
    await reconcileRulesets(org, repo.name, repo.rulesets, dry)
  }
  if (repo.rulesets) done.rulesets = repo.rulesets

  if (repo.npm && changed(repo.npm, prev.npm)) {
    await reconcileNpm(org, repo.name, repo.npm, dry)
  }
  if (repo.npm) done.npm = repo.npm
}

async function reconcileSettings(org, repo, dry) {
  const patch = {}

  if (repo.description !== undefined) patch.description = repo.description
  if (repo.private !== undefined) patch.private = repo.private
  if (repo.merging) {
    const m = repo.merging
    if (m.squashOnly !== undefined) {
      patch.allow_squash_merge = !!m.squashOnly
      patch.allow_merge_commit = !m.squashOnly
      patch.allow_rebase_merge = !m.squashOnly
    }
    if (m.deleteBranchOnMerge !== undefined) {
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
  print(dry, 'topics', `${org}/${name}`, topics.join(', '))
  if (!dry)
    await gh(['api', `repos/${org}/${name}/topics`, '--method', 'PUT', '--input', '-'], {
      body: { names: topics }
    })
}

async function reconcileTeams(org, name, desired, prev, dry) {
  const prevMap = new Map((prev || []).map((t) => [slugify(t.name), PERMISSIONS[t.permission] || t.permission]))
  const desiredMap = new Map(
    desired.map((t) => [slugify(t.name), PERMISSIONS[t.permission] || t.permission])
  )

  for (const [slug, perm] of desiredMap) {
    if (prevMap.get(slug) === perm) continue
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

  for (const [slug] of prevMap) {
    if (desiredMap.has(slug)) continue
    print(dry, 'remove-team', `${org}/${name}`, slug)
    if (!dry)
      await gh(['api', `orgs/${org}/teams/${slug}/repos/${org}/${name}`, '--method', 'DELETE'])
  }
}

async function reconcileCollaborators(org, name, desired, prev, dry) {
  const prevMap = new Map((prev || []).map((c) => [c.username, PERMISSIONS[c.permission] || c.permission]))
  const desiredMap = new Map(
    desired.map((c) => [c.username, PERMISSIONS[c.permission] || c.permission])
  )

  for (const [username, perm] of desiredMap) {
    if (prevMap.get(username) === perm) continue
    print(dry, 'collaborator', `${org}/${name}`, `${username} -> ${perm}`)
    if (!dry)
      await gh(
        [
          'api',
          `repos/${org}/${name}/collaborators/${username}`,
          '--method',
          'PUT',
          '--input',
          '-'
        ],
        { body: { permission: perm } }
      )
  }

  for (const [username] of prevMap) {
    if (desiredMap.has(username)) continue
    print(dry, 'remove-collaborator', `${org}/${name}`, username)
    if (!dry)
      await gh(['api', `repos/${org}/${name}/collaborators/${username}`, '--method', 'DELETE'])
  }
}

async function getCollaborators(org, name) {
  try {
    return JSON.parse(
      await gh(['api', `repos/${org}/${name}/collaborators?affiliation=direct`, '--paginate'])
    )
  } catch {
    return []
  }
}

async function reconcileOrgMembers(org, desired, prev, role, allDesired, dry) {
  const prevSet = new Set(prev || [])
  const desiredSet = new Set(desired)

  for (const username of desiredSet) {
    if (prevSet.has(username)) continue
    print(dry, 'org-' + role, org, username)
    if (!dry)
      await gh([
        'api',
        `orgs/${org}/memberships/${username}`,
        '--method',
        'PUT',
        '-f',
        `role=${role}`
      ])
  }

  for (const username of prevSet) {
    if (desiredSet.has(username)) continue
    if (allDesired.has(username)) continue // moving between admin/member, not removing
    print(dry, 'remove-org-member', org, username)
    if (!dry)
      await gh(['api', `orgs/${org}/memberships/${username}`, '--method', 'DELETE'])
  }
}

async function reconcileOrgTeam(org, team, prevTeam, dry) {
  const slug = slugify(team.name)
  const existing = await getOrgTeam(org, slug)

  if (!existing) {
    print(dry, 'create-team', org, team.name)
    if (!dry) {
      const body = { name: team.name, privacy: team.privacy || 'closed' }
      if (team.description) body.description = team.description
      if (team.parent) {
        const parent = await getOrgTeam(org, slugify(team.parent))
        if (parent) body.parent_team_id = parent.id
      }
      await gh(['api', `orgs/${org}/teams`, '--method', 'POST', '--input', '-'], { body })
    }
  } else {
    const patch = {}
    if (team.description !== undefined && team.description !== existing.description) {
      patch.description = team.description
    }
    if (team.privacy && team.privacy !== existing.privacy) {
      patch.privacy = team.privacy
    }
    if (team.parent) {
      const parent = await getOrgTeam(org, slugify(team.parent))
      if (parent && (!existing.parent || existing.parent.id !== parent.id)) {
        patch.parent_team_id = parent.id
      }
    }
    if (Object.keys(patch).length) {
      print(dry, 'update-team', org, team.name)
      if (!dry)
        await gh(['api', `orgs/${org}/teams/${slug}`, '--method', 'PATCH', '--input', '-'], {
          body: patch
        })
    }
  }

  if (!team.members || !changed(team.members, prevTeam && prevTeam.members)) return

  const prevMap = new Map((prevTeam && prevTeam.members || []).map((m) => [m.username, m.role || 'member']))
  const desiredMap = new Map(team.members.map((m) => [m.username, m.role || 'member']))

  for (const [username, role] of desiredMap) {
    if (prevMap.get(username) === role) continue
    print(dry, 'team-member', `${org}/${slug}`, `${username} -> ${role}`)
    if (!dry)
      await gh([
        'api',
        `orgs/${org}/teams/${slug}/memberships/${username}`,
        '--method',
        'PUT',
        '-f',
        `role=${role}`
      ])
  }

  for (const [username] of prevMap) {
    if (desiredMap.has(username)) continue
    print(dry, 'remove-team-member', `${org}/${slug}`, username)
    if (!dry)
      await gh(['api', `orgs/${org}/teams/${slug}/memberships/${username}`, '--method', 'DELETE'])
  }
}

async function getOrgTeam(org, slug) {
  try {
    return JSON.parse(await gh(['api', `orgs/${org}/teams/${slug}`]))
  } catch {
    return null
  }
}

async function getOrgTeamMembers(org, slug) {
  try {
    const members = JSON.parse(await gh(['api', `orgs/${org}/teams/${slug}/members`, '--paginate']))
    const result = []
    for (const m of members) {
      const membership = JSON.parse(
        await gh(['api', `orgs/${org}/teams/${slug}/memberships/${m.login}`])
      )
      result.push({ login: m.login, role: membership.role })
    }
    return result
  } catch {
    return []
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
      const type = a.type || (a.team ? 'Team' : a.username ? 'User' : null)
      if (a.team) {
        const team = JSON.parse(await gh(['api', `orgs/${org}/teams/${slugify(a.team)}`]))
        id = team.id
      }
      if (a.username) {
        const user = JSON.parse(await gh(['api', `users/${a.username}`]))
        id = user.id
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
    if (dr.parameters) {
      for (const k of Object.keys(dr.parameters)) {
        if (JSON.stringify(dr.parameters[k]) !== JSON.stringify((cr.parameters || {})[k])) return false
      }
    }
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
