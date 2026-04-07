# octoops

Declarative GitHub repo configuration using the `gh` CLI.

Maintain a JSON config describing desired state for your org's repos. Running `octoops` reconciles actual state with desired state using `gh api` calls. Idempotent and safe to run repeatedly.

```
npm install -g octoops
```

## Usage

```bash
octoops config.json
octoops --dry-run config.json
octoops --audit config.json
```

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

Fields that accept a string will resolve against `presets`.

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

### Manage org teams and members

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

Org teams are reconciled before repos. Parent teams should come before children in the array. Members not in the list are removed.

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

## Programmatic usage

```js
const { apply } = require('octoops')

await apply(config, {
  dry: false,
  statePath: './config.state.json',
  audit: true
})
```

A state file is written next to the config to track what was last applied. On partial failure, completed steps are saved so the next run picks up where it left off.

## Note

This was written by a silly robot so be aware of mistakes.

## License

Apache-2.0
