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
      "homepage": "https://my-service.io",
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
        "trustedPublishing": [
          { "workflow": "release.yml", "environment": "production" },
          { "workflow": "nightly.yml", "environment": "production" }
        ]
      }
    }
  ]
}
```

## What apply does per repo (in order)

1. If `renamedFrom` is set and state has no entry for the new name, rename that repo on GitHub and move the state entry (errors if the new name is already taken)
2. Create repo if it doesn't exist
3. Patch description / visibility if changed
4. Set topics
5. For each team: add/update permission if wrong, remove if not in desired list
6. Apply branch protection rules
7. Set up environments with team reviewers
8. Apply rulesets (create or update by name)
9. Set up npm trusted publishing (OIDC) if `npm` config present

## Behavior

- Idempotent — safe to run repeatedly
- Prints what it's doing, skips repos/fields with no changes
- Fails fast on `gh` errors
- Dry-run mode: `octoops --dry-run config.json` — reads current state, prints
  what would change, makes no writes

## npm trusted publishing

`trustedPublishing` takes a list of publishers. A bare object is shorthand for a one-element
list, so existing configs keep working unchanged.

- Publishers reconcile as a set keyed on `(repository, workflow, environment)` — declared and
  missing gets added, present and undeclared gets revoked, matches are left alone. A missing
  `environment` counts as none on both sides. Duplicates are collapsed.
- Only GitHub publishers bound to this repo are reconciled; other repos and other providers are
  left alone
- An empty list is a config error. Remove the key to skip trusted publishing instead.
- Adds run before revokes, so an interrupted apply leaves a package with too many publishers
  rather than none
- Requires npm 11.15.0 or newer. Earlier versions have no `--allow-publish` flag on
  `npm trust github` and every add fails
- `--dry-run` prints each declared publisher without reading the registry, so it shows what is
  declared rather than what would change

## Permissions

`read`, `write`, `admin`, `maintain`, `triage` — maps to gh API values (`pull`, `push`, etc.) internally
