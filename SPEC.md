# octoops spec

A CLI tool + Node module for managing GitHub repo configuration declaratively.
You maintain a JSON file describing desired state. Running `octoops config.json`
reconciles actual state with desired state using `gh api` calls.

## JSON schema

```json
{
  "org": "my-org",
  "repos": [
    {
      "name": "my-service",
      "description": "Does the thing",
      "private": true,
      "topics": ["nodejs"],
      "teams": [
        { "name": "backend", "permission": "write" },
        { "name": "devops", "permission": "admin" }
      ],
      "branchProtection": [
        {
          "branch": "main",
          "enforceAdmins": true,
          "requiredReviews": { "approvals": 1, "dismissStale": true }
        }
      ],
      "rulesets": [
        {
          "name": "protect-workflows",
          "target": "branch",
          "enforcement": "active",
          "include": ["~ALL"],
          "filePathRestrictions": [".github/workflows/**"]
        },
        {
          "name": "main-branch",
          "include": ["~DEFAULT_BRANCH"],
          "preventDeletion": true,
          "preventForcePush": true,
          "requirePR": {
            "approvals": 1,
            "dismissStale": true,
            "lastPushApproval": true
          }
        }
      ],
      "npm": {
        "package": "my-service",
        "trustedPublishing": {
          "workflow": "release.yml",
          "environment": "production"
        }
      }
    }
  ]
}
```

## What apply does per repo (in order)

1. Create repo if it doesn't exist
2. Patch description / visibility if changed
3. Set topics
4. For each team: add/update permission if wrong, remove if not in desired list
5. Apply branch protection rules
6. Set up environments with team reviewers
7. Apply rulesets (create or update by name)
8. Set up npm trusted publishing (OIDC) if `npm` config present

## Behavior

- Idempotent — safe to run repeatedly
- Prints what it's doing, skips repos/fields with no changes
- Fails fast on `gh` errors
- Dry-run mode: `octoops --dry-run config.json` — reads current state, prints
  what would change, makes no writes

## Permissions

`read`, `write`, `admin`, `maintain`, `triage` — maps to gh API values (`pull`, `push`, etc.) internally
