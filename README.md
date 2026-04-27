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
- `init: true` — initialize the repo with a README on creation (so the default branch exists). Only used at create time, ignored on existing repos
- `merging` — `{ squashOnly, deleteBranchOnMerge }`

Omitting a field leaves the current GitHub value untouched. Setting it makes octoops reconcile it.

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
