#!/usr/bin/env bash
# Fails when tracked files contain something that looks like a credential. Prints file:line and the
# rule name only, never the matched text, so CI logs cannot become a second leak.
# Usage: scripts/secret-scan.sh            (scans files tracked by git)
set -u
cd "$(git rev-parse --show-toplevel)"

declare -A RULES=(
  [private-key-block]='-----BEGIN [A-Z ]*PRIVATE KEY-----'
  [aws-access-key-id]='AKIA[0-9A-Z]{16}'
  [google-api-key]='AIza[0-9A-Za-z_-]{35}'
  [github-token]='gh[pousr]_[A-Za-z0-9]{30,}'
  [slack-token]='xox[abprs]-[A-Za-z0-9-]{10,}'
  [stripe-live-key]='sk_live_[0-9A-Za-z]{16,}'
  [meta-access-token]='EAA[A-Za-z0-9]{40,}'
  [mongodb-uri-with-password]='mongodb(\+srv)?://[^:/[:space:]"'\'']+:[^@[:space:]"'\'']{3,}@'
  [hardcoded-credential]='(secret|passw(or)?d|api[_-]?key|access[_-]?token|auth[_-]?token)[A-Za-z_]*[[:space:]]*[:=][[:space:]]*["'\''][A-Za-z0-9_+/=.-]{20,}["'\'']'
)

# Lockfiles, fixtures, examples and tests legitimately contain look-alike strings
EXCLUDE='(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(^|/)\.env\.example$|(^|/)tests?/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|(^|/)qa-reports/|(^|/)security-reports/|(^|/)scripts/secret-scan\.sh$'

status=0
while IFS= read -r file; do
  [[ "$file" =~ $EXCLUDE ]] && continue
  [ -f "$file" ] || continue
  for rule in "${!RULES[@]}"; do
    while IFS=: read -r line _; do
      [ -n "$line" ] && { echo "SECRET-SCAN: $file:$line  rule=$rule"; status=1; }
    done < <(grep -nIE "${RULES[$rule]}" "$file" 2>/dev/null | cut -d: -f1 | sed 's/$/:/')
  done
done < <(git ls-files)

# An .env (not .env.example) must never be tracked
if git ls-files | grep -E '(^|/)\.env(\.[a-z]+)?$' | grep -v '\.example$' | grep -q .; then
  echo "SECRET-SCAN: a real .env file is tracked by git"; status=1
fi

[ $status -eq 0 ] && echo "secret-scan: no findings"
exit $status
