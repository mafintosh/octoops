# octoops

Declarative GitHub repo configuration using the `gh` CLI.

Maintain a JSON config describing desired state for your org's repos. Running `octoops` reconciles actual state with desired state using `gh api` calls. Idempotent and safe to run repeatedly.

```
npm install -g octoops
```

## Usage

```bash
octoops apply config.json
octoops apply --dry-run config.json
octoops apply --audit config.json
```

Import an existing org into a config file:

```bash
octoops import my-org > config.json
octoops import my-org -o config.json
octoops import my-org --only members
octoops import my-org --only members,teams
```

Seed state from an existing config (skips GitHub API calls):

```bash
octoops seed config.json
```

Resync state from live GitHub (use this if your state file got out of sync):

```bash
octoops resync config.json
```

Respects GitHub API rate limits automatically.

## Configuration

```json
{
  "org": "my-org",
  "presets": {
    "standard-teams": [
      { "name": "backend", "permission": "write" },
      { "name": "devops", "permission": "admin" }
    ]
  },
  "repos": [
    {
      "name": "my-service",
      "description": "Does the thing",
      "private": true,
      "merging": { "squashOnly": true, "deleteBranchOnMerge": true },
      "topics": ["nodejs"],
      "teams": "standard-teams",
      "branchProtection": [
        { "branch": "main", "enforceAdmins": true, "requiredReviews": { "approvals": 1 } }
      ],
      "environments": [{ "name": "production", "reviewers": [{ "team": "devops" }] }],
      "rulesets": [
        {
          "name": "protect-workflows",
          "include": ["~ALL"],
          "filePathRestrictions": [".github/workflows/**"],
          "bypassActors": [{ "team": "devops" }]
        }
      ],
      "npm": {
        "trustedPublishing": { "workflow": "release.yml", "environment": "production" }
      }
    }
  ]
}
```

Any repo field that accepts an object or array can be a string instead, referencing a key in `presets`. Supported fields: `merging`, `teams`, `topics`, `branchProtection`, `environments`, `rulesets`, `npm`. This lets you define a config once and reuse it across repos.

### Repo settings

Top-level repo fields for basic settings:

- `description` — repo description
- `private: true|false` — visibility
- `internal: true` — internal visibility (Enterprise only, overrides `private`)
- `defaultBranch` — default branch name (e.g. `"main"`)
- `wiki: true|false` — enable/disable repo wiki
- `projects: true|false` — enable/disable repo projects
- `archived: true` — archive the repo (skips further reconcile). Removing this from the config (when state has it) unarchives the repo
- `init: true` — initialize the repo with a README so the default branch exists. On create, passes `--add-readme` to `gh repo create`. On an existing empty repo (no branches), creates `README.md` retroactively. Once initialized, recorded in state and not re-checked
- `merging` — `{ squashOnly, deleteBranchOnMerge }`

Omitting a field leaves the current GitHub value untouched. Setting it makes octoops reconcile it.

### Secrets

Reference a local dotenv-style file from a repo or environment:

```json
{
  "name": "my-repo",
  "secrets": ".secrets",
  "environments": [
    { "name": "production", "secrets": ".secrets.prod" }
  ]
}
```

File format (`KEY=value`, `#` comments, optional quoting):

```
NPM_TOKEN=abc123
SLACK_WEBHOOK="https://hooks.slack.com/..."
# tokens
GH_TOKEN='ghp_...'
```

Behavior:

- Paths resolve relative to the config file
- Missing file → octoops prints `skip-secrets` and leaves existing secrets/state alone (so you can `.gitignore` the secrets file and only run apply where it's present)
- Each secret is hashed with a per-secret HMAC-SHA256 salt (`[salt, hmac]`); state never holds plaintext, and hashes can't be correlated across secrets/repos/state files
- Only secrets whose value changed are PUT to GitHub; secrets removed from the file are deleted from GitHub
- Values are sent to `gh secret set` over stdin (never on the command line, never logged)

### Ruleset fields

Each entry in `rulesets` supports:

- `name` — required
- `target` — `"branch"` (default) or `"tag"`
- `enforcement` — `"active"` (default), `"evaluate"`, or `"disabled"`
- `include` / `exclude` — branch/tag patterns. Defaults to `["~DEFAULT_BRANCH"]`. Use `"~ALL"` to match everything
- `preventCreation: true` — block creating matching branches/tags
- `preventUpdate: true` — block updating matching branches/tags
- `preventDeletion: true` — block branch/tag deletion
- `preventForcePush: true` — block force pushes
- `requireLinearHistory: true` — require linear commit history (no merge commits)
- `requireSignedCommits: true` — require signed commits
- `requirePR: { approvals, dismissStale, codeOwners, lastPushApproval, resolveThreads, requiredReviewers }` — require pull requests
- `requirePR.requiredReviewers` — see "Required reviewers" below
- `requiredStatusChecks: { strict, checks: [...] }` — required CI checks; `checks` is strings or `{ context, integrationId }`
- `filePathRestrictions: ["..."]` — glob restrictions on which file paths can change
- `requiredWorkflows: [{ path, repositoryId, ref }]` — required GitHub Actions workflows
- `bypassActors: [...]` — entries: `{ team }`, `{ username }`, or `{ type: "OrganizationAdmin" }`, each with optional `mode: "always"|"pull_request"`

#### Required reviewers (beta)

`requirePR.requiredReviewers` lets you require specific teams to approve PRs that touch certain file paths. Each entry has:

- `team` — name of an org team that must approve
- `filePatterns` — array of fnmatch patterns; the team is required when a PR changes any matching file
- `minApprovals` — minimum approvals from that team (default `1`; `0` adds the team as a reviewer without requiring approval)

Example: infra team must approve any change to Terraform files or `infra/`, with two approvals; security team must approve any change under `auth/`:

```json
{
  "name": "main-protection",
  "include": ["~DEFAULT_BRANCH"],
  "preventForcePush": true,
  "requirePR": {
    "approvals": 1,
    "requiredReviewers": [
      { "team": "infra", "filePatterns": ["**/*.tf", "infra/**"], "minApprovals": 2 },
      { "team": "security", "filePatterns": ["auth/**"] }
    ]
  }
}
```

GitHub flags this API as beta — the parameter shape may change on their side.

```json
{
  "org": "my-org",
  "presets": {
    "default-rules": [
      {
        "name": "main",
        "preventDeletion": true,
        "preventForcePush": true,
        "requirePR": { "approvals": 1 },
        "bypassActors": [{ "type": "OrganizationAdmin" }]
      }
    ]
  },
  "repos": [
    { "name": "api", "private": true, "rulesets": "default-rules" },
    { "name": "web", "private": true, "rulesets": "default-rules" },
    { "name": "docs", "private": false, "rulesets": "default-rules" }
  ]
}
```

### Lock down a set of public modules

```json
{
  "org": "my-org",
  "presets": {
    "oss-merging": { "squashOnly": true, "deleteBranchOnMerge": true },
    "oss-protection": [
      {
        "name": "main-branch",
        "include": ["~DEFAULT_BRANCH"],
        "preventDeletion": true,
        "preventForcePush": true,
        "requirePR": { "approvals": 1, "dismissStale": true, "lastPushApproval": true }
      }
    ]
  },
  "repos": [
    {
      "name": "module-a",
      "private": false,
      "merging": "oss-merging",
      "rulesets": "oss-protection"
    },
    {
      "name": "module-b",
      "private": false,
      "merging": "oss-merging",
      "rulesets": "oss-protection"
    },
    { "name": "module-c", "private": false, "merging": "oss-merging", "rulesets": "oss-protection" }
  ]
}
```

### Manage org members

```json
{
  "org": "my-org",
  "admins": ["alice", "bob"],
  "members": ["charlie", "dave", "eve"]
}
```

`admins` and `members` are independent. If `admins` is present, only listed users will be admins. If `members` is present, only listed users will be members. Omit either to leave that role unmanaged.

Removing someone from the org also removes them from all teams. If that person is still listed in a team config, the next apply will re-add them. Make sure `admins`/`members` is the superset of everyone referenced in `teams`.

### Manage org teams

```json
{
  "org": "my-org",
  "teams": [
    {
      "name": "engineering",
      "description": "All engineers",
      "privacy": "closed",
      "members": [
        { "username": "alice", "role": "maintainer" },
        { "username": "bob", "role": "member" }
      ]
    },
    {
      "name": "backend",
      "parent": "engineering",
      "members": [
        { "username": "alice", "role": "maintainer" },
        { "username": "charlie", "role": "member" }
      ]
    },
    {
      "name": "devops",
      "parent": "engineering",
      "members": [{ "username": "dave", "role": "maintainer" }]
    }
  ],
  "repos": [{ "name": "api", "teams": [{ "name": "backend", "permission": "write" }] }]
}
```

Org teams are reconciled before repos. Parent teams should come before children in the array. Members not in the list are removed. Teams in state but not in config are deleted. Renaming a team will create the new team and delete the old one.

### Add individual collaborators to a repo

```json
{
  "org": "my-org",
  "repos": [
    {
      "name": "secret-project",
      "private": true,
      "collaborators": [
        { "username": "alice", "permission": "admin" },
        { "username": "bob", "permission": "write" }
      ]
    }
  ]
}
```

Only direct collaborators are managed. Org-level implicit access is ignored. Unlisted direct collaborators are removed.

### Minimal repo with just teams and topics

```json
{
  "org": "my-org",
  "repos": [
    {
      "name": "internal-tool",
      "private": true,
      "topics": ["internal", "tooling"],
      "teams": [
        { "name": "platform", "permission": "admin" },
        { "name": "everyone", "permission": "read" }
      ]
    }
  ]
}
```

### npm trusted publishing

```json
{
  "org": "my-org",
  "repos": [
    {
      "name": "my-module",
      "private": false,
      "npm": {
        "package": "my-module",
        "trustedPublishing": {
          "workflow": "publish.yml",
          "environment": "npm"
        }
      }
    }
  ]
}
```

Sets up npm trusted publishing so GitHub Actions can publish via OIDC without npm tokens. If the package doesn't exist on npm yet, a placeholder 0.0.0 is published first. `package` defaults to the repo name if omitted. Requires interactive npm authentication on first run.

For repos that publish multiple packages, use an array:

```json
"npm": [
  { "package": "my-module", "trustedPublishing": { "workflow": "publish.yml", "environment": "npm" } },
  { "package": "my-module-cli", "trustedPublishing": { "workflow": "publish.yml", "environment": "npm" } }
]
```

## Programmatic usage

```js
const { apply, importOrg, seed } = require('octoops')

await apply(config, {
  dry: false,
  statePath: './config.state.json',
  audit: true
})

const config = await importOrg('my-org')
const membersOnly = await importOrg('my-org', { only: ['members'] })

seed(config, { statePath: './config.state.json' })
```

A state file is written next to the config to track what was last applied. On partial failure, completed steps are saved so the next run picks up where it left off.

## Note

This was written by a silly robot so be aware of mistakes.

## License

Apache-2.0
