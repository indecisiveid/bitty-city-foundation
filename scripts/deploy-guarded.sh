#!/bin/bash
# Guarded production deploy for Bitty City's Firebase backend.
#
# Safe to run unattended: every gate must pass before anything reaches prod,
# and the gates are ordered cheapest-first so failures are fast.
#
#   ./scripts/deploy-guarded.sh            # deploy if backend changed
#   ./scripts/deploy-guarded.sh --check    # run all gates, deploy nothing
#   ./scripts/deploy-guarded.sh --force    # deploy even if no changes detected
#
# Auth: needs a service account (interactive `firebase login` tokens expire and
# break automation silently). Point GOOGLE_APPLICATION_CREDENTIALS at the key,
# or drop it at ~/.config/firebase/bitty-city-deployer.json.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
PROJECT="bitty-city"
STATE="$REPO/.last-deployed"
KEY_DEFAULT="$HOME/.config/firebase/bitty-city-deployer.json"
MODE="${1:-}"

step() { echo ""; echo "▸ $*"; }
fail() { echo "✗ DEPLOY BLOCKED: $*" >&2; exit 1; }

# ── Gate 0: credentials ───────────────────────────────────────────────
step "Checking deploy credentials"
if [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "$KEY_DEFAULT" ]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$KEY_DEFAULT"
fi
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] && [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "  service account: $(python3 -c "import json,os;print(json.load(open(os.environ['GOOGLE_APPLICATION_CREDENTIALS']))['client_email'])" 2>/dev/null || echo '?')"
else
  fail "no service account key found.
     Automation cannot use interactive \`firebase login\` — those tokens expire
     and fail silently. Create a key (Firebase Console → Project Settings →
     Service Accounts → Generate new private key) and save it to:
       $KEY_DEFAULT"
fi

# ── Gate 1: clean tree on main ────────────────────────────────────────
step "Checking git state"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ -n "$(git status --porcelain)" ] && fail "working tree is dirty — commit or stash first"
[ "$BRANCH" = "main" ] || fail "on branch '$BRANCH' — production deploys come from main only"
SHA=$(git rev-parse HEAD)
echo "  main @ ${SHA:0:8}, clean"

# ── Gate 2: did the backend actually change? ──────────────────────────
step "Detecting backend changes"
LAST=$(cat "$STATE" 2>/dev/null | head -1 || echo "")
if [ "$MODE" != "--force" ] && [ -n "$LAST" ]; then
  if git diff --quiet "$LAST" HEAD -- functions/src firestore.rules firestore.indexes.json firebase.json storage.rules 2>/dev/null; then
    echo "  no backend changes since ${LAST:0:8} — nothing to deploy"
    exit 0
  fi
  echo "  changed since ${LAST:0:8}:"
  git diff --name-only "$LAST" HEAD -- functions/src firestore.rules firestore.indexes.json firebase.json storage.rules | sed 's/^/    /'
else
  echo "  ${MODE:-first run} — deploying full backend"
fi

# ── Gate 3: build + unit tests ────────────────────────────────────────
step "Building + testing"
npm --prefix functions run build >/dev/null 2>&1 || fail "tsc build failed — run: npm --prefix functions run build"
echo "  build: ok"
TEST_OUT=$(npm --prefix functions test 2>&1) || { echo "$TEST_OUT" | tail -20; fail "unit tests failed"; }
echo "  tests: $(echo "$TEST_OUT" | grep -oE 'Tests:.*[0-9]+ passed' | grep -oE '[0-9]+ passed' | head -1 || echo 'passed')"

# ── Gate 4: live-app contract (the one that protects real users) ──────
step "Checking backward compatibility with shipped apps"
python3 - <<'PY' || fail "a callable the live app depends on would disappear"
import json, re, sys
contract = json.load(open("scripts/live-app-contract.json"))
src = open("functions/src/index.ts").read()
exported = set(re.findall(r"[\w]+", " ".join(re.findall(r"export\s*\{([^}]*)\}", src))))
missing = [c for c in contract["required_callables"] if c not in exported]
if missing:
    print("  MISSING from index.ts: " + ", ".join(missing))
    print("  Apps >= %s in users' hands call these. Old binaries never update." % contract["minimum_supported_app_version"])
    print("  If dropping support is intentional, edit scripts/live-app-contract.json first.")
    sys.exit(1)
print("  all %d required callables present" % len(contract["required_callables"]))
PY

# ── Gate 5: emulator smoke (real end-to-end behaviour) ────────────────
step "Emulator smoke test"
if [ -f scripts/emulator-smoke.mjs ]; then
  # `timeout` is GNU coreutils — absent on stock macOS, present on CI runners.
  if command -v timeout >/dev/null 2>&1;  then TIMEOUT="timeout 600"
  elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT="gtimeout 600"
  else TIMEOUT=""; fi
  if PATH="/opt/homebrew/opt/openjdk/bin:$PATH" $TIMEOUT node scripts/emulator-smoke.mjs >/tmp/bc-smoke.log 2>&1; then
    echo "  smoke: $(grep -oE '[0-9]+ (checks?|passed)' /tmp/bc-smoke.log | tail -1 || echo 'passed')"
  else
    tail -15 /tmp/bc-smoke.log
    fail "emulator smoke failed (full log: /tmp/bc-smoke.log)"
  fi
else
  echo "  skipped (no smoke script)"
fi

if [ "$MODE" = "--check" ]; then
  echo ""; echo "✓ All gates passed. (--check: nothing deployed)"; exit 0
fi

# ── Deploy ────────────────────────────────────────────────────────────
# Infrastructure is declarative: anything configured in firebase.json ships.
TARGETS="functions,firestore:rules,firestore:indexes"
grep -q '"storage"' firebase.json && TARGETS="$TARGETS,storage"

step "Deploying to $PROJECT ($TARGETS)"
if ! npx firebase deploy --only "$TARGETS" --project "$PROJECT" --non-interactive --force < /dev/null; then
  fail "firebase deploy failed — prod may be partially updated; check the output above"
fi

# ── Post-deploy health check ──────────────────────────────────────────
step "Verifying deploy"
if npx firebase functions:list --project "$PROJECT" --non-interactive < /dev/null 2>/dev/null | grep -q "getGroup"; then
  echo "  functions live: core callables present"
else
  echo "  ⚠️  could not confirm functions list — check the Firebase console"
fi

{ echo "$SHA"; echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "targets=$TARGETS"; } > "$STATE"
echo ""
echo "✓ Deployed ${SHA:0:8} to $PROJECT"
echo "  main and production are now in sync (recorded in .last-deployed)"
