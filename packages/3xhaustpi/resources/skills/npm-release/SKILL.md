---
name: npm release
description: Log in to npm and publish packages with the plain npm CLI browser flow.
---

# npm release

Use this skill for npm authentication, package review, and publishing. It is
portable and has no dependency on Aside, MCP, or a 3xhaustPi-specific runtime.

## Authenticate

1. Run `npm whoami`.
2. If npm reports that the session is unauthorized, run exactly:

   ```sh
   npm login
   ```

3. Do not add `--auth-type=web` or other authentication flags.
4. When npm asks to open the login page, press Enter once.
5. Complete the authentication in the browser.
6. Run `npm whoami` again and require it to print the intended npm account.

## Review

Before publishing:

1. Read `package.json` and show the package name and version.
2. Run the package's relevant tests and build.
3. Run `npm pack --dry-run` and inspect the files that will be included.
4. Run `npm view <package-name> version`.
   - A 404 is expected for a new package.
   - For an existing package, require the local version to be newer.
5. Show the npm account, registry, package name, and version to the user.
6. Require explicit approval before the external publish write.

## Publish

1. Run exactly:

   ```sh
   npm publish
   ```

2. Do not add authentication-mode flags.
3. If npm prints a browser URL and asks to continue, press Enter once and
   complete the browser confirmation.
4. Wait for npm to report the published package and version.
5. Verify with:

   ```sh
   npm view <package-name>@<version> version
   ```

Do not report success from a local build or tarball alone. Publication is
complete only after the registry returns the exact version.
